import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface Frontmatter {
  [key: string]: string;
}

function parseFrontmatter(content: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content };
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: content };

  const yaml = content.slice(4, end);
  const frontmatter: Frontmatter = {};
  let currentKey = '';

  for (const line of yaml.split('\n')) {
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (keyMatch) {
      const [, key, rest] = keyMatch;
      const value = rest.replace(/^["'>]\s*|["']$/g, '').trim();
      currentKey = key;
      frontmatter[key] = value;
    } else if (currentKey && /^\s+\S/.test(line)) {
      frontmatter[currentKey] += ' ' + line.trim();
    }
  }

  const body = content.slice(end + 4).replace(/^\n/, '');
  return { frontmatter, body };
}

interface FileEntry {
  name: string;
  description: string;
  body: string;
}

async function scanSkills(
  skillsDir: string,
): Promise<{ name: string; description: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: { name: string; description: string }[] = [];

  for (const entry of entries.sort()) {
    const skillFile = join(skillsDir, entry, 'SKILL.md');
    try {
      await stat(skillFile);
    } catch {
      continue;
    }
    const content = await readFile(skillFile, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    skills.push({
      name: frontmatter.name || entry,
      description: frontmatter.description || '',
    });
  }

  return skills;
}

const SKIP_MD_SCAN = new Set(['skills', 'conversations']);

async function scanMarkdown(
  dir: string,
  prefix = '',
): Promise<{ path: string; frontmatter: Frontmatter; body: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: { path: string; frontmatter: Frontmatter; body: string }[] =
    [];

  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_MD_SCAN.has(entry.name) && !prefix) {
      results.push(
        ...(await scanMarkdown(join(dir, entry.name), entry.name + '/')),
      );
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = await readFile(join(dir, entry.name), 'utf-8');
      const parsed = parseFrontmatter(content);
      results.push({ path: prefix + entry.name, ...parsed });
    }
  }

  return results;
}

async function listSubdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

export async function buildSystemPrompt(dir: string): Promise<string> {
  const allFiles = (await scanMarkdown(dir)).sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  const systemPromptFiles: FileEntry[] = [];
  const otherFiles: { name: string; description: string }[] = [];

  for (const file of allFiles) {
    if (file.frontmatter.system_prompt === 'yes') {
      systemPromptFiles.push({
        name: file.path,
        description: file.frontmatter.description ?? '',
        body: file.body.trim(),
      });
    } else {
      otherFiles.push({
        name: file.path,
        description: file.frontmatter.description ?? '',
      });
    }
  }

  const skills = await scanSkills(join(dir, 'skills'));

  const parts: string[] = [];

  for (const file of systemPromptFiles) {
    parts.push(
      `The following section of your system prompt is the contents of the file ${file.name}. It can be edited to change the contents of the following section.`,
    );
    parts.push(file.body);
  }

  const systemList = systemPromptFiles
    .map((f) => `- ${f.name}${f.description ? ` — ${f.description}` : ''}`)
    .join('\n');

  parts.push(
    `The following is an automatically generated list of markdown files in your workspace with the \`system_prompt: yes\` frontmatter attribute. They, in addition to this list itself, make up your system prompt.\n\n${systemList}`,
  );

  if (otherFiles.length > 0) {
    const otherList = otherFiles
      .map((f) => `- ${f.name}${f.description ? ` — ${f.description}` : ''}`)
      .join('\n');

    parts.push(
      `The following is an automatically generated list of all the other markdown files in your workspace. Remember them and view them whenever relevant.\n\n${otherList}`,
    );
  }

  if (skills.length > 0) {
    const skillList = skills
      .map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ''}`)
      .join('\n');

    parts.push(
      `The following is an automatically generated list of your installed skills (in skills/). Each has a SKILL.md with detailed instructions — read it when the skill is relevant.\n\n${skillList}`,
    );
  }

  const subdirs = await listSubdirectories(dir);
  if (subdirs.length > 0) {
    const subdirList = subdirs.map((d) => `- ${d}/`).join('\n');
    parts.push(
      `The following is an automatically generated list of subdirectories in your workspace.\n\n${subdirList}`,
    );
  }

  parts.push('This is the end of your system prompt.');
  return parts.join('\n\n\n\n') + '\n\n\n';
}

if (process.argv[1] === import.meta.filename) {
  const dir = resolve(process.argv[2] ?? '/workspace/group');
  buildSystemPrompt(dir).then((prompt) => process.stdout.write(prompt));
}
