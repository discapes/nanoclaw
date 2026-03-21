import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.ts';
import { readEnvByPrefix } from '../env.ts';
import { logger } from '../logger.ts';
import { transcribe } from '../transcribe.ts';
import { registerChannel, type ChannelOpts } from './registry.ts';
import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.ts';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram MarkdownV2 parse mode, falling back to plain text.
 * The agent is instructed to produce MarkdownV2-formatted output directly.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'MarkdownV2',
    });
  } catch (err) {
    logger.debug({ err }, 'MarkdownV2 send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

function downloadToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          out.close();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(out);
        out.on('finish', () => {
          out.close();
          resolve();
        });
      })
      .on('error', reject);
  });
}

/**
 * Save a file to the group's inbox directory with collision-safe naming.
 * Returns the container-visible path (/workspace/group/inbox/...).
 */
function saveAttachment(
  groupFolder: string,
  filename: string,
  tmpPath: string,
): string {
  const dir = path.join(GROUPS_DIR, groupFolder, 'inbox');
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let dest = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base}_${n}${ext}`);
    n++;
  }

  fs.renameSync(tmpPath, dest);
  return `/workspace/group/inbox/${path.basename(dest)}`;
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 3) / 2);
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

function replyPrefix(msg: any): string {
  if (!msg) return '';
  const sender = msg.from?.first_name || msg.from?.username || '';
  const text = msg.text || msg.caption || '';
  if (!text) return '';
  return `[Replying to ${sender}: ${truncate(text)}]\n`;
}

export class TelegramChannel implements Channel {
  name: string;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private jidPrefix: string;

  constructor(
    botToken: string,
    opts: TelegramChannelOpts,
    instanceId?: string,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.name = instanceId ? `telegram:${instanceId}` : 'telegram';
    this.jidPrefix = instanceId ? `tg.${instanceId}:` : 'tg:';
  }

  private chatJid(chatId: number | string): string {
    return `${this.jidPrefix}${chatId}`;
  }

  private numericId(jid: string): string {
    return jid.slice(this.jidPrefix.length);
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`${this.jidPrefix}${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'MarkdownV2' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply('Online.');
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `${this.jidPrefix}${ctx.chat.id}`;
      let content =
        replyPrefix(ctx.message.reply_to_message) + ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @my_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Name\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        this.name,
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `${this.jidPrefix}${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const reply = replyPrefix(ctx.message.reply_to_message);
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        this.name,
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${reply}${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    const storeAttachment = async (
      ctx: any,
      label: string,
      filename: string,
    ) => {
      const chatJid = `${this.jidPrefix}${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      let content: string;
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const tmpFile = path.join(os.tmpdir(), `tg-${Date.now()}-${filename}`);
        await downloadToFile(url, tmpFile);
        const containerPath = saveAttachment(group.folder, filename, tmpFile);
        content = `[${label} uploaded, saved to ${containerPath}]`;
      } catch (err: any) {
        logger.error({ err, label }, 'Telegram file download failed');
        content = `[${label} — download failed: ${err.message}]`;
      }

      storeNonText(ctx, content);
    };

    this.bot.on('message:photo', (ctx) => {
      const filename = `photo_${ctx.message.message_id}.jpg`;
      return storeAttachment(ctx, 'Image', filename);
    });
    this.bot.on('message:video', (ctx) => {
      const filename =
        ctx.message.video?.file_name || `video_${ctx.message.message_id}.mp4`;
      return storeAttachment(ctx, 'Video', filename);
    });
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `${this.jidPrefix}${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      let content: string;
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const tmpFile = path.join(os.tmpdir(), `tg-voice-${Date.now()}.ogg`);
        try {
          await downloadToFile(url, tmpFile);
          const text = await transcribe(tmpFile);
          content = `[Voice: ${text}]`;
        } finally {
          fs.unlink(tmpFile, () => {});
        }
      } catch (err: any) {
        logger.error({ err }, 'Voice transcription failed');
        content = `[Voice message — transcription failed: ${err.message}]`;
      }

      const reply = replyPrefix(ctx.message.reply_to_message);
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        this.name,
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${reply}${content}${caption}`,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const filename =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}.mp3`;
      return storeAttachment(ctx, 'Audio file', filename);
    });
    this.bot.on('message:document', (ctx) => {
      const filename = ctx.message.document?.file_name || 'file';
      return storeAttachment(ctx, 'File', filename);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = this.numericId(jid);

    // Telegram has a 4096 character limit per message — split if needed
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(this.bot.api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          this.bot.api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info({ jid, length: text.length }, 'Telegram message sent');
  }

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = this.numericId(jid);
    const file = new InputFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

    if (imageExts.has(ext)) {
      await this.bot.api.sendPhoto(numericId, file, {
        caption,
        parse_mode: 'MarkdownV2',
      });
    } else {
      await this.bot.api.sendDocument(numericId, file, {
        caption,
        parse_mode: 'MarkdownV2',
      });
    }
    logger.info({ jid, filePath }, 'Telegram file sent');
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(this.jidPrefix);
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = this.numericId(jid);
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

const TOKEN_PREFIX = 'TELEGRAM_BOT_TOKEN';
const tokens = readEnvByPrefix(TOKEN_PREFIX);

if (Object.keys(tokens).length === 0) {
  logger.warn('Telegram: no TELEGRAM_BOT_TOKEN* env vars set');
} else {
  for (const [key, token] of Object.entries(tokens)) {
    const suffix = key.slice(TOKEN_PREFIX.length);
    if (suffix && !suffix.startsWith('_')) continue;
    const instanceId = suffix ? suffix.slice(1).toLowerCase() : undefined;
    const channelName = instanceId ? `telegram:${instanceId}` : 'telegram';
    registerChannel(
      channelName,
      (opts: ChannelOpts) => new TelegramChannel(token, opts, instanceId),
    );
  }
}
