import fs from 'fs';
import path from 'path';
import {
  type HookCallback,
  type PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function log(message: string): void {
  console.error(message);
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

function parseTranscript(content: string): ParsedMessage[] {
  const lines = content.split('\n').filter((l) => l.trim());

  // Find the last compact summary marker and start from after it
  let startIndex = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.isCompactSummary === true) {
        startIndex = i + 1;
        break;
      }
    } catch {}
  }

  const messages: ParsedMessage[] = [];
  for (const line of lines.slice(startIndex)) {
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
    const content = msg.content;
    // msg.content.length > 2000
    //   ? msg.content.slice(0, 2000) + '...'
    //   : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
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

export function findTranscriptPath(sessionId: string): string | null {
  const base = path.join(process.env.HOME || '/root', '.claude', 'projects');
  if (!fs.existsSync(base)) return null;
  for (const project of fs.readdirSync(base)) {
    const candidate = path.join(base, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function archiveSession(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const messages = parseTranscript(content);

  if (messages.length === 0) {
    log('No messages to archive');
    return null;
  }

  const summary = getSessionSummary(sessionId, transcriptPath);
  const name = summary ? sanitizeFilename(summary) : generateFallbackName();

  const conversationsDir = '/workspace/group/conversations';
  fs.mkdirSync(conversationsDir, { recursive: true });

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const filename = `${date}-${name}.md`;
  const filePath = path.join(conversationsDir, filename);

  const markdown = formatTranscriptMarkdown(messages, summary);
  fs.writeFileSync(filePath, markdown);

  log(`Archived conversation to ${filePath}`);
  return filePath;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
export function createPreCompactHook(
  onArchived: (path: string) => void,
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const filePath = archiveSession(sessionId, transcriptPath);
      if (filePath) onArchived(filePath);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}
