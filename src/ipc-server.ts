import { createServer } from 'http';
import type { Server, IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from './config.ts';
import type { AvailableGroup } from './container-runner.ts';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from './db.ts';
import { isValidGroupFolder } from './group-folder.ts';
import { logger } from './logger.ts';
import type { RegisteredGroup } from './types.ts';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile: (jid: string, filePath: string, caption?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

interface ContainerIdentity {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
}

const tokenRegistry = new Map<string, ContainerIdentity>();
// Stable per-group tokens — generated once, reused across container restarts
const groupTokens = new Map<string, string>();

export function getGroupToken(
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
): string {
  const existing = groupTokens.get(groupFolder);
  if (existing) return existing;
  const token = randomUUID();
  groupTokens.set(groupFolder, token);
  tokenRegistry.set(token, { groupFolder, chatJid, isMain });
  return token;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function createContainerServer(
  identity: ContainerIdentity,
  deps: IpcDeps,
): McpServer {
  const { groupFolder, chatJid, isMain } = identity;
  const server = new McpServer({ name: 'nanoclaw', version: '1.0.0' });

  server.tool(
    'send_message',
    "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
    { text: z.string().describe('The message text to send') },
    async ({ text }) => {
      try {
        await deps.sendMessage(chatJid, text);
        return ok('Message sent.');
      } catch (e) {
        return err(
          `Send failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.tool(
    'send_file',
    'Send a file (image, document, etc.) to the user or group. The file must be under /workspace/group/ (recommended: /workspace/group/outbox/).',
    {
      filePath: z
        .string()
        .describe(
          'Absolute path under /workspace/group/ (e.g., /workspace/group/outbox/chart.png)',
        ),
      caption: z
        .string()
        .optional()
        .describe('Optional caption to send with the file'),
    },
    async ({ filePath, caption }) => {
      if (!filePath.startsWith('/workspace/group/')) {
        return err(
          'File must be under /workspace/group/. Move it to /workspace/group/outbox/ first.',
        );
      }
      const hostPath = filePath.replace(
        /^\/workspace\/group\//,
        path.join(GROUPS_DIR, groupFolder) + '/',
      );
      if (!fs.existsSync(hostPath)) {
        return err(`File not found: ${filePath}`);
      }
      try {
        await deps.sendFile(chatJid, hostPath, caption);
        return ok('File sent.');
      } catch (e) {
        return err(
          `Send failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.tool(
    'schedule_task',
    `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
• "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
• "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" → group (needs conversation context)
- "Check the weather every morning" → isolated (self-contained task)
- "Follow up on my request" → group (needs to know what was requested)
- "Generate a daily report" → isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
• Always send a message (e.g., reminders, daily briefings)
• Only send a message when there's something to report (e.g., "notify me if...")
• Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
    {
      prompt: z
        .string()
        .describe(
          'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
        ),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .describe(
          'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
        ),
      schedule_value: z
        .string()
        .describe(
          'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
        ),
      context_mode: z
        .enum(['group', 'isolated'])
        .default('group')
        .describe(
          'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
        ),
      target_group_jid: z
        .string()
        .optional()
        .describe(
          '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
        ),
    },
    async ({
      prompt,
      schedule_type,
      schedule_value,
      context_mode,
      target_group_jid,
    }) => {
      if (schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(schedule_value);
        } catch {
          return err(
            `Invalid cron: "${schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
          );
        }
      } else if (schedule_type === 'interval') {
        const ms = parseInt(schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return err(
            `Invalid interval: "${schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
          );
        }
      } else if (schedule_type === 'once') {
        if (
          /[Zz]$/.test(schedule_value) ||
          /[+-]\d{2}:\d{2}$/.test(schedule_value)
        ) {
          return err(
            `Timestamp must be local time without timezone suffix. Got "${schedule_value}" — use format like "2026-02-01T15:30:00".`,
          );
        }
        if (isNaN(new Date(schedule_value).getTime())) {
          return err(
            `Invalid timestamp: "${schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
          );
        }
      }

      const targetJid = isMain && target_group_jid ? target_group_jid : chatJid;
      const registeredGroups = deps.registeredGroups();
      const targetGroup = registeredGroups[targetJid];
      if (!targetGroup) {
        return err(`Target group not registered: ${targetJid}`);
      }

      if (!isMain && targetGroup.folder !== groupFolder) {
        return err('Non-main groups can only schedule tasks for themselves.');
      }

      let nextRun: string | null = null;
      if (schedule_type === 'cron') {
        nextRun = CronExpressionParser.parse(schedule_value, { tz: TIMEZONE })
          .next()
          .toISOString();
      } else if (schedule_type === 'interval') {
        nextRun = new Date(
          Date.now() + parseInt(schedule_value, 10),
        ).toISOString();
      } else {
        nextRun = new Date(schedule_value).toISOString();
      }

      const taskId = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const mode = context_mode === 'isolated' ? 'isolated' : 'group';
      createTask({
        id: taskId,
        group_folder: targetGroup.folder,
        chat_jid: targetJid,
        prompt,
        schedule_type,
        schedule_value,
        context_mode: mode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });

      logger.info(
        { taskId, groupFolder, targetFolder: targetGroup.folder, mode },
        'Task created via MCP',
      );
      return ok(
        `Task ${taskId} scheduled: ${schedule_type} - ${schedule_value}`,
      );
    },
  );

  server.tool(
    'list_tasks',
    "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
    {},
    async () => {
      const allTasks = getAllTasks();
      const tasks = isMain
        ? allTasks
        : allTasks.filter((t) => t.group_folder === groupFolder);

      if (tasks.length === 0) return ok('No scheduled tasks found.');

      const formatted = tasks
        .map(
          (t) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return ok(`Scheduled tasks:\n${formatted}`);
    },
  );

  server.tool(
    'pause_task',
    'Pause a scheduled task. It will not run until resumed.',
    { task_id: z.string().describe('The task ID to pause') },
    async ({ task_id }) => {
      const task = getTaskById(task_id);
      if (!task || (!isMain && task.group_folder !== groupFolder)) {
        return err(`Task not found or not authorized: ${task_id}`);
      }
      updateTask(task_id, { status: 'paused' });
      logger.info({ taskId: task_id, groupFolder }, 'Task paused via MCP');
      return ok(`Task ${task_id} paused.`);
    },
  );

  server.tool(
    'resume_task',
    'Resume a paused task.',
    { task_id: z.string().describe('The task ID to resume') },
    async ({ task_id }) => {
      const task = getTaskById(task_id);
      if (!task || (!isMain && task.group_folder !== groupFolder)) {
        return err(`Task not found or not authorized: ${task_id}`);
      }
      updateTask(task_id, { status: 'active' });
      logger.info({ taskId: task_id, groupFolder }, 'Task resumed via MCP');
      return ok(`Task ${task_id} resumed.`);
    },
  );

  server.tool(
    'cancel_task',
    'Cancel and delete a scheduled task.',
    { task_id: z.string().describe('The task ID to cancel') },
    async ({ task_id }) => {
      const task = getTaskById(task_id);
      if (!task || (!isMain && task.group_folder !== groupFolder)) {
        return err(`Task not found or not authorized: ${task_id}`);
      }
      deleteTask(task_id);
      logger.info({ taskId: task_id, groupFolder }, 'Task cancelled via MCP');
      return ok(`Task ${task_id} cancelled.`);
    },
  );

  server.tool(
    'update_task',
    'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
    {
      task_id: z.string().describe('The task ID to update'),
      prompt: z.string().optional().describe('New prompt for the task'),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .optional()
        .describe('New schedule type'),
      schedule_value: z
        .string()
        .optional()
        .describe('New schedule value (see schedule_task for format)'),
    },
    async ({ task_id, prompt, schedule_type, schedule_value }) => {
      const task = getTaskById(task_id);
      if (!task) return err(`Task not found: ${task_id}`);
      if (!isMain && task.group_folder !== groupFolder) {
        return err(`Not authorized to update task: ${task_id}`);
      }

      if (schedule_value) {
        const type = schedule_type ?? task.schedule_type;
        if (type === 'cron') {
          try {
            CronExpressionParser.parse(schedule_value);
          } catch {
            return err(`Invalid cron: "${schedule_value}".`);
          }
        } else if (type === 'interval') {
          const ms = parseInt(schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            return err(`Invalid interval: "${schedule_value}".`);
          }
        }
      }

      const updates: Parameters<typeof updateTask>[1] = {};
      if (prompt !== undefined) updates.prompt = prompt;
      if (schedule_type !== undefined) updates.schedule_type = schedule_type;
      if (schedule_value !== undefined) updates.schedule_value = schedule_value;

      if (schedule_type !== undefined || schedule_value !== undefined) {
        const merged = { ...task, ...updates };
        if (merged.schedule_type === 'cron') {
          try {
            updates.next_run = CronExpressionParser.parse(
              merged.schedule_value,
              { tz: TIMEZONE },
            )
              .next()
              .toISOString();
          } catch {
            return err(`Invalid cron in updated schedule.`);
          }
        } else if (merged.schedule_type === 'interval') {
          const ms = parseInt(merged.schedule_value, 10);
          if (!isNaN(ms) && ms > 0) {
            updates.next_run = new Date(Date.now() + ms).toISOString();
          }
        }
      }

      updateTask(task_id, updates);
      logger.info(
        { taskId: task_id, groupFolder, updates },
        'Task updated via MCP',
      );
      return ok(`Task ${task_id} updated.`);
    },
  );

  server.tool(
    'register_group',
    `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
    {
      jid: z
        .string()
        .describe(
          'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
        ),
      name: z.string().describe('Display name for the group'),
      folder: z
        .string()
        .describe(
          'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
        ),
      trigger: z.string().describe('Trigger word (e.g., "@AssistantName")'),
    },
    async ({ jid, name, folder, trigger }) => {
      if (!isMain) {
        return err('Only the main group can register new groups.');
      }
      if (!isValidGroupFolder(folder)) {
        return err(
          `Invalid folder name: "${folder}". Must be channel-prefixed (e.g., "telegram_dev-team").`,
        );
      }
      deps.registerGroup(jid, {
        name,
        folder,
        trigger,
        added_at: new Date().toISOString(),
      });
      logger.info(
        { jid, name, folder, groupFolder },
        'Group registered via MCP',
      );
      return ok(
        `Group "${name}" registered. It will start receiving messages immediately.`,
      );
    },
  );

  server.tool(
    'refresh_groups',
    'Refresh the list of available groups from connected channels. Main group only.',
    {},
    async () => {
      if (!isMain) {
        return err('Only the main group can refresh groups.');
      }
      await deps.syncGroups(true);
      const availableGroups = deps.getAvailableGroups();
      const registeredGroups = deps.registeredGroups();
      deps.writeGroupsSnapshot(
        groupFolder,
        true,
        availableGroups,
        new Set(Object.keys(registeredGroups)),
      );
      logger.info({ groupFolder }, 'Groups refreshed via MCP');
      return ok(
        `Groups refreshed. ${availableGroups.length} groups available.`,
      );
    },
  );

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export async function startIpcMcpServer(
  port: number,
  host: string,
  deps: IpcDeps,
): Promise<Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST') {
        const body = await readBody(req);

        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.handleRequest(req, res, body);
          return;
        }

        if (!isInitializeRequest(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Bad Request' },
              id: null,
            }),
          );
          return;
        }

        const auth = req.headers['authorization'];
        const token =
          typeof auth === 'string' && auth.startsWith('Bearer ')
            ? auth.slice(7)
            : null;
        const identity = token ? tokenRegistry.get(token) : null;

        if (!identity) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Unauthorized' },
              id: null,
            }),
          );
          return;
        }

        let transport: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };

        const mcpServer = createContainerServer(identity, deps);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      } else if (req.method === 'GET') {
        if (!sessionId || !sessions.has(sessionId)) {
          res.writeHead(404);
          res.end();
          return;
        }
        await sessions.get(sessionId)!.handleRequest(req, res);
      } else if (req.method === 'DELETE') {
        if (!sessionId || !sessions.has(sessionId)) {
          res.writeHead(404);
          res.end();
          return;
        }
        await sessions.get(sessionId)!.handleRequest(req, res);
        sessions.delete(sessionId);
      } else {
        res.writeHead(405);
        res.end();
      }
    } catch (e) {
      logger.error({ err: e }, 'IPC MCP server error');
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
      logger.info({ port, host }, 'IPC MCP server started');
      resolve(httpServer);
    });
    httpServer.on('error', reject);
  });
}

/**
 * Process a task IPC operation by identity and deps.
 * Exported for testing — production code uses the MCP tool handlers above.
 */
export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    targetJid?: string;
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task': {
      if (
        !data.prompt ||
        !data.schedule_type ||
        !data.schedule_value ||
        !data.targetJid
      )
        break;
      const targetGroup = registeredGroups[data.targetJid];
      if (!targetGroup) break;
      if (!isMain && targetGroup.folder !== sourceGroup) break;

      const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';
      let nextRun: string | null = null;
      if (scheduleType === 'cron') {
        try {
          nextRun = CronExpressionParser.parse(data.schedule_value, {
            tz: TIMEZONE,
          })
            .next()
            .toISOString();
        } catch {
          break;
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(data.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) break;
        nextRun = new Date(Date.now() + ms).toISOString();
      } else if (scheduleType === 'once') {
        const date = new Date(data.schedule_value);
        if (isNaN(date.getTime())) break;
        nextRun = date.toISOString();
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const contextMode =
        data.context_mode === 'group' || data.context_mode === 'isolated'
          ? data.context_mode
          : 'isolated';
      createTask({
        id: taskId,
        group_folder: targetGroup.folder,
        chat_jid: data.targetJid,
        prompt: data.prompt,
        schedule_type: scheduleType,
        schedule_value: data.schedule_value,
        context_mode: contextMode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      break;
    }
    case 'pause_task': {
      if (!data.taskId) break;
      const task = getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        updateTask(data.taskId, { status: 'paused' });
      }
      break;
    }
    case 'resume_task': {
      if (!data.taskId) break;
      const task = getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        updateTask(data.taskId, { status: 'active' });
      }
      break;
    }
    case 'cancel_task': {
      if (!data.taskId) break;
      const task = getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        deleteTask(data.taskId);
      }
      break;
    }
    case 'refresh_groups':
      if (isMain) {
        await deps.syncGroups(true);
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      }
      break;
    case 'register_group':
      if (!isMain) break;
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) break;
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      }
      break;
  }
}
