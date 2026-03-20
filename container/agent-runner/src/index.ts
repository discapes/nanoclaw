/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Sentinels: _close (exit), _compact (compact session), _switch (change session)
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

const RUNNER_VERSION = '2.0.0';

import fs from 'fs';
import path from 'path';
import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createPreCompactHook } from './archive.ts';
import {
  type StopReason,
  MessageStream,
  IPC_INPUT_DIR,
  IPC_INPUT_CLOSE_SENTINEL,
  IPC_POLL_MS,
  checkSentinels,
  drainIpcInput,
  waitForIpc,
} from './ipc.ts';
import {
  truncateMiddle,
  extractUserMessages,
  extractText,
  formatMessage,
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
  Skill: '🧩',
};

// --- Conversation query ---

interface QueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  stopReason: StopReason | null; // null = SDK ended the query on its own
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  controlServer: ReturnType<typeof createSdkMcpServer>,
  resumeAt?: string,
): Promise<QueryResult> {
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  const stream = new MessageStream();
  const logUser = (text: string) => {
    messageCount++;
    log(
      `\n#${messageCount} user: ${truncateMiddle(extractUserMessages(text) || text)}`,
    );
  };

  logUser(prompt);
  stream.push(prompt);

  // IPC poller: drain messages into stream, check sentinels
  let ipcPolling = true;
  let stopReason: StopReason | null = null;
  const pollIpc = () => {
    if (!ipcPolling) return;
    // Drain messages first — they're queued in the stream before any end()
    const messages = drainIpcInput();
    for (const text of messages) {
      logUser(text);
      stream.push(text);
    }
    const sentinel = checkSentinels();
    if (sentinel) {
      log(`IPC sentinel: ${sentinel.type}`);
      stopReason = sentinel;
      stream.end();
      ipcPolling = false;
      return;
    }
    setTimeout(pollIpc, IPC_POLL_MS);
  };
  setTimeout(pollIpc, IPC_POLL_MS);

  // Load global CLAUDE.md
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover extra directories
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) extraDirs.push(fullPath);
    }
  }

  // Output buffering for ✓ marker
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
      const text = extractText((message as any).message.content);
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
      writeOutput({ status: 'success', result: null, newSessionId });
    }
  }

  flushPending();
  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, stopReason: ${stopReason?.type || 'sdk_ended'}`,
  );
  return { newSessionId, lastAssistantUuid, stopReason };
}

// --- Compact (SDK slash command) ---

async function runCompact(
  sessionId: string | undefined,
  sdkEnv: Record<string, string | undefined>,
): Promise<string | undefined> {
  log(`Compacting session: ${sessionId || 'none'}`);
  if (!sessionId) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'No session to compact.',
    });
    return undefined;
  }

  let resultSessionId: string | undefined;
  let lastArchivePath: string | null = null;
  let awaitingSummary = false;
  let compactBoundarySeen = false;
  let hadError = false;

  try {
    for await (const message of query({
      prompt: '/compact',
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
      log(`[compact] type=${msgType}`);

      if (message.type === 'system' && message.subtype === 'init') {
        resultSessionId = message.session_id;
      }

      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'compact_boundary'
      ) {
        compactBoundarySeen = true;
        awaitingSummary = true;
      }

      if (
        awaitingSummary &&
        message.type === 'user' &&
        (message as any).message?.content
      ) {
        const text = extractText((message as any).message.content);
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
        const subtype = (message as { subtype?: string }).subtype;
        if (subtype?.startsWith('error')) hadError = true;
      }
    }
  } catch (err) {
    hadError = true;
    log(`Compact error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!compactBoundarySeen) {
    log('WARNING: compact_boundary was not observed');
  }

  writeOutput({
    status: hadError ? 'error' : 'success',
    result: hadError ? 'Compaction failed.' : 'Conversation compacted.',
    newSessionId: resultSessionId,
    error: hadError ? 'Compaction failed' : undefined,
  });

  return resultSessionId || sessionId;
}

// --- Main ---

async function main(): Promise<void> {
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

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  const controlServer = createSdkMcpServer({
    name: 'agent-control',
    tools: [],
  });

  // Clean up stale sentinels from previous container run
  for (const sentinel of ['_close', '_compact', '_switch']) {
    try {
      fs.unlinkSync(path.join(IPC_INPUT_DIR, sentinel));
    } catch {
      /* ignore */
    }
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK at ${new Date().toString()} - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  let resumeAt: string | undefined;

  try {
    // Main loop: run conversation query, then handle whatever stopped it.
    // A single query() call handles an entire multi-turn conversation via
    // MessageStream. The loop only iterates when the conversation must be
    // interrupted (compact, session switch) or restarted (SDK ended early).
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const result = await runQuery(
        prompt,
        sessionId,
        containerInput,
        sdkEnv,
        controlServer,
        resumeAt,
      );

      if (result.newSessionId) sessionId = result.newSessionId;
      if (result.lastAssistantUuid) resumeAt = result.lastAssistantUuid;

      // If the SDK ended on its own (no sentinel), emit a session update.
      // Then enter the wait loop which handles both messages and sentinels.
      if (!result.stopReason) {
        writeOutput({
          status: 'success',
          result: null,
          newSessionId: sessionId ?? '',
        });
        log('Query ended (SDK), waiting for next IPC...');
      }

      // Wait loop: handle sentinels, then wait for a user message to start
      // the next query. Multiple sentinels can arrive before a message.
      let reason = result.stopReason;
      while (true) {
        if (reason?.type === 'closed') return;

        if (reason?.type === 'compact') {
          sessionId = await runCompact(sessionId, sdkEnv);
          resumeAt = undefined;
        } else if (reason?.type === 'switch') {
          sessionId = reason.sessionId;
          resumeAt = undefined;
          writeOutput({
            status: 'success',
            result: null,
            newSessionId: sessionId ?? '',
          });
        }

        const next = await waitForIpc();
        if (typeof next === 'string') {
          prompt = next;
          break;
        }
        // Another sentinel arrived before a message — handle it too
        reason = next;
      }
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
