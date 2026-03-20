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

export interface SessionHistoryEntry {
  session_id: string;
  name: string | null;
  created_at: string;
}

export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  closeStdin: () => void;
  sendCompact: () => void;
  sendSwitch: (sessionId: string) => void;
  getActiveSession: () => string | undefined;
  setActiveSession: (sessionId: string | undefined) => void;
  advanceCursor: (timestamp: string) => void;
  canSenderInteract: (msg: NewMessage) => boolean;
  getSessionHistory: () => SessionHistoryEntry[];
  findSession: (
    idOrName: string,
  ) => { session_id: string; name: string | null } | undefined;
  isNameTaken: (name: string) => boolean;
  getSessionName: (sessionId: string) => string | null;
  setSessionName: (sessionId: string, name: string) => void;
  hasActiveContainer: () => boolean;
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

export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const { missedMessages, isMainGroup, groupName, triggerPattern, deps } = opts;

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

  if (command === '/stop') {
    deps.closeStdin();
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage('Container stopped.');
    return { handled: true, success: true };
  }

  if (command === '/compact') {
    deps.advanceCursor(cmdMsg.timestamp);
    if (!deps.hasActiveContainer()) {
      await deps.sendMessage('No active container to compact.');
      return { handled: true, success: true };
    }
    deps.sendCompact();
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

    const oldId = deps.getActiveSession();
    const oldName = oldId ? deps.getSessionName(oldId) : null;

    if (args === 'new') {
      if (deps.hasActiveContainer()) {
        deps.sendSwitch('');
      }
      deps.setActiveSession(undefined);
      await deps.sendMessage(formatSessionChange(oldId, undefined, oldName));
      return { handled: true, success: true };
    }

    const target = deps.findSession(args);
    if (!target) {
      await deps.sendMessage(`Session not found: ${args}`);
      return { handled: true, success: true };
    }
    if (deps.hasActiveContainer()) {
      deps.sendSwitch(target.session_id);
    }
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

  return { handled: false };
}
