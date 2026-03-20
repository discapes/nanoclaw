# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/index.ts`                      | Orchestrator: state, message loop, agent invocation        |
| `src/channels/registry.ts`          | Channel registry (self-registration at startup)            |
| `src/ipc-server.ts`                 | MCP-over-HTTP server for container→host communication      |
| `src/session-commands.ts`           | Session slash command parsing, auth, and execution          |
| `src/router.ts`                     | Message formatting and outbound routing                    |
| `src/config.ts`                     | Trigger pattern, paths, intervals                          |
| `src/container-runner.ts`           | Spawns agent containers with mounts                        |
| `src/task-scheduler.ts`             | Runs scheduled tasks                                       |
| `src/db.ts`                         | SQLite operations                                          |
| `groups/{name}/CLAUDE.md`           | Per-group memory (isolated)                                |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |
| `container/agent-runner/docs/sdk-message-types.md` | Claude Agent SDK message type reference             |

## Skills

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration    |
| `/customize`        | Adding channels, integrations, changing behavior                  |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install         |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

## TypeScript Conventions

- No build step — TypeScript runs directly via `node --strip-types`.
- Local imports use `.ts` extensions (e.g. `from './config.ts'`), not `.js`.
- Type-only imports must use the `type` keyword (`import type { Foo }` or `import { type Foo, bar }`). Enforced by `verbatimModuleSyntax` in tsconfig.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm start            # Run directly (node --strip-types)
npm run dev          # Run with hot reload (tsx)
npm run typecheck    # Check types without compiling
./container/build.sh # Rebuild agent container
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Versioning

Two independent versions are shown to agents in their system prompt:

- **NanoClaw version** (`NANOCLAW_VERSION` in `src/config.ts`, read from `package.json`) — bump when changing host code (`src/`).
- **Agent runner version** (`RUNNER_VERSION` in `container/agent-runner/src/index.ts`) — bump when changing agent runner code.

ALWAYS When you make changes, REMEMBER TO BUMP the appropriate version.

## Agent Runner

The agent runner (`container/agent-runner/src/`) runs inside each container. Source is mounted read-only from `container/agent-runner/src/` — changes apply to all groups on next container restart.

### Two loops, two ways to deliver messages

The agent runner has two nested loops and two ways messages reach the SDK:

**Outer loop** (`main()` → `while(true)` in `container/agent-runner/src/index.ts`):
```
main() → runQuery(prompt) → [query ends] → waitForIpcMessage() → runQuery(nextMessage) → ...
```
Each iteration calls `runQuery()` then blocks on `waitForIpcMessage()`. This loop exists as a **fallback** for when the SDK ends its `query()` call (emits a `result` message). In practice, during normal conversation, the SDK almost never ends the query on its own because the prompt is a `MessageStream` (async iterable) that stays open. The outer loop mainly matters for edge cases where the SDK ends the query unexpectedly.

**Inner loop** (`runQuery()` → `for await...of query()`):
```
runQuery() → query({ prompt: stream }) → [SDK processes stream, emits messages] → ...
```
This is where the actual conversation happens. The SDK's `query()` takes a `MessageStream` as the prompt. As long as the stream stays open, the SDK keeps the query alive — it processes a user message, responds, then waits for the next `stream.push()`.

**How follow-up messages arrive during a query:**
`pollIpcDuringQuery()` runs on a 500ms timer inside `runQuery()`. It checks the IPC input directory for new message files (written by the host via `queue.sendMessage()`). Each message found is pushed onto the stream via `stream.push()`, which the SDK picks up as the next user turn — all within the same `query()` call.

**What this means:** A typical multi-turn conversation is a single `query()` call with many `stream.push()` calls. The log pattern `#N user: ... → #N+1 assistant: ... → #N+2 result: ... → #N+3 user: ...` all happens inside one `for await...of query()` loop. The `result` message between user turns is the SDK signaling it finished its turn, but because the stream is still open, the SDK immediately waits for the next message rather than ending the query.

### When does `query()` end?

The `for await...of query()` loop exits when:

1. **`stream.end()` is called** — The `MessageStream` signals no more messages. This happens when `pollIpcDuringQuery` detects the `_close` sentinel file (written by the host's `closeStdin()`). Sets `closedDuringQuery = true`.
2. **The SDK decides to end** — Rare in practice since the stream stays open. If it happens, the outer loop catches it: `runQuery()` returns, the outer loop emits a session-update marker, then `waitForIpcMessage()` blocks until the next message or `_close`.

### When does the container exit?

The outer loop breaks when:
- `closedDuringQuery` is true (close sentinel consumed during query) — immediate exit
- `waitForIpcMessage()` returns null (close sentinel found between queries) — immediate exit

The container process then exits naturally after `main()` returns.

### Host-side message delivery

The host (`src/index.ts` message loop) delivers messages in two ways:

1. **IPC pipe** (`queue.sendMessage()`) — If a container is already active for the group, the formatted message is written as a JSON file to the IPC directory. The container's poller picks it up and pushes it onto the stream. Fast, no container restart.
2. **New container** (`queue.enqueueMessageCheck()`) — If no container is active, a new one is spawned via `processGroupMessages` → `runAgent()`. The message is passed as the initial prompt via stdin.

### Implications for slash commands

Since the entire conversation lives inside one `query()` call, **ending the query is not the same as stopping the container**. Writing `_close` does both: it ends the stream (which ends the query) and causes the outer loop to exit. There is currently no mechanism to end just the current query without also stopping the container.

For `/compact`: requires a fresh `query()` with a string prompt (not a `MessageStream`) so the SDK recognizes it as a slash command. This means the active container must be stopped, and a new one spawned with `/compact` as the prompt. The compact container exits after the command completes.

For `/sesh new` and `/sesh <id>`: the active container must be stopped because it's running on the old session. The next message spawns a new container with the correct session ID.

For `/sesh` (list) and `/seshname`: these are purely host-side lookups that don't touch the container at all.

## Sessions

Each group has an **active session** (tracked in the `sessions` DB table) that the SDK resumes on each container start. All sessions ever created are stored in `session_history` so users can switch between them.

**How sessions work:**
- The SDK creates a session ID when a container runs its first query. The host stores it in both `sessions` (active pointer) and `session_history` (permanent record).
- Switching sessions (`/sesh`) updates the active pointer. The next container start resumes the selected session.
- Starting a new session (`/sesh new`) clears the active pointer. The next message creates a fresh session.
- Sessions can be named (`/seshname`) for easy reference. Names must be unique within a group.
- Compacting (`/compact`) preserves the same session but replaces conversation history with a summary. An archive of the full conversation is saved to disk.

**Storage:**
- `sessions` table: one row per group, points to the active session ID.
- `session_history` table: all sessions per group, with optional name and creation timestamp.
- On first run after migration, existing active sessions are seeded into `session_history`.

**Notifications:** Session changes are reported to the channel. When `/sesh new` clears the session, the old session ID is printed. When the next message creates the new session, its ID is printed too. `/sesh <target>` prints both old and new.

## Slash Commands

Slash commands are sent by users in the chat channel (e.g., Telegram). They can optionally be prefixed with the bot's trigger (e.g., `@BotName /compact`). All require admin access (main group sender or `is_from_me`).

| Command | Description |
|---------|-------------|
| `/compact` | Compact conversation history into a summary. Session continues with summary as context. Messages before the command in the same batch are processed first. |
| `/stop` | Stop the active container. Session is preserved unchanged. |
| `/sesh` | List all sessions for this group with IDs, names, and an arrow marking the active one. |
| `/sesh new` | Start a fresh session. Closes the active container and clears the session. The old session remains in history. |
| `/sesh <id-or-name>` | Switch to an existing session by exact session ID or name. Closes the active container. |
| `/seshname` | Show the current session's ID and name. |
| `/seshname <name>` | Name the current session. Rejects duplicate names within the group. |

**Implementation:** `extractSessionCommand` in `src/session-commands.ts` parses commands. `handleSessionCommand` handles auth and execution. `/stop`, `/sesh`, and `/seshname` are host-only (no container spawned). `/compact` spawns a container to run the SDK's built-in `/compact` command.

## Telegram MarkdownV2

Messages are sent with `parse_mode: 'MarkdownV2'`. The agent is instructed to produce MarkdownV2-formatted output directly. All special characters outside of code blocks must be escaped with `\`. See https://core.telegram.org/bots/api#markdownv2-style.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; })`) to install it. Existing auth credentials and groups are preserved.

## Placeholder Names

- `FallbackAssistantNameDave` — default assistant name fallback in `src/config.ts`
- `UnitTestNameBob` — assistant name used in test fixtures
- `tg_james_bot` — Telegram bot username used in test fixtures
- `Echo` — assistant name used in documentation and templates

These are deliberately non-realistic to make it obvious when a placeholder is showing instead of a real configured name.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
