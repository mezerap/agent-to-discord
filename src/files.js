import { mkdir, realpath, open } from 'node:fs/promises';
import { join, relative, isAbsolute, basename } from 'node:path';
import { constants } from 'node:fs';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function isWithin(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

export async function readWorkspaceFile(workspace, name) {
  const root = await realpath(workspace);
  const path = await realpath(join(root, name));
  if (!isWithin(root, path)) throw new Error('File must be inside the workspace.');
  const parts = relative(root, path).split(/[\\/]/);
  if (parts.some(p => p.startsWith('.') || /^(id_rsa|id_ed25519|auth\.json)$/i.test(p))) {
    throw new Error('Hidden files and authentication files cannot be exported.');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Only regular files up to 8 MiB can be sent.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new Error('File exceeds 8 MiB.');
    return { attachment: buffer.subarray(0, bytesRead), name: basename(path) };
  } finally { await file.close(); }
}

export async function downloadAttachment(workspace, messageId, attachment) {
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
    throw new Error('Only Discord attachments are supported.');
  }
  if (!/^\d+$/.test(messageId) || attachment.size > MAX_FILE_BYTES) throw new Error('Attachment exceeds 8 MiB.');
  const root = await realpath(workspace);
  const dir = join(root, 'discord-uploads', messageId);
  await mkdir(dir, { recursive: true });
  if (!isWithin(root, await realpath(dir))) throw new Error('Upload directory points outside workspace.');
  const name = `${attachment.id}-${basename(attachment.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const path = join(dir, name);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_FILE_BYTES) throw new Error('Attachment exceeds 8 MiB.');
    chunks.push(chunk);
  }
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(Buffer.concat(chunks)); } finally { await file.close(); }
  return path;
}
