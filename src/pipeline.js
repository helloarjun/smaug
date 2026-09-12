import fs from 'node:fs';
import path from 'node:path';
import { readQueue, recoverQueue, withQueueLock, writeAtomic, writeJsonAtomic } from './queue.js';

// Only primary Tweet fields count: quoted/parent links do not acknowledge a bookmark.
export function archivedIds(text) {
  return new Set([...text.matchAll(/^- \*\*Tweet:\*\*\s+(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/\w+\/status\/(\d+)\b/gm)].map(m => m[1]));
}

function archiveText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export function mergeArchive(original, batch, accepted, timezone = 'UTC') {
  const groups = new Map();
  for (const bookmark of [...batch].reverse()) {
    const markdown = accepted.get(String(bookmark.id));
    if (!markdown) continue;
    let date = bookmark.date;
    if (!/^[A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4}$/.test(date || '') || !Number.isFinite(Date.parse(date))) {
      const created = new Date(bookmark.createdAt || 'invalid');
      date = Number.isFinite(created.getTime())
        ? new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: timezone }).format(created)
        : 'Undated bookmarks';
    }
    groups.set(date, [...(groups.get(date) || []), markdown]);
  }
  const timestamp = date => Number.isFinite(Date.parse(date)) ? Date.parse(date) : -Infinity;
  let archive = original;
  for (const [date, entries] of [...groups].sort((a, b) => timestamp(b[0]) - timestamp(a[0]))) {
    const headings = [...archive.matchAll(/^# ([^\r\n]+)\r?$/gm)];
    const sameDate = headings.find(heading => heading[1] === date);
    if (sameDate) {
      const at = sameDate.index + sameDate[0].length;
      archive = archive.slice(0, at) + `\n\n${entries.join('\n\n')}\n` + archive.slice(at);
    } else {
      const nextDate = headings.find(heading => Number.isFinite(Date.parse(heading[1])) && timestamp(heading[1]) < timestamp(date));
      const at = nextDate?.index ?? archive.length;
      const separator = at > 0 && !archive.slice(0, at).endsWith('\n\n') ? '\n\n' : '';
      archive = archive.slice(0, at) + `${separator}# ${date}\n\n${entries.join('\n\n')}\n\n` + archive.slice(at);
    }
  }
  return archive;
}

export async function processQueue(config, options, { fetchBookmarks, invoke }) {
  const limit = options.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  return withQueueLock(config.pendingFile, async () => {
    let pending = recoverQueue(config.pendingFile);
    if (!pending.bookmarks.length || options.forceFetch) {
      await fetchBookmarks(options);
      pending = readQueue(config.pendingFile);
    }
    if (config.aiEnabled !== true) {
      return { success: true, count: 0, pendingCount: pending.count, disabled: true };
    }
    const automatic = config.cliTool === 'opencode' ? config.autoInvokeOpencode : config.autoInvokeClaude;
    if (automatic === false) return { success: true, count: 0, pendingCount: pending.count, disabled: true };

    const original = archiveText(config.archiveFile);
    const existing = archivedIds(original);
    // Recover a crash after archive commit but before queue acknowledgement.
    pending.bookmarks = pending.bookmarks.filter(b => !existing.has(String(b.id)));
    pending.count = pending.bookmarks.length;
    writeJsonAtomic(config.pendingFile, pending);
    const batch = pending.bookmarks.slice(0, limit);
    if (!batch.length) return { success: true, count: 0, pendingCount: 0 };

    const batchDir = fs.mkdtempSync(path.join(path.dirname(config.pendingFile), 'batch-'));
    const inputFile = path.join(batchDir, 'input.json');
    const outputFile = path.join(batchDir, 'output.json');
    writeJsonAtomic(inputFile, { count: batch.length, bookmarks: batch, categories: config.categories });
    // Persist the batch for inspection/retry even when the child fails or is interrupted.
    const result = await invoke({ ...config, batchInputFile: inputFile, batchOutputFile: outputFile }, batch.length, options);
    if (!result.success) return { ...result, count: 0, pendingCount: pending.count, batchDir };

    let output;
    try { output = JSON.parse(fs.readFileSync(outputFile, 'utf8')); }
    catch { return { success: false, count: 0, error: 'AI did not produce valid output JSON; queue preserved', batchDir }; }
    if (!Array.isArray(output.entries)) return { success: false, count: 0, error: 'Missing output entries; queue preserved', batchDir };

    const accepted = new Map();
    const requested = new Set(batch.map(b => String(b.id)));
    for (const entry of output.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id);
      if (!requested.has(id) || accepted.has(id) || typeof entry.markdown !== 'string') continue;
      const ids = archivedIds(entry.markdown);
      if (ids.size !== 1 || !ids.has(id) || (entry.markdown.match(/^## @/gm) || []).length !== 1 || !/^- \*\*What:\*\*\s+\S/m.test(entry.markdown)) continue;
      // Notes are optional; destinations come from trusted category config, never model paths.
      if (entry.note != null) {
        const category = config.categories?.[entry.note.category];
        if (!category?.folder || typeof entry.note.markdown !== 'string' || !entry.note.markdown.trim()) continue;
        const noteFile = path.resolve(category.folder, `${id}.md`);
        const oldNote = archiveText(noteFile);
        if (oldNote && oldNote !== entry.note.markdown) continue;
        writeAtomic(noteFile, entry.note.markdown);
        const relative = path.relative(path.dirname(config.archiveFile), noteFile).split(path.sep).join('/');
        entry.markdown = entry.markdown.replace(/^- \*\*Filed:\*\*.*\n?/gm, '').trim() + `\n- **Filed:** [Note](${encodeURI(relative)})\n`;
      } else if (/^- \*\*Filed:\*\*/m.test(entry.markdown)) {
        continue; // Do not acknowledge an entry pointing to an unverified note.
      }
      accepted.set(id, entry.markdown.trim());
    }
    // Detect unexpected writes by another process before replacing the archive.
    if (archiveText(config.archiveFile) !== original) throw new Error('Archive changed during processing; batch retained and queue preserved');
    if (accepted.size) {
      writeAtomic(config.archiveFile, mergeArchive(original, batch, accepted, config.timezone));
      pending.bookmarks = pending.bookmarks.filter(b => !accepted.has(String(b.id)));
      pending.count = pending.bookmarks.length;
      writeJsonAtomic(config.pendingFile, pending);
    }
    const complete = accepted.size === batch.length;
    return { success: complete, count: accepted.size, pendingCount: pending.count, batchDir, tokenUsage: result.tokenUsage,
      ...(!complete ? { error: `Validated ${accepted.size}/${batch.length} bookmarks; unfinished entries remain pending` } : {}) };
  });
}
