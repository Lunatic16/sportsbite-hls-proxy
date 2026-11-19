/**
 * Channel bootstrap: auto-import the channel list at server startup.
 *
 * Why: a fresh install only seeds data/channels.json from the 3-channel
 * channels.example.json, and the real catalog (https://sportsbite.org/channels,
 * ~360 live channels) had to be imported by hand (`npm run import` / POST
 * /api/import) — so out of the box the UI showed a near-empty list and "it
 * should be loading channels from sportsbite.org" looked broken. This hook
 * makes the app load the catalog itself.
 *
 * Semantics (CHANNELS_IMPORT_* env, see .env.example):
 *  - CHANNELS_IMPORT_URL       source to import from. Accepts the same inputs
 *                              as POST /api/import (catalog JSON, M3U/M3U8
 *                              URL, host-local path, channel JSON array).
 *                              "off"/empty disables. Default: the sportsbite
 *                              catalog.
 *  - CHANNELS_IMPORT_MODE      once (default) — import on first start and
 *                              whenever the URL changes (tracked via
 *                              data/channels-import.json); always — import
 *                              at every start; off — never.
 *  - CHANNELS_IMPORT_REPLACE   auto (default) — replace the whole list only
 *                              while channels.json is still the untouched
 *                              example seed (or missing/empty), merge
 *                              otherwise; true/false force it.
 *
 * Failure policy: log a warning and keep serving the existing channels; no
 * marker is written on failure, so the next start retries. The import runs in
 * the background after the server is listening — it never delays boot and
 * never crashes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config';
import { getLogger } from '../logger';
import { importChannels } from './import';

interface ImportMarker {
  url: string;
  at: string;
  mode: string;
  kind: string;
  added: number;
  updated: number;
  total: number;
}

/** Delay after register() so the server binds and serves before we import. */
const BOOTSTRAP_DELAY_MS = 1_000;

function markerFile(): string {
  return path.join(loadConfig().dataDir, 'channels-import.json');
}

function readMarker(file: string): ImportMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ImportMarker;
    if (parsed && typeof parsed.url === 'string') return parsed;
  } catch {
    /* missing / corrupt → treat as "never imported" */
  }
  return undefined;
}

function writeMarker(file: string, marker: ImportMarker): void {
  try {
    fs.writeFileSync(file, JSON.stringify(marker, null, 2) + '\n');
  } catch (err) {
    getLogger().warn(
      { err: (err as Error).message, file },
      'channel bootstrap: could not write the import marker (every start will re-import)',
    );
  }
}

/**
 * True while data/channels.json is still the untouched example seed (or
 * empty/missing) — in "auto" replace mode that is the only case where the
 * import may replace the whole list. Any user-authored list is merged instead.
 */
export function isUntouchedSeed(channelsFile: string): boolean {
  try {
    const cur = fs.readFileSync(channelsFile, 'utf8').trim();
    if (!cur || cur === '[]') return true;
    const example = fs.readFileSync(path.resolve('./channels.example.json'), 'utf8').trim();
    return cur === example;
  } catch {
    return true; // missing file → fresh install
  }
}

export function decideReplace(
  channelsFile: string,
  replace: 'auto' | 'true' | 'false',
): boolean {
  if (replace === 'true') return true;
  if (replace === 'false') return false;
  return isUntouchedSeed(channelsFile);
}

let inFlight: Promise<void> | undefined;

/** Run the bootstrap import once per process (concurrent calls share one run). */
export function runChannelBootstrap(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const cfg = loadConfig();
    const log = getLogger();
    const { channelsImportUrl: url, channelsImportMode: mode, channelsImportReplace: replace } = cfg;

    if (mode === 'off' || !url) {
      log.info({ mode, url: url || '(none)' }, 'channel bootstrap: disabled by config');
      return;
    }

    const marker = readMarker(markerFile());
    if (mode === 'once' && marker?.url === url) {
      log.info(
        { url, importedAt: marker.at, total: marker.total },
        'channel bootstrap: already imported (once mode) — skipping',
      );
      return;
    }

    const doReplace = decideReplace(cfg.channelsFile, replace);
    try {
      log.info(
        { url, mode, replace: doReplace ? 'replace' : 'merge' },
        'channel bootstrap: importing channels',
      );
      const result = await importChannels(url, { replace: doReplace });
      writeMarker(markerFile(), {
        url,
        at: new Date().toISOString(),
        mode,
        kind: result.kind,
        added: result.added,
        updated: result.updated,
        total: result.total,
      });
      log.info(
        { url, kind: result.kind, added: result.added, updated: result.updated, total: result.total },
        'channel bootstrap: import complete',
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message, url },
        'channel bootstrap: import failed — keeping the existing channel list; ' +
          'will retry on next start (manual retry now: POST /api/import {"source":"<url>"})',
      );
    }
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/**
 * Called once from instrumentation.register(). Schedules the import shortly
 * after boot so it never delays the first HTTP response; failures are logged,
 * not thrown.
 */
export function scheduleChannelBootstrap(): void {
  const timer = setTimeout(() => {
    void runChannelBootstrap().catch(() => {
      /* logged inside; also keep an unhandled rejection out of the server */
    });
  }, BOOTSTRAP_DELAY_MS);
  // Never keep the process alive just for the import.
  timer.unref?.();
}
