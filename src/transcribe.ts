import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.ts';
import { logger } from './logger.ts';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

function getApiKey(): string {
  const env = readEnvFile(['GROQ_API_KEY']);
  return process.env.GROQ_API_KEY || env.GROQ_API_KEY || '';
}

export async function transcribe(filePath: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const file = new Blob([fs.readFileSync(filePath)], {
    type: 'audio/ogg',
  });
  const form = new FormData();
  form.append('file', file, path.basename(filePath));
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { text: string };
  return json.text.trim();
}
