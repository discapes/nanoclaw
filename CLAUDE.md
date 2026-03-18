# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/index.ts`                      | Orchestrator: state, message loop, agent invocation        |
| `src/channels/registry.ts`          | Channel registry (self-registration at startup)            |
| `src/ipc.ts`                        | IPC watcher and task processing                            |
| `src/router.ts`                     | Message formatting and outbound routing                    |
| `src/config.ts`                     | Trigger pattern, paths, intervals                          |
| `src/container-runner.ts`           | Spawns agent containers with mounts                        |
| `src/task-scheduler.ts`             | Runs scheduled tasks                                       |
| `src/db.ts`                         | SQLite operations                                          |
| `groups/{name}/CLAUDE.md`           | Per-group memory (isolated)                                |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

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

The agent runner (`container/agent-runner/src/`) runs inside each container. It calls the Claude Agent SDK's `query()` with a `MessageStream` (async iterable) as the prompt. The SDK keeps the query open for the container's entire lifetime — all follow-up messages are piped via `stream.push()`, not as separate `query()` calls. The query only ends when `stream.end()` is called (via `_close` or `_reset` sentinel). The outer `while(true)` loop in `main()` is a fallback for when the SDK ends the query unexpectedly.

The agent-runner source is mounted read-only from `container/agent-runner/src/` into all containers. Changes apply to all groups on next container restart.

## Telegram Markdown

Messages are sent with `parse_mode: 'Markdown'`. Square brackets `[...]` are silently interpreted as link syntax and stripped (no parse error, so the plain-text fallback doesn't trigger). Escape with `\[...\]`.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; })`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
