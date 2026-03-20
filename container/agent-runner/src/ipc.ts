import fs from 'fs';
import path from 'path';

export const IPC_INPUT_DIR = '/workspace/ipc/input';
export const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
export const IPC_POLL_MS = 500;

const COMPACT_SENTINEL = path.join(IPC_INPUT_DIR, '_compact');
const SWITCH_SENTINEL = path.join(IPC_INPUT_DIR, '_switch');

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

function log(message: string): void {
  console.error(message);
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
export class MessageStream {
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

export type StopReason =
  | { type: 'closed' }
  | { type: 'compact' }
  | { type: 'switch'; sessionId: string | undefined };

function consumeSentinel(filepath: string): string | false {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    fs.unlinkSync(filepath);
    return content;
  } catch {
    return false;
  }
}

/**
 * Check for IPC command sentinels. Returns the first one found, or null.
 * Priority: _close > _compact > _switch
 */
export function checkSentinels(): StopReason | null {
  if (consumeSentinel(IPC_INPUT_CLOSE_SENTINEL) !== false) {
    return { type: 'closed' };
  }
  if (consumeSentinel(COMPACT_SENTINEL) !== false) {
    return { type: 'compact' };
  }
  const switchContent = consumeSentinel(SWITCH_SENTINEL);
  if (switchContent !== false) {
    return { type: 'switch', sessionId: switchContent || undefined };
  }
  return null;
}

export function drainIpcInput(): string[] {
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
 * Wait for a new IPC message or sentinel.
 * Returns messages as a string, or a StopReason.
 */
export function waitForIpc(): Promise<string | StopReason> {
  return new Promise((resolve) => {
    const poll = () => {
      const sentinel = checkSentinels();
      if (sentinel) {
        resolve(sentinel);
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
