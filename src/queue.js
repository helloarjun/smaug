import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeJsonAtomic(file, data) {
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readQueue(file) {
  if (!fs.existsSync(file)) return { count: 0, bookmarks: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.bookmarks) || data.bookmarks.some(b => !b || !/^\d+$/.test(String(b.id)))) {
    throw new Error(`Invalid bookmark queue: ${file}. File preserved; repair it before retrying.`);
  }
  return { ...data, count: data.bookmarks.length };
}

// Recover queues truncated by older versions, before another batch can overwrite .full.
export function recoverQueue(file) {
  if (!fs.existsSync(`${file}.full`)) return readQueue(file);
  const full = readQueue(`${file}.full`);
  const current = readQueue(file);
  const bookmarks = [...new Map([...full.bookmarks, ...current.bookmarks].map(b => [String(b.id), b])).values()];
  const restored = { ...full, ...current, count: bookmarks.length, bookmarks };
  writeJsonAtomic(file, restored);
  fs.unlinkSync(`${file}.full`);
  return restored;
}

export async function withQueueLock(file, action) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never expire a live owner's lock or guess about a malformed lock.
    throw new Error(`Queue is locked: ${lock}. Confirm the owning process has stopped before removing this file.`);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await action();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
