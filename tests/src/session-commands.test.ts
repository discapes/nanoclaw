import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  formatSessionChange,
  formatSessionLabel,
  handleSessionCommand,
  isSessionCommandAllowed,
} from '../../src/../src/session-commands.ts';
import type { NewMessage } from '../../src/../src/types.ts';
import type { SessionCommandDeps } from '../../src/../src/session-commands.ts';

describe('extractSessionCommand', () => {
  const trigger = /^@UnitTestNameBob\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@UnitTestNameBob /compact', trigger)).toBe(
      '/compact',
    );
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });

  it('detects /stop', () => {
    expect(extractSessionCommand('/stop', trigger)).toBe('/stop');
  });

  it('detects /stop with trigger prefix', () => {
    expect(extractSessionCommand('@UnitTestNameBob /stop', trigger)).toBe(
      '/stop',
    );
  });

  it('rejects /stop with extra text', () => {
    expect(extractSessionCommand('/stop now', trigger)).toBeNull();
  });

  it('detects /sesh without args', () => {
    expect(extractSessionCommand('/sesh', trigger)).toBe('/sesh');
  });

  it('detects /sesh with args', () => {
    expect(extractSessionCommand('/sesh my-session', trigger)).toBe('/sesh');
  });

  it('detects /sesh new', () => {
    expect(extractSessionCommand('/sesh new', trigger)).toBe('/sesh');
  });

  it('detects /sesh with trigger prefix and args', () => {
    expect(extractSessionCommand('@UnitTestNameBob /sesh work', trigger)).toBe(
      '/sesh',
    );
  });

  it('detects /seshname without args', () => {
    expect(extractSessionCommand('/seshname', trigger)).toBe('/seshname');
  });

  it('detects /seshname with args', () => {
    expect(extractSessionCommand('/seshname work', trigger)).toBe('/seshname');
  });

  it('does not confuse /seshname with /sesh', () => {
    expect(extractSessionCommand('/seshname foo', trigger)).toBe('/seshname');
  });

  it('does not detect removed commands', () => {
    expect(extractSessionCommand('/reset', trigger)).toBeNull();
    expect(extractSessionCommand('/resetnow', trigger)).toBeNull();
  });
});

describe('formatSessionLabel', () => {
  it('formats ID only', () => {
    expect(formatSessionLabel('abcdef1234567890')).toBe('abcdef12');
  });

  it('formats ID with name', () => {
    expect(formatSessionLabel('abcdef1234567890', 'work')).toBe(
      '"work" (abcdef12)',
    );
  });

  it('formats ID without name when name is null', () => {
    expect(formatSessionLabel('abcdef1234567890', null)).toBe('abcdef12');
  });
});

describe('formatSessionChange', () => {
  it('formats old → new', () => {
    expect(formatSessionChange('aaaa1111', 'bbbb2222')).toBe(
      'Session: aaaa1111 → bbbb2222',
    );
  });

  it('formats old → none', () => {
    expect(formatSessionChange('aaaa1111', undefined)).toBe(
      'Session: aaaa1111 → none',
    );
  });

  it('formats with names', () => {
    expect(formatSessionChange('aaaa1111', 'bbbb2222', 'work', 'play')).toBe(
      'Session: "work" (aaaa1111) → "play" (bbbb2222)',
    );
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    getActiveSession: vi.fn().mockReturnValue('sess-old-1234'),
    setActiveSession: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    getSessionHistory: vi.fn().mockReturnValue([]),
    findSession: vi.fn().mockReturnValue(undefined),
    isNameTaken: vi.fn().mockReturnValue(false),
    getSessionName: vi.fn().mockReturnValue(null),
    setSessionName: vi.fn(),
    ...overrides,
  };
}

const trigger = /^@UnitTestNameBob\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('handles /stop without running agent', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/stop')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.closeStdin).toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.sendMessage).toHaveBeenCalledWith('Container stopped.');
  });

  it('denies /stop from untrusted sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/stop', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.closeStdin).not.toHaveBeenCalled();
  });

  it('/sesh with no args lists sessions', async () => {
    const deps = makeDeps({
      getActiveSession: vi.fn().mockReturnValue('sess-aaa'),
      getSessionHistory: vi.fn().mockReturnValue([
        { session_id: 'sess-aaa', name: 'work', created_at: '2025-01-01' },
        { session_id: 'sess-bbb', name: null, created_at: '2025-01-02' },
      ]),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/sesh')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('work'),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.stringContaining('→'));
  });

  it('/sesh with no args shows empty message when no sessions', async () => {
    const deps = makeDeps({
      getSessionHistory: vi.fn().mockReturnValue([]),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/sesh')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('No sessions.');
  });

  it('/sesh new clears session and notifies', async () => {
    const deps = makeDeps({
      getActiveSession: vi.fn().mockReturnValue('sess-old-1234'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/sesh new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.closeStdin).toHaveBeenCalled();
    expect(deps.setActiveSession).toHaveBeenCalledWith(undefined);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('sess-old'),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('none'),
    );
  });

  it('/sesh with arg switches session', async () => {
    const deps = makeDeps({
      getActiveSession: vi.fn().mockReturnValue('sess-old-1234'),
      findSession: vi
        .fn()
        .mockReturnValue({ session_id: 'sess-new-5678', name: 'work' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/sesh work')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.closeStdin).toHaveBeenCalled();
    expect(deps.setActiveSession).toHaveBeenCalledWith('sess-new-5678');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('sess-old'),
    );
  });

  it('/sesh with unknown arg sends error', async () => {
    const deps = makeDeps({
      findSession: vi.fn().mockReturnValue(undefined),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/sesh unknown')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('Session not found: unknown');
    expect(deps.setActiveSession).not.toHaveBeenCalled();
  });

  it('/seshname with no args shows current session', async () => {
    const deps = makeDeps({
      getActiveSession: vi.fn().mockReturnValue('sess-aaa-1234'),
      getSessionName: vi.fn().mockReturnValue('work'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/seshname')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('"work" (sess-aaa)');
  });

  it('/seshname with no active session', async () => {
    const deps = makeDeps({
      getActiveSession: vi.fn().mockReturnValue(undefined),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/seshname')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('No active session.');
  });

  it('/seshname with arg sets name', async () => {
    const deps = makeDeps({
      getActiveSession: vi.fn().mockReturnValue('sess-aaa-1234'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/seshname work')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.setSessionName).toHaveBeenCalledWith('sess-aaa-1234', 'work');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session sess-aaa named "work"',
    );
  });

  it('/seshname rejects duplicate name', async () => {
    const deps = makeDeps({
      getActiveSession: vi.fn().mockReturnValue('sess-aaa-1234'),
      isNameTaken: vi.fn().mockReturnValue(true),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/seshname work')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.setSessionName).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Name "work" is already in use.',
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });
});
