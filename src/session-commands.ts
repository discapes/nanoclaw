import type { NewMessage } from './types.ts';
import { logger } from './logger.ts';

export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  if (text === '/compact' || text === '/stop') return text;
  if (text === '/seshname' || text.startsWith('/seshname ')) return '/seshname';
  if (text === '/sesh' || text.startsWith('/sesh ')) return '/sesh';
  return null;
}

function getCommandArgs(
  content: string,
  triggerPattern: RegExp,
  command: string,
): string {
  return content
    .trim()
    .replace(triggerPattern, '')
    .trim()
    .slice(command.length)
    .trim();
}

export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

export interface SessionHistoryEntry {
  session_id: string;
  name: string | null;
  created_at: string;
}

export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  getActiveSession: () => string | undefined;
  setActiveSession: (sessionId: string | undefined) => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  canSenderInteract: (msg: NewMessage) => boolean;
  getSessionHistory: () => SessionHistoryEntry[];
  findSession: (
    idOrName: string,
  ) => { session_id: string; name: string | null } | undefined;
  isNameTaken: (name: string) => boolean;
  getSessionName: (sessionId: string) => string | null;
  setSessionName: (sessionId: string, name: string) => void;
}

export function formatSessionLabel(
  sessionId: string,
  name?: string | null,
): string {
  const short = sessionId.slice(0, 8);
  return name ? `"${name}" (${short})` : short;
}

export function formatSessionChange(
  oldId: string | undefined,
  newId: string | undefined,
  oldName?: string | null,
  newName?: string | null,
): string {
  const oldLabel = oldId ? formatSessionLabel(oldId, oldName) : 'none';
  const newLabel = newId ? formatSessionLabel(newId, newName) : 'none';
  return `Session: ${oldLabel} → ${newLabel}`;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (!isSessionCommandAllowed(isMainGroup, cmdMsg.is_from_me === true)) {
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  logger.info({ group: groupName, command }, 'Session command');

  // --- Host-only commands ---

  if (command === '/stop') {
    deps.closeStdin();
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage('Container stopped.');
    return { handled: true, success: true };
  }

  if (command === '/sesh') {
    const args = getCommandArgs(cmdMsg.content, triggerPattern, '/sesh');
    deps.advanceCursor(cmdMsg.timestamp);

    if (!args) {
      const history = deps.getSessionHistory();
      if (history.length === 0) {
        await deps.sendMessage('No sessions.');
        return { handled: true, success: true };
      }
      const activeId = deps.getActiveSession();
      const lines = history.map((s) => {
        const marker = s.session_id === activeId ? ' →' : '  ';
        const label = formatSessionLabel(s.session_id, s.name);
        return `${marker} ${label}`;
      });
      await deps.sendMessage(lines.join('\n'));
      return { handled: true, success: true };
    }

    // /sesh new — start a fresh session
    if (args === 'new') {
      const oldId = deps.getActiveSession();
      const oldName = oldId ? deps.getSessionName(oldId) : null;
      deps.closeStdin();
      deps.setActiveSession(undefined);
      await deps.sendMessage(formatSessionChange(oldId, undefined, oldName));
      return { handled: true, success: true };
    }

    // /sesh <id-or-name> — switch to existing session
    const target = deps.findSession(args);
    if (!target) {
      await deps.sendMessage(`Session not found: ${args}`);
      return { handled: true, success: true };
    }
    const oldId = deps.getActiveSession();
    const oldName = oldId ? deps.getSessionName(oldId) : null;
    deps.closeStdin();
    deps.setActiveSession(target.session_id);
    await deps.sendMessage(
      formatSessionChange(oldId, target.session_id, oldName, target.name),
    );
    return { handled: true, success: true };
  }

  if (command === '/seshname') {
    const args = getCommandArgs(cmdMsg.content, triggerPattern, '/seshname');
    deps.advanceCursor(cmdMsg.timestamp);
    const activeId = deps.getActiveSession();

    if (!activeId) {
      await deps.sendMessage('No active session.');
      return { handled: true, success: true };
    }

    if (!args) {
      const name = deps.getSessionName(activeId);
      await deps.sendMessage(formatSessionLabel(activeId, name));
      return { handled: true, success: true };
    }

    if (deps.isNameTaken(args)) {
      await deps.sendMessage(`Name "${args}" is already in use.`);
      return { handled: true, success: true };
    }
    deps.setSessionName(activeId, args);
    await deps.sendMessage(`Session ${activeId.slice(0, 8)} named "${args}"`);
    return { handled: true, success: true };
  }

  // --- Container command: /compact ---

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
