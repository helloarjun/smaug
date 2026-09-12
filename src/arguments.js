export function positiveInteger(value, name) {
  if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

export function parseFetchArgs(args) {
  const positional = [];
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--max-pages') result.maxPages = positiveInteger(args[++i], '--max-pages');
    else if (arg === '--source' || arg === '-s') {
      result.source = args[++i];
      if (!['bookmarks', 'likes', 'both'].includes(result.source)) throw new Error('Invalid --source');
    } else if (['--all', '-a', '-all'].includes(arg)) result.all = true;
    else if (['--force', '-f'].includes(arg)) result.force = true;
    else if (['--media', '-m'].includes(arg)) result.includeMedia = true;
    else if (/^\d+$/.test(arg)) positional.push(arg);
    else throw new Error(`Unknown fetch argument: ${arg}`);
  }
  const counts = positional.filter(value => value.length < 10);
  if (counts.length > 1) throw new Error('Specify only one bookmark count');
  result.count = counts.length ? positiveInteger(counts[0], 'count') : 20;
  const ids = positional.filter(value => value.length >= 10);
  result.specificIds = ids.length ? ids : null;
  return result;
}
