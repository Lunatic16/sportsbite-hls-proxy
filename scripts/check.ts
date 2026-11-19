/**
 * CLI: bun run check [-- --limit=N] [--group=Sports] [--id=247-beinsportsus] [--concurrency=5]
 *
 * Flags may be passed as `--flag value` or `--flag=value`.
 *
 * Probes every channel (resolve → playlist → first segment head) and marks
 * channels online/offline in channels.json. The same probe powers the UI's
 * status dots via POST /api/check — the CLI is for host-side/CI use.
 */
import 'dotenv/config';
import { store } from '../src/server/channels/store';
import { checkChannels } from '../src/server/probe';

function getOpt(name: string): string | undefined {
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  store.ensureLoaded();
  const limit = Number(getOpt('limit') ?? 0);
  const group = getOpt('group')?.toLowerCase();
  const singleId = getOpt('id');
  const concurrency = Math.max(1, Number(getOpt('concurrency') ?? 5));

  let channels = store.list();
  if (singleId) channels = channels.filter((c) => c.id === singleId);
  if (group) channels = channels.filter((c) => (c.group ?? '').toLowerCase() === group);
  if (limit > 0) channels = channels.slice(0, limit);

  console.log(`probing ${channels.length} channels (concurrency ${concurrency})...`);
  const results = await checkChannels(channels, concurrency, (r) => {
    const mark = r.ok ? '✓' : '✗';
    console.log(` ${mark} ${r.id.padEnd(32)} ${r.detail} (${r.ms}ms)`);
  });

  const online = results.filter((r) => r.ok).length;
  console.log(`\ndone: ${online}/${results.length} online — saved to channels.json`);
  store.stopWatching();
  process.exit(0);
}

main().catch((err) => {
  console.error(`check failed: ${(err as Error).message}`);
  process.exit(1);
});
