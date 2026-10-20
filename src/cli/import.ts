/** CLI: npm run import -- <file-or-url> [--replace] [--as-m3u-source] */
import { importChannels } from '../channels/import.js';
import { store } from '../channels/store.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

if (positional.length !== 1) {
  console.error('Usage: npm run import -- <file-or-url> [--replace] [--as-m3u-source]');
  console.error('  <file-or-url>  M3U/M3U8 playlist, sportsbite.org/channels catalog, or channels JSON');
  console.error('  --replace      replace the whole channel list instead of merging');
  console.error('  --as-m3u-source  keep the M3U file and create m3u-source channels (dynamic lookup)');
  process.exit(1);
}

try {
  const result = await importChannels(positional[0], {
    replace: flags.has('--replace'),
    asM3uSource: flags.has('--as-m3u-source'),
  });
  console.log(
    `imported (${result.kind}): +${result.added} added, ${result.updated} updated, ${result.total} total channels`,
  );
  store.stopWatching();
  process.exit(0);
} catch (err) {
  console.error(`import failed: ${(err as Error).message}`);
  process.exit(1);
}
