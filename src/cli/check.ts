/** CLI: npm run check [-- --limit=N] [--group=Sports] [--id=247-beinsportsus] [--concurrency=5]
 *
 * Flags may be passed as `--flag value` or `--flag=value`.
 *
 * Probes every channel: resolve → GET the playlist → read the first ~2KB of
 * the first segment (immediately after the playlist — segment tokens are
 * short-lived). Marks channels online/offline in channels.json. Treats
 * HTTP 503 (cinevid, upstream rate-limits) as offline for that run.
 * Note: a full 1000+ channel sweep is aggressive — the origin rate-limits
 * (HTTP 503); use --group/--id for targeted checks or lower --concurrency.
 */
import { loadConfig } from '../config.js';
import { store } from '../channels/store.js';
import { resolveChannel, invalidateResolution } from '../resolvers/index.js';
import { fetchUpstream, readBodyWithCap, UpstreamError } from '../net/fetchUpstream.js';
import type { Channel } from '../channels/types.js';

interface CheckResult {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

function parseFirstSegmentUrl(playlist: string): string | undefined {
  for (const line of playlist.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return undefined;
}

/** Read up to `max` bytes of the body, then stop — never a size error. */
async function readHead(body: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const onData = (chunk: Uint8Array | Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total >= max) finish();
    };
    const onEnd = () => finish();
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    function cleanup(): void {
      if (done) return;
      done = true;
      body.off('data', onData);
      body.off('end', onEnd);
      body.off('error', onError);
    }
    function finish(): void {
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    body.on('data', onData);
    body.on('end', onEnd);
    body.on('error', onError);
  });
}

async function probeChannel(channel: Channel): Promise<CheckResult> {
  const started = Date.now();
  try {
    invalidateResolution(channel.id);
    const resolved = await resolveChannel(channel);
    const res = await fetchUpstream(resolved.url, {
      headers: resolved.headers,
      timeoutMs: 8000,
    });
    if (res.status !== 200) {
      await res.body.dump().catch(() => {});
      return { id: channel.id, name: channel.name, ok: false, detail: `playlist HTTP ${res.status}`, ms: Date.now() - started };
    }
    const body = await readBodyWithCap(res.body, 512 * 1024);
    const text = body.toString('utf8');
    if (!text.includes('#EXTM3U')) {
      let detail = 'no #EXTM3U in response';
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) detail = `upstream: ${j.error}`;
      } catch {
        /* not JSON */
      }
      return { id: channel.id, name: channel.name, ok: false, detail, ms: Date.now() - started };
    }
    const segRaw = parseFirstSegmentUrl(text);
    if (!segRaw) {
      return { id: channel.id, name: channel.name, ok: false, detail: 'playlist has no segment URI', ms: Date.now() - started };
    }
    // Resolve relative URIs against the final (post-redirect) playlist URL.
    let segUrl = segRaw;
    try {
      segUrl = new URL(segRaw, res.finalUrl).toString();
    } catch {
      /* keep raw — fetchUpstream will report a clear error */
    }
    // Master playlist: the first URI is a variant playlist — follow it once.
    if (text.includes('#EXT-X-STREAM-INF')) {
      const variant = await fetchUpstream(segUrl, { headers: resolved.headers, timeoutMs: 8000 });
      if (variant.status !== 200) {
        await variant.body.dump().catch(() => {});
        return { id: channel.id, name: channel.name, ok: false, detail: `variant HTTP ${variant.status}`, ms: Date.now() - started };
      }
      const vtext = (await readBodyWithCap(variant.body, 512 * 1024)).toString('utf8');
      const vSeg = parseFirstSegmentUrl(vtext);
      if (!vSeg) {
        return { id: channel.id, name: channel.name, ok: false, detail: 'variant playlist has no segment URI', ms: Date.now() - started };
      }
      segUrl = new URL(vSeg, variant.finalUrl).toString();
    }
    // Read just the head of the first segment (immediately after the
    // playlist — segment tokens are short-lived).
    const seg = await fetchUpstream(segUrl, {
      headers: { ...resolved.headers, referer: undefined, origin: undefined },
      timeoutMs: 8000,
    });
    if (seg.status !== 200 && seg.status !== 206) {
      await seg.body.dump().catch(() => {});
      return { id: channel.id, name: channel.name, ok: false, detail: `segment HTTP ${seg.status}`, ms: Date.now() - started };
    }
    const head = await readHead(seg.body, 2048);
    await seg.body.dump().catch(() => {});
    // 0x47 raw TS | 0x89 PNG wrapper | 0xff/0x52 image wrappers | 0x00 fMP4
    const looksTs = head.length > 0 && [0x47, 0x89, 0xff, 0x52, 0x00].includes(head[0]);
    return {
      id: channel.id,
      name: channel.name,
      ok: looksTs,
      detail: looksTs ? 'ok' : `segment bytes unrecognized (0x${head[0]?.toString(16) ?? '?'})`,
      ms: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof UpstreamError) {
      return { id: channel.id, name: channel.name, ok: false, detail: `HTTP ${err.status ?? '?'} ${err.message}`, ms: Date.now() - started };
    }
    return { id: channel.id, name: channel.name, ok: false, detail: (err as Error).message, ms: Date.now() - started };
  }
}

async function main(): Promise<void> {
  loadConfig();
  store.ensureLoaded();
  const args = process.argv.slice(2);
  const getOpt = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limit = Number(getOpt('limit') ?? 0);
  const group = getOpt('group')?.toLowerCase();
  const singleId = getOpt('id');
  const concurrency = Math.max(1, Number(getOpt('concurrency') ?? 5));

  let channels = store.list();
  if (singleId) channels = channels.filter((c) => c.id === singleId);
  if (group) channels = channels.filter((c) => (c.group ?? '').toLowerCase() === group);
  if (limit > 0) channels = channels.slice(0, limit);

  console.log(`probing ${channels.length} channels (concurrency ${concurrency})...`);
  const results: CheckResult[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < channels.length) {
      const ch = channels[index++];
      const r = await probeChannel(ch);
      results.push(r);
      const mark = r.ok ? '✓' : '✗';
      console.log(` ${mark} ${r.id.padEnd(32)} ${r.detail} (${r.ms}ms)`);
      const stored = store.get(r.id);
      if (stored) {
        stored.status = r.ok ? 'online' : 'offline';
        stored.lastChecked = new Date().toISOString();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, worker));
  store.save();

  const online = results.filter((r) => r.ok).length;
  console.log(`\ndone: ${online}/${results.length} online — saved to channels.json`);
  store.stopWatching();
  process.exit(0);
}

main().catch((err) => {
  console.error(`check failed: ${(err as Error).message}`);
  process.exit(1);
});
