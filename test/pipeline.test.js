import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { processQueue, archivedIds, mergeArchive } from '../src/pipeline.js';
import { recoverQueue, readQueue, writeJsonAtomic, withQueueLock } from '../src/queue.js';
import { fetchBookmarks, prepareBookmarks } from '../src/processor.js';
import { parseFetchArgs } from '../src/arguments.js';
import { loadConfig } from '../src/config.js';
import { getCLISettings, invokeAICLI, run } from '../src/job.js';

function fixture(t, count = 8) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smaug-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { aiEnabled: true, cliTool: 'claude', projectRoot: root,
    archiveFile: path.join(root, 'archive.md'), pendingFile: path.join(root, 'pending.json'),
    categories: { article: { folder: path.join(root, 'notes') } } };
  const bookmarks = Array.from({ length: count }, (_, i) => ({ id: String(i + 100), author: 'user', tweetUrl: `https://x.com/user/status/${i + 100}` }));
  writeJsonAtomic(config.pendingFile, { bookmarks, count });
  fs.writeFileSync(config.archiveFile, '# My existing archive\n');
  return { config, bookmarks, root };
}

const entry = b => ({ id: b.id, markdown: `## @user - Saved item\n\n- **Tweet:** ${b.tweetUrl}\n- **What:** A useful summary.\n` });
const noFetch = async () => { throw new Error('Unexpected fetch'); };
function model(transform = x => x) {
  return async config => {
    const input = JSON.parse(fs.readFileSync(config.batchInputFile, 'utf8'));
    writeJsonAtomic(config.batchOutputFile, { entries: transform(input.bookmarks.map(entry)) });
    return { success: true };
  };
}

test('cost gate prevents any invocation and preserves the queue', async t => {
  const { config } = fixture(t);
  config.aiEnabled = false;
  const before = fs.readFileSync(config.pendingFile, 'utf8');
  let fetched = false;
  const result = await processQueue(config, {}, { fetchBookmarks: async () => { fetched = true; }, invoke: noFetch });
  assert.equal(result.disabled, true);
  assert.equal(fetched, true);
  assert.equal(fs.readFileSync(config.pendingFile, 'utf8'), before);
});

test('old Haiku configuration remains disabled unless explicitly opted in', t => {
  const { root } = fixture(t);
  const file = path.join(root, 'config.json');
  writeJsonAtomic(file, { autoInvokeClaude: true, claudeModel: 'haiku', projectRoot: root });
  const config = loadConfig(file);
  assert.equal(config.aiEnabled, false);
  assert.equal(config.archiveFile, path.join(root, 'bookmarks.md'));
});

test('default batch is five and existing archive bytes are preserved', async t => {
  const { config } = fixture(t);
  const result = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: model() });
  assert.equal(result.success, true);
  assert.equal(result.count, 5);
  assert.equal(readQueue(config.pendingFile).count, 3);
  assert.ok(fs.readFileSync(config.archiveFile, 'utf8').startsWith('# My existing archive\n'));
});

test('limit is enforced after fetching into an empty queue', async t => {
  const { config } = fixture(t, 0);
  let invokedCount;
  const invoke = model();
  const result = await processQueue(config, { limit: 2 }, {
    fetchBookmarks: async () => writeJsonAtomic(config.pendingFile, { bookmarks: [100, 101, 102].map(id => ({ id: String(id), tweetUrl: `https://x.com/user/status/${id}` })) }),
    invoke: (cfg, count) => { invokedCount = count; return invoke(cfg); }
  });
  assert.equal(invokedCount, 2);
  assert.equal(result.pendingCount, 1);
});

test('partial success only acknowledges verified entries', async t => {
  const { config } = fixture(t, 3);
  const result = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: model(entries => entries.slice(0, 1)) });
  assert.equal(result.success, false);
  assert.equal(result.count, 1);
  assert.deepEqual(readQueue(config.pendingFile).bookmarks.map(b => b.id), ['101', '102']);
});

test('exit zero without an output file never clears the queue', async t => {
  const { config } = fixture(t);
  const result = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: async () => ({ success: true }) });
  assert.equal(result.success, false);
  assert.equal(readQueue(config.pendingFile).count, 8);
});

test('failed child keeps the entire queue even if it wrote output', async t => {
  const { config } = fixture(t);
  await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: async cfg => {
    await model()(cfg); return { success: false, error: 'timeout' };
  } });
  assert.equal(readQueue(config.pendingFile).count, 8);
  assert.equal(fs.readFileSync(config.archiveFile, 'utf8'), '# My existing archive\n');
});

test('thrown child errors leave queue and release lock', async t => {
  const { config } = fixture(t);
  await assert.rejects(processQueue(config, {}, { fetchBookmarks: noFetch, invoke: noFetch }));
  assert.equal(readQueue(config.pendingFile).count, 8);
  assert.equal(fs.existsSync(`${config.pendingFile}.lock`), false);
});

test('legacy full backup is merged before limiting without losing new IDs', async t => {
  const { config, bookmarks } = fixture(t, 4);
  writeJsonAtomic(`${config.pendingFile}.full`, { bookmarks: bookmarks.slice(0, 3) });
  writeJsonAtomic(config.pendingFile, { bookmarks: [bookmarks[0], bookmarks[3]] });
  await processQueue(config, { limit: 1 }, { fetchBookmarks: noFetch, invoke: model() });
  assert.deepEqual(readQueue(config.pendingFile).bookmarks.map(b => b.id), ['101', '102', '103']);
  assert.equal(fs.existsSync(`${config.pendingFile}.full`), false);
});

test('malformed queue is preserved instead of replaced', async t => {
  const { config } = fixture(t);
  fs.writeFileSync(config.pendingFile, '{broken');
  await assert.rejects(processQueue(config, {}, { fetchBookmarks: noFetch, invoke: noFetch }));
  assert.equal(fs.readFileSync(config.pendingFile, 'utf8'), '{broken');
});

test('corrupt legacy backup is retained for manual recovery', t => {
  const { config } = fixture(t);
  fs.writeFileSync(`${config.pendingFile}.full`, 'oops');
  assert.throws(() => recoverQueue(config.pendingFile));
  assert.equal(readQueue(config.pendingFile).count, 8);
  assert.equal(fs.readFileSync(`${config.pendingFile}.full`, 'utf8'), 'oops');
});

test('simultaneous queue writers fail closed', async t => {
  const { config } = fixture(t);
  await withQueueLock(config.pendingFile, async () => {
    await assert.rejects(withQueueLock(config.pendingFile, noFetch), /Queue is locked/);
  });
});

test('restart after archive commit does not reprocess archived IDs', async t => {
  const { config, bookmarks } = fixture(t, 1);
  fs.writeFileSync(config.archiveFile, entry(bookmarks[0]).markdown);
  const result = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: noFetch });
  assert.equal(result.success, true);
  assert.equal(readQueue(config.pendingFile).count, 0);
});

test('quoted tweet links cannot acknowledge a bookmark', () => {
  assert.deepEqual([...archivedIds('- **Quoted:** https://x.com/user/status/100')], []);
});

test('dated entries retain archive date ordering and existing sections', () => {
  const original = '# Sunday, March 8, 2026\n\nExisting March 8 entry\n\n# Friday, March 6, 2026\n\nExisting March 6 entry\n';
  const batch = [
    { id: '1', date: 'Saturday, March 7, 2026' },
    { id: '2', date: 'Sunday, March 8, 2026' },
    { id: '3', date: 'Monday, March 9, 2026' }
  ];
  const output = mergeArchive(original, batch, new Map([['1', 'New March 7'], ['2', 'New March 8'], ['3', 'New March 9']]));
  assert.deepEqual([...output.matchAll(/^# (.+)$/gm)].map(m => m[1]), [
    'Monday, March 9, 2026', 'Sunday, March 8, 2026', 'Saturday, March 7, 2026', 'Friday, March 6, 2026'
  ]);
  assert.ok(output.includes('Existing March 8 entry\n\n'));
  assert.ok(output.endsWith('Existing March 6 entry\n'));
  assert.ok(output.indexOf('New March 8') < output.indexOf('Existing March 8 entry'));
});

test('unrequested, malformed and missing-summary entries stay unacknowledged', async t => {
  const { config } = fixture(t, 2);
  const result = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: model(entries => [null, entry({ id: '999', tweetUrl: 'https://x.com/user/status/999' }), { ...entries[0], markdown: entries[0].markdown.replace('- **What:** A useful summary.', '') }]) });
  assert.equal(result.count, 0);
  assert.equal(readQueue(config.pendingFile).count, 2);
});

test('notes are saved by Node using a configured directory and bookmark ID', async t => {
  const { config } = fixture(t, 1);
  const result = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: model(entries => entries.map(e => ({ ...e, note: { category: 'article', markdown: '# A useful note', path: '../../escape.md' } }))) });
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(path.join(config.categories.article.folder, '100.md'), 'utf8'), '# A useful note');
  assert.match(fs.readFileSync(config.archiveFile, 'utf8'), /notes\/100.md/);
});

test('conflicting existing note is preserved and bookmark stays pending', async t => {
  const { config } = fixture(t, 1);
  fs.mkdirSync(config.categories.article.folder);
  const note = path.join(config.categories.article.folder, '100.md');
  fs.writeFileSync(note, 'Existing work');
  const result = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: model(entries => entries.map(e => ({ ...e, note: { category: 'article', markdown: 'Different work' } }))) });
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(note, 'utf8'), 'Existing work');
  assert.equal(readQueue(config.pendingFile).count, 1);
});

test('unexpected archive changes are not overwritten', async t => {
  const { config } = fixture(t, 1);
  await assert.rejects(processQueue(config, {}, { fetchBookmarks: noFetch, invoke: async cfg => {
    await model()(cfg); fs.writeFileSync(config.archiveFile, 'User edit'); return { success: true };
  } }), /Archive changed/);
  assert.equal(fs.readFileSync(config.archiveFile, 'utf8'), 'User edit');
  assert.equal(readQueue(config.pendingFile).count, 1);
});

test('real fetchBookmarks retains all pages only with explicit all', () => {
  const tweets = Array.from({ length: 30 }, (_, id) => ({ id: String(id) }));
  const deps = { execFileSync: (_binary, args, options) => {
    assert.ok(args.includes('--json'));
    fs.writeSync(options.stdio[1], JSON.stringify({ tweets, nextCursor: 'cursor' }));
  } };
  assert.equal(fetchBookmarks({}, 20, { all: true }, deps).length, 30);
  assert.equal(fetchBookmarks({}, 20, {}, deps).length, 20);
});

test('max-pages is not confused with positional count', () => {
  const args = parseFetchArgs(['--all', '--max-pages', '100']);
  assert.equal(args.count, 20);
  assert.equal(args.maxPages, 100);
  assert.equal(args.all, true);
  assert.throws(() => parseFetchArgs(['--max-pages', '-1']));
  assert.throws(() => parseFetchArgs(['--max-pages']));
});

test('runner uses injected AI in isolation and enforces cost gate', async t => {
  const { config } = fixture(t, 1);
  config.aiEnabled = false;
  const result = await run({}, { config, fetchBookmarks: async () => {}, invoke: noFetch });
  assert.equal(result.disabled, true);
});

test('OpenCode has no implicit model fallback', () => {
  assert.throws(() => getCLISettings('opencode', {}, 1), /Set opencodeModel explicitly/);
});

test('model prompt uses the actual batch paths and disables Claude subagent tools', () => {
  const settings = getCLISettings('claude', { batchInputFile: '/tmp/custom/input.json', batchOutputFile: '/tmp/custom/output.json' }, 1);
  assert.match(settings.args.at(-1), /\/tmp\/custom\/input.json/);
  assert.match(settings.args.at(-1), /\/tmp\/custom\/output.json/);
  assert.equal(settings.args[settings.args.indexOf('--tools') + 1], 'Read,Write');
  assert.ok(settings.args.includes('--restricted'));
  assert.ok(settings.args.includes('--bare'));
});

test('OpenCode agent permissions allow only the two staged files', () => {
  const settings = getCLISettings('opencode', { opencodeModel: 'mock/model', batchInputFile: '/tmp/batch/input.json', batchOutputFile: '/tmp/batch/output.json' }, 1);
  const configured = JSON.parse(settings.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(configured.agent.smaug.permission['*'], 'deny');
  assert.equal(configured.agent.smaug.permission.read['/tmp/batch/input.json'], 'allow');
  assert.equal(configured.agent.smaug.permission.edit['/tmp/batch/output.json'], 'allow');
  assert.equal(configured.agent.smaug.permission.edit['*'], 'deny');
  assert.equal(settings.args[settings.args.indexOf('--model') + 1], 'mock/model');
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}
const fakeSettings = { binary: 'mock-only', args: [], env: {}, stdin: 'ignore', shell: false, model: 'mock' };

test('disabled processing continues merging new fetches into a nonempty queue', async t => {
  const { config } = fixture(t, 1);
  config.aiEnabled = false;
  const result = await processQueue(config, {}, { invoke: noFetch, fetchBookmarks: async () => {
    const pending = readQueue(config.pendingFile);
    pending.bookmarks.push({ id: '200', tweetUrl: 'https://x.com/user/status/200' });
    writeJsonAtomic(config.pendingFile, pending);
  } });
  assert.equal(result.disabled, true);
  assert.equal(result.pendingCount, 2);
});

test('fetch --force preserves reprocessing intent through run and crash recovery', async t => {
  const { config, bookmarks, root } = fixture(t, 1);
  config.stateFile = path.join(root, 'state.json');
  fs.writeFileSync(config.archiveFile, entry(bookmarks[0]).markdown);
  await prepareBookmarks({ config, force: true }, { fetchFromSource: () => [{ ...bookmarks[0], author: { username: 'user' }, text: 'Saved tweet' }] });
  const forcedQueue = readQueue(config.pendingFile);
  assert.ok(forcedQueue.bookmarks[0].reprocessToken);
  let calls = 0;
  const result = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: async cfg => { calls++; return model()(cfg); } });
  assert.equal(result.success, true);
  assert.equal(calls, 1);
  const archive = fs.readFileSync(config.archiveFile, 'utf8');
  assert.equal((archive.match(/\*\*Tweet:\*\*/g) || []).length, 1);
  assert.match(archive, /Reprocessed bookmark/);
  writeJsonAtomic(config.pendingFile, forcedQueue); // Crash before acknowledgement.
  const retry = await processQueue(config, {}, { fetchBookmarks: noFetch, invoke: noFetch });
  assert.equal(retry.count, 0);
  assert.equal(readQueue(config.pendingFile).count, 0);
});

test('zero-count child failures send a failure notification', async t => {
  const { config } = fixture(t, 1);
  const notices = [];
  const result = await run({}, { config, fetchBookmarks: noFetch,
    invoke: async () => ({ success: false, error: 'Provider failed' }), notify: async (...args) => notices.push(args) });
  assert.equal(result.count, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][3], false);
  assert.match(notices[0][2], /Provider failed/);
});

test('caught queue errors also send a failure notification', async t => {
  const { config } = fixture(t, 1);
  fs.writeFileSync(config.pendingFile, '{broken');
  const notices = [];
  const result = await run({}, { config, fetchBookmarks: noFetch, invoke: noFetch, notify: async (...args) => notices.push(args) });
  assert.equal(result.success, false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][3], false);
});

test('AI error result without trailing newline fails even on exit zero', async () => {
  const child = fakeChild();
  const result = invokeAICLI({}, 1, {}, { settings: fakeSettings, spawn: () => child });
  child.stdout.emit('data', Buffer.from('{"type":"res'));
  child.stdout.emit('data', Buffer.from('ult","is_error":true,"result":"quota"}'));
  child.emit('close', 0);
  assert.equal((await result).success, false);
  assert.equal((await result).error, 'quota');
});

test('timeout does not resolve until child closes', async () => {
  const child = fakeChild();
  let killed;
  const killObserved = new Promise(resolve => { child.kill = signal => { killed = signal; resolve(); }; });
  let resolved = false;
  const result = invokeAICLI({ claudeTimeout: 5 }, 1, {}, { settings: fakeSettings, spawn: () => child }).then(value => { resolved = true; return value; });
  await killObserved;
  assert.equal(killed, 'SIGTERM');
  assert.equal(resolved, false);
  child.emit('close', 0);
  assert.match((await result).error, /Timeout/);
});

test('OpenCode error events are not treated as successful output', async () => {
  const child = fakeChild();
  const result = invokeAICLI({}, 1, {}, { settings: fakeSettings, spawn: () => child });
  child.stdout.emit('data', Buffer.from('{"type":"error","error":{"message":"provider unavailable"}}\n'));
  child.emit('close', 0);
  assert.equal((await result).error, 'provider unavailable');
});
