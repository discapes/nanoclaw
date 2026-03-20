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

The agent runner (`container/agent-runner/src/`) runs inside each container. A single `query()` call handles an entire multi-turn conversation via `MessageStream` — follow-up messages are piped via `stream.push()`, and the SDK stays open as long as the stream yields. The stream only ends when an IPC sentinel is detected (`_close`, `_compact`, `_switch`), at which point the main loop handles the operation (compact, session switch, or exit) and starts a new `query()` for the next conversation.

**IPC sentinels** (written by the host to `/workspace/ipc/input/`):
- `_close` — exit the container
- `_compact` — compact the current session (container runs SDK's `/compact` internally)
- `_switch` — switch sessions (file content = target session ID, empty = new session)

This means `/compact` and `/sesh` do NOT restart the container — they interrupt the current query, perform the operation, and resume with a new query in the same container.

The agent-runner source is mounted read-only from `container/agent-runner/src/` into all containers. Changes apply to all groups on next container restart.

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
| `/compact` | Compact conversation history into a summary. Session continues with summary as context. Handled inside the running container via `_compact` sentinel. |
| `/stop` | Stop the active container. Session is preserved unchanged. |
| `/sesh` | List all sessions for this group with IDs, names, and an arrow marking the active one. |
| `/sesh new` | Start a fresh session. Closes the active container and clears the session. The old session remains in history. |
| `/sesh <id-or-name>` | Switch to an existing session by exact session ID or name. Closes the active container. |
| `/seshname` | Show the current session's ID and name. |
| `/seshname <name>` | Name the current session. Rejects duplicate names within the group. |

**Implementation:** `extractSessionCommand` in `src/session-commands.ts` parses commands. `handleSessionCommand` handles auth and execution. All commands are host-only — `/compact` and `/sesh` (with args) write IPC sentinels to the running container rather than spawning new ones.

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
