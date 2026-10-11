import { mkdir, realpath, open, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export function isWithin(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

export async function readWorkspaceFile(workspace, name) {
  const root = await realpath(workspace);
  const path = await realpath(resolve(root, name));
  if (!isWithin(root, path)) throw new Error('File must be inside the workspace.');
  const parts = relative(root, path).split(/[\\/]/);
  if (parts.some(p => p.startsWith('.') || /^(id_rsa|id_ed25519|auth\.json)$/i.test(p))) {
    throw new Error('Hidden files and authentication files cannot be exported.');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Only regular files can be sent.');
    return { attachment: await file.readFile(), name: basename(path) };
  } finally { await file.close(); }
}

export async function downloadAttachment(workspace, messageId, attachment) {
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
    throw new Error('Only Discord attachments are supported.');
  }
  if (!/^\d+$/.test(messageId)) throw new Error('Invalid message ID.');
  const root = await realpath(workspace);
  const dir = join(root, 'discord-uploads', messageId);
  await mkdir(dir, { recursive: true });
  if (!isWithin(root, await realpath(dir))) throw new Error('Upload directory points outside workspace.');
  const name = `${attachment.id}-${basename(attachment.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const path = join(dir, name);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await pipeline(response.body, file.createWriteStream());
  } catch (error) {
    if (file) await rm(path, { force: true }); // Remove only the partial file created by this attempt.
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    throw error;
  } finally { await file?.close(); }
  return path;
}
