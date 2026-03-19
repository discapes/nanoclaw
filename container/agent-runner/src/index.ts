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

const RUNNER_VERSION = '1.5.1';

import fs from 'fs';
import path from 'path';
import {
  query,
  createSdkMcpServer,
  tool,
  type HookCallback,
  type PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

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

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_INPUT_RESET_SENTINEL = path.join(IPC_INPUT_DIR, '_reset');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
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

function collapse(s: string): string {
  return s.trim().replace(/\s*\n\s*/g, '  ↵ ');
}

function extractUserMessages(s: string): string | null {
  const matches = [
    ...s.matchAll(/<message sender="([^"]*)"[^>]*>([\s\S]*?)<\/message>/g),
  ];
  if (matches.length === 0) return null;
  return matches
    .map((m) => (matches.length > 1 ? `${m[1]}: ${m[2]}` : m[2]))
    .join(' | ');
}

function truncateMiddle(s: string, max = 1000): string {
  s = collapse(s);
  if (s.length <= max) return s;
  const half = Math.floor((max - 5) / 2);
  return s.slice(0, half) + ' ... ' + s.slice(-half);
}

function formatValue(val: any, max = 500): string {
  if (typeof val === 'string') return truncateMiddle(val, max);
  if (Array.isArray(val)) {
    if (val.length === 1) return formatValue(val[0], max);
    return '[ ' + val.map((v) => formatValue(v, max)).join(' | ') + ' ]';
  }
  if (val?.type === 'image') return '<image>';
  if (val?.type === 'text' && val.text) return truncateMiddle(val.text, max);
  if (val?.type === 'thinking')
    return `«${truncateMiddle(val.thinking || 'redacted', max)}»`;
  if (val?.type === 'tool_use' || val?.type === 'server_tool_use')
    return `${val.name}(${formatFields(val.input || {})})`;
  if (val?.type === 'tool_result') {
    const wrapper = val.is_error ? 'Error' : 'Result';
    return `${wrapper}(${formatValue(val.content, max)})`;
  }
  return formatFields(val, max);
}

function formatFields(obj: Record<string, any>, max = 200): string {
  return Object.entries(obj)
    .map(
      ([k, v]) =>
        `${k}=${truncateMiddle(typeof v === 'string' ? v : JSON.stringify(v), max)}`,
    )
    .join(', ');
}

// See docs/sdk-message-types.md for the full schema of each message type.
function formatMessage(message: any): { label: string; text: string } {
  const type = message.type;

  if (type === 'system' && message.subtype === 'init') {
    const tools = message.tools?.length ?? 0;
    const skills = message.skills?.length ?? 0;
    const mcps = message.mcp_servers
      ?.map((s: any) => `${s.name}(${s.status})`)
      .join(', ');
    return {
      label: 'init',
      text: `Session: ${message.session_id || 'new'} | model=${message.model} | ${tools} tools, ${skills} skills | MCP: ${mcps || 'none'}`,
    };
  }

  if (type === 'system' && message.subtype === 'task_notification') {
    return {
      label: 'task',
      text: `${message.task_id}: ${message.status} — ${message.summary}`,
    };
  }

  if (type === 'system') {
    return { label: `system/${message.subtype}`, text: '' };
  }

  if (type === 'assistant' && message.message?.content) {
    return { label: 'assistant', text: formatValue(message.message.content) };
  }

  if (type === 'user' && message.message?.content) {
    return { label: 'user', text: formatValue(message.message.content) };
  }

  if (type === 'rate_limit_event') {
    const r = message.rate_limit_info || {};
    return {
      label: 'rate_limit',
      text: `${r.rateLimitType} ${r.status}${r.resetsAt ? ` | resets ${new Date(r.resetsAt * 1000).toISOString()}` : ''}`,
    };
  }

  if (type === 'result') {
    const u = message.usage || {};
    const cost = message.total_cost_usd
      ? `$${message.total_cost_usd.toFixed(4)}`
      : '';
    const dur = message.duration_api_ms
      ? `${(message.duration_api_ms / 1000).toFixed(1)}s`
      : '';
    const tokens = [
      u.input_tokens && `in:${u.input_tokens}`,
      u.output_tokens && `out:${u.output_tokens}`,
      u.cache_read_input_tokens && `cache_read:${u.cache_read_input_tokens}`,
      u.cache_creation_input_tokens &&
        `cache_write:${u.cache_creation_input_tokens}`,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      label: 'result',
      text: `${message.subtype} | ${message.num_turns} turns | ${dur} | ${cost} | ${tokens}`,
    };
  }

  return {
    label: 'unhandled',
    text: truncateMiddle(JSON.stringify(message), 500),
  };
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  controlServer: ReturnType<typeof createSdkMcpServer>,
  resumeAt?: string,
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
    if (fs.existsSync(IPC_INPUT_RESET_SENTINEL)) {
      try {
        fs.unlinkSync(IPC_INPUT_RESET_SENTINEL);
      } catch {
        /* ignore */
      }
      log('Reset sentinel detected during query, ending stream');
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

  const TOOL_EMOJI: Record<string, string> = {
    Bash: '⚡',
    Read: '👁',
    Write: '✍️',
    Edit: '✏️',
    Glob: '📂',
    Grep: '🔎',
    WebSearch: '🔍',
    WebFetch: '🌐',
    mcp__nanoclaw__schedule_task: '\\[⏰📅]',
    mcp__nanoclaw__list_tasks: '\\[⏰📋]',
    mcp__nanoclaw__pause_task: '\\[⏰⏸]',
    mcp__nanoclaw__resume_task: '\\[⏰▶]',
    mcp__nanoclaw__cancel_task: '\\[⏰❌]',
    mcp__nanoclaw__update_task: '\\[⏰✏️]',
    'mcp__agent-control__stop_container': '🛑',
    'mcp__agent-control__reset_session': '🔄',
    Skill: '🧩',
  };
  const toolsUsed = new Set<string>();
  let pendingOutput: ContainerOutput | null = null;
  const flushPending = (append?: string) => {
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
          command: 'node',
          args: ['--strip-types', mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        'agent-control': controlServer,
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
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
          const emojis = visible
            ? [...toolsUsed].map((t) => TOOL_EMOJI[t] || '🔧').join('')
            : '';
          toolsUsed.clear();
          const output = emojis ? `${text} ${emojis}` : text;
          pendingOutput = { status: 'success', result: output, newSessionId };
        }
      }
    } else {
      const isFinal = message.type === 'result';
      flushPending(isFinal ? ' ✓' : undefined);
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
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

  flushPending(' ✓');
  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
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

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.ts');

  let sessionId = containerInput.sessionId;
  let resetRequested = false;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  const controlServer = createSdkMcpServer({
    name: 'agent-control',
    tools: [
      tool(
        'reset_session',
        'Start a fresh conversation session. The next message will begin a new session with no prior history.',
        {},
        async () => {
          resetRequested = true;
          fs.writeFileSync(IPC_INPUT_RESET_SENTINEL, '');
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

  // Clean up stale sentinels from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(IPC_INPUT_RESET_SENTINEL);
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

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
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
            PreCompact: [{ hooks: [createPreCompactHook()] }],
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

        // Observe compact_boundary to confirm compaction completed
        if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'compact_boundary'
        ) {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult =
            'result' in message
              ? (message as { result?: string }).result
              : null;

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

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log(
        'WARNING: compact_boundary was not observed. Compaction may not have completed.',
      );
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: slashSessionId,
      });
    }
    return;
  }
  // --- End slash command handling ---

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
        mcpServerPath,
        containerInput,
        sdkEnv,
        controlServer,
        resumeAt,
      );
      if (resetRequested) {
        log('Session reset requested, clearing session state');
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

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

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
