/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

const RUNNER_VERSION = '1.6.8';

import fs from 'fs';
import path from 'path';
import {
  query,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { createPreCompactHook } from './archive.ts';
import {
  MessageStream,
  IPC_INPUT_DIR,
  IPC_INPUT_CLOSE_SENTINEL,
  IPC_POLL_MS,
  shouldClose,
  drainIpcInput,
  waitForIpcMessage,
} from './ipc.ts';
import {
  truncateMiddle,
  extractUserMessages,
  formatMessage,
  formatValue,
} from './format.ts';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  nanoclawVersion?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(message);
}

function writeSummary(text: string, archivePath: string): void {
  let content = text.split('\n').slice(1).join('\n');
  const marker = 'If you need specific details from before compaction';
  const idx = content.indexOf(marker);
  if (idx !== -1) {
    content =
      content.slice(0, idx) +
      marker +
      ` the full conversation is at ${archivePath}`;
  }
  const summaryPath = archivePath.replace(/\.md$/, '.summary.md');
  fs.writeFileSync(summaryPath, content);
  log(`Archived summary to ${summaryPath}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const TOOL_EMOJI: Record<string, string> = {
  Bash: '⚡',
  Read: '👁',
  Write: '✍️',
  Edit: '✏️',
  Glob: '📂',
  Grep: '🔎',
  WebSearch: '🔍',
  WebFetch: '🌐',
  mcp__nanoclaw__schedule_task: '\\[⏰📅\\]',
  mcp__nanoclaw__list_tasks: '\\[⏰📋\\]',
  mcp__nanoclaw__pause_task: '\\[⏰⏸\\]',
  mcp__nanoclaw__resume_task: '\\[⏰▶\\]',
  mcp__nanoclaw__cancel_task: '\\[⏰❌\\]',
  mcp__nanoclaw__update_task: '\\[⏰✏️\\]',
  'mcp__agent-control__stop_container': '🛑',
  'mcp__agent-control__reset_session': '🔄',
  Skill: '🧩',
};

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  controlServer: ReturnType<typeof createSdkMcpServer>,
  resumeAt?: string,
  registerStreamEnder?: (fn: () => void) => void,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  const stream = new MessageStream();
  registerStreamEnder?.(() => stream.end());
  const logUser = (text: string) => {
    messageCount++;
    log(
      `\n#${messageCount} user: ${truncateMiddle(extractUserMessages(text) || text)}`,
    );
  };

  logUser(prompt);
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      logUser(text);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Output buffering: we want to append a ✓ to the final assistant message so
  // the user knows the agent is done. But the SDK doesn't mark assistant messages
  // as final — we only know when the result message arrives afterward. So we
  // buffer each assistant text output and only flush it when:
  //   - The next assistant message arrives (flush without ✓, buffer the new one)
  //   - A result message arrives (flush with ✓ appended)
  //   - 500ms passes with no new message (flush without ✓ to avoid delay)
  // We don't flush on rate_limit_event since it's informational and always sits
  // between the assistant and result, which would cause the ✓ to be emitted as
  // a separate message. We also skip the ✓ entirely when there was no visible
  // output (e.g. scheduled tasks that only produce <internal> tags), to avoid
  // sending a lone ✓ as a message to the user.
  const toolsUsed = new Set<string>();
  let pendingOutput: ContainerOutput | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let hadVisibleOutput = false;
  let lastArchivePath: string | null = null;
  let awaitingSummary = false;
  const flushPending = (append?: string) => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (!pendingOutput && !append) return;
    const out = pendingOutput || {
      status: 'success' as const,
      result: '',
      newSessionId,
    };
    if (append) out.result = (out.result || '') + append;
    writeOutput(out);
    pendingOutput = null;
  };
  const bufferOutput = (out: ContainerOutput) => {
    pendingOutput = out;
    pendingTimer = setTimeout(() => flushPending(), 500);
  };

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append:
          `Your NanoClaw version IS: ${containerInput.nanoclawVersion || '?'}. Your Agent Runner version IS: ${RUNNER_VERSION}.` +
          (globalClaudeMd ? `\n\n${globalClaudeMd}` : ''),
      },
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__agent-control__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          type: 'http' as const,
          url: process.env.NANOCLAW_IPC_URL!,
          headers: {
            Authorization: `Bearer ${process.env.NANOCLAW_IPC_TOKEN}`,
          },
        },
        'agent-control': controlServer,
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              createPreCompactHook((p) => {
                lastArchivePath = p;
              }),
            ],
          },
        ],
      },
    },
  })) {
    messageCount++;
    const { label, text } = formatMessage(message);
    const suffix = message.type === 'result' ? '\n' : '';
    log(`#${messageCount} ${label}:${text ? ' ' + text : ''}${suffix}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    // Stream assistant text so intermediate messages (before tool calls) aren't lost.
    // Buffer the output so we can append a symbol if it turns out to be the final message.
    if (message.type === 'assistant' && 'message' in message) {
      flushPending();
      const msg = (message as any).message;
      if (Array.isArray(msg?.content)) {
        for (const c of msg.content) {
          if (c.type === 'tool_use' && c.name) toolsUsed.add(c.name);
        }
        const text = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
          .trim();
        const visible = text
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        if (text) {
          if (visible) hadVisibleOutput = true;
          const emojis = visible
            ? [...toolsUsed].map((t) => TOOL_EMOJI[t] || '🔧').join('')
            : '';
          toolsUsed.clear();
          const output = emojis ? `${text} ${emojis}` : text;
          bufferOutput({ status: 'success', result: output, newSessionId });
        }
      }
    } else if (message.type === 'result') {
      const emojis = [...toolsUsed].map((t) => TOOL_EMOJI[t] || '🔧').join('');
      toolsUsed.clear();
      if (hadVisibleOutput) {
        flushPending(emojis ? ` ${emojis}✓` : ' ✓');
      } else {
        flushPending();
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
    }

    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      awaitingSummary = true;
    }

    if (
      awaitingSummary &&
      message.type === 'user' &&
      (message as any).message?.content
    ) {
      const text = formatValue((message as any).message.content, Infinity);
      if (text && lastArchivePath) {
        try {
          writeSummary(text, lastArchivePath);
        } catch (err) {
          log(
            `Failed to archive summary: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      awaitingSummary = false;
    }

    if (message.type === 'result') {
      resultCount++;
      writeOutput({
        status: 'success',
        result: null,
        newSessionId,
      });
    }
  }

  flushPending();
  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

function createControlServer(
  onReset: () => void,
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'agent-control',
    tools: [
      tool(
        'reset_session',
        'Start a fresh conversation session. The next message will begin a new session with no prior history.',
        {},
        async () => {
          onReset();
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Session will reset after this turn.',
              },
            ],
          };
        },
      ),
      tool(
        'stop_container',
        'Shut down this container gracefully. Use when the user wants to reload or restart.',
        {},
        async () => {
          fs.writeFileSync(IPC_INPUT_CLOSE_SENTINEL, '');
          return {
            content: [
              { type: 'text' as const, text: 'Container shutting down.' },
            ],
          };
        },
      ),
    ],
  });
}

async function handleSlashCommand(
  prompt: string,
  sessionId: string | undefined,
  sdkEnv: Record<string, string | undefined>,
): Promise<void> {
  log(`Handling session command: ${prompt}`);
  let slashSessionId: string | undefined;
  let lastArchivePath: string | null = null;
  let awaitingSummary = false;
  let compactBoundarySeen = false;
  let hadError = false;
  let resultEmitted = false;

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: '/workspace/group',
        resume: sessionId,
        systemPrompt: undefined,
        allowedTools: [],
        env: sdkEnv,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'] as const,
        hooks: {
          PreCompact: [
            {
              hooks: [
                createPreCompactHook((p) => {
                  lastArchivePath = p;
                }),
              ],
            },
          ],
        },
      },
    })) {
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[slash-cmd] type=${msgType}`);

      if (message.type === 'system' && message.subtype === 'init') {
        slashSessionId = message.session_id;
        log(`Session after slash command: ${slashSessionId}`);
      }

      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'compact_boundary'
      ) {
        compactBoundarySeen = true;
        awaitingSummary = true;
        log('Compact boundary observed — compaction completed');
      }

      if (
        awaitingSummary &&
        message.type === 'user' &&
        (message as any).message?.content
      ) {
        const text = formatValue((message as any).message.content, Infinity);
        if (text && lastArchivePath) {
          try {
            writeSummary(text, lastArchivePath);
          } catch (err) {
            log(
              `Failed to archive summary: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        awaitingSummary = false;
      }

      if (message.type === 'result') {
        const resultSubtype = (message as { subtype?: string }).subtype;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;

        if (resultSubtype?.startsWith('error')) {
          hadError = true;
          writeOutput({
            status: 'error',
            result: null,
            error: textResult || 'Session command failed.',
            newSessionId: slashSessionId,
          });
        } else {
          writeOutput({
            status: 'success',
            result: textResult || 'Conversation compacted.',
            newSessionId: slashSessionId,
          });
        }
        resultEmitted = true;
      }
    }
  } catch (err) {
    hadError = true;
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Slash command error: ${errorMsg}`);
    writeOutput({ status: 'error', result: null, error: errorMsg });
  }

  log(
    `Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`,
  );

  if (!hadError && !compactBoundarySeen) {
    log(
      'WARNING: compact_boundary was not observed. Compaction may not have completed.',
    );
  }

  if (!resultEmitted && !hadError) {
    writeOutput({
      status: 'success',
      result: compactBoundarySeen
        ? 'Conversation compacted.'
        : 'Compaction requested but compact_boundary was not observed.',
      newSessionId: slashSessionId,
    });
  } else if (!hadError) {
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: slashSessionId,
    });
  }
}

async function main(): Promise<void> {
  // Copy default dotfiles into /home/node if missing (host mount may be empty)
  for (const f of ['.bashrc', '.profile', '.bash_logout']) {
    const target = path.join('/home/node', f);
    const source = path.join('/etc/skel', f);
    if (!fs.existsSync(target) && fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    }
  }

  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  let sessionId = containerInput.sessionId;
  let resetRequested = false;
  let endCurrentStream: (() => void) | null = null;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  const controlServer = createControlServer(() => {
    resetRequested = true;
    endCurrentStream?.();
  });

  // Clean up stale close sentinel from previous container run
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK at ${new Date().toString()} - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  if (KNOWN_SESSION_COMMANDS.has(trimmedPrompt)) {
    await handleSlashCommand(trimmedPrompt, sessionId, sdkEnv);
    return;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        containerInput,
        sdkEnv,
        controlServer,
        resumeAt,
        (fn) => {
          endCurrentStream = fn;
        },
      );
      endCurrentStream = null;

      if (resetRequested) {
        log('Session reset requested, compacting then clearing session');
        const compactSessionId = queryResult.newSessionId || sessionId;
        if (compactSessionId)
          await handleSlashCommand('/compact', compactSessionId, sdkEnv);
        sessionId = undefined;
        resumeAt = undefined;
        resetRequested = false;
      } else {
        if (queryResult.newSessionId) {
          sessionId = queryResult.newSessionId;
        }
        if (queryResult.lastAssistantUuid) {
          resumeAt = queryResult.lastAssistantUuid;
        }
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it ('' signals host to clear session on reset)
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId ?? '',
      });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
