import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runChannelBootstrap, isUntouchedSeed, decideReplace } from '../src/server/channels/bootstrap';
import { store } from '../src/server/channels/store';
import { resetConfigForTests } from '../src/server/config';

const ROOT = process.cwd();

/** The live catalog payload shape (verified 2026-11 against sportsbite.org). */
const CATALOG = JSON.stringify({
  total: 2,
  online: 2,
  offline: 0,
  source: 'sb',
  channels: [
    {
      id: '247-beinsportsus',
      name: 'beIN SPORTS USA',
      category: 'Sports',
      country: 'USA',
      status: 'online',
      format: 'iframe',
      content_type: 'text/html',
      manifest_url: 'https://sportsbite.org/247-embed/embed/beinsportsus',
      iframe_url: 'https://sportsbite.org/247-embed/embed/beinsportsus',
      logo_url: 'https://l/bein.png',
      browser_playable: true,
    },
    {
      id: '247-sky-sports-main-event',
      name: 'Sky Sports Main Event',
      category: 'Sports',
      status: 'online',
      format: 'iframe',
      logo_url: 'https://l/sky.png',
      browser_playable: true,
    },
  ],
});

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="plain-1" tvg-name="Plain" group-title="News",Plain',
  'https://cdn.example/live/plain.m3u8',
  '#EXTINF:-1 tvg-id="tok-1" tvg-name="Token" group-title="News",Token',
  'https://cdn.example/live/tok.m3u8?token=abc&expires=123',
].join('\n');

let dir: string;

function setEnv(over: Record<string, string>) {
  delete process.env['CHANNELS_IMPORT_URL'];
  delete process.env['CHANNELS_IMPORT_MODE'];
  delete process.env['CHANNELS_IMPORT_REPLACE'];
  process.env['DATA_DIR'] = dir;
  for (const [k, v] of Object.entries(over)) process.env[k] = v;
  resetConfigForTests();
}

/** Seed data/channels.json the way a first start does (copy of the example). */
function seedExampleChannels() {
  fs.copyFileSync(path.join(ROOT, 'channels.example.json'), path.join(dir, 'channels.json'));
}

function readChannelsFile(): unknown[] {
  return JSON.parse(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8'));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-bootstrap-'));
});

afterEach(() => {
  delete process.env['CHANNELS_IMPORT_URL'];
  delete process.env['CHANNELS_IMPORT_MODE'];
  delete process.env['CHANNELS_IMPORT_REPLACE'];
  delete process.env['DATA_DIR'];
  resetConfigForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  store.stopWatching();
});

describe('isUntouchedSeed / decideReplace', () => {
  it('detects the example seed, empty and missing lists; rejects user lists', () => {
    const file = path.join(dir, 'channels.json');
    expect(isUntouchedSeed(file)).toBe(true); // missing
    fs.writeFileSync(file, '[]');
    expect(isUntouchedSeed(file)).toBe(true); // empty
    seedExampleChannels();
    expect(isUntouchedSeed(file)).toBe(true); // untouched example copy
    fs.writeFileSync(file, JSON.stringify([{ id: 'mine', name: 'Mine', resolver: 'static', url: 'http://x' }]));
    expect(isUntouchedSeed(file)).toBe(false); // user-authored
  });

  it('decideReplace honors forced true/false and auto-detects the seed', () => {
    const file = path.join(dir, 'channels.json');
    expect(decideReplace(file, 'true')).toBe(true);
    expect(decideReplace(file, 'false')).toBe(false);
    expect(decideReplace(file, 'auto')).toBe(true); // missing → fresh
    seedExampleChannels();
    expect(decideReplace(file, 'auto')).toBe(true); // seed → replace
    fs.writeFileSync(file, '[{"id":"mine","name":"Mine","resolver":"static"}]');
    expect(decideReplace(file, 'auto')).toBe(false); // user list → merge
  });
});

describe('runChannelBootstrap', () => {
  it('imports the catalog on first start (auto replace of the example seed)', async () => {
    seedExampleChannels();
    const catalogFile = path.join(dir, 'catalog.json');
    fs.writeFileSync(catalogFile, CATALOG);
    setEnv({ CHANNELS_IMPORT_URL: catalogFile, CHANNELS_IMPORT_MODE: 'once' });

    await runChannelBootstrap();

    const channels = readChannelsFile() as Array<{ id: string; resolver: string; options?: Record<string, unknown> }>;
    expect(channels.map((c) => c.id).sort()).toEqual(['247-beinsportsus', '247-sky-sports-main-event']);
    expect(channels[0].resolver).toBe('custom');
    expect(channels[0].options?.['custom']).toBe('sportsbite');

    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'channels-import.json'), 'utf8')) as Record<string, unknown>;
    expect(marker['url']).toBe(catalogFile);
    expect(marker['kind']).toBe('sportsbite-catalog');
    expect(marker['total']).toBe(2);
  });

  it('skips the import in once mode when the marker matches (user edits survive)', async () => {
    const catalogFile = path.join(dir, 'catalog.json');
    fs.writeFileSync(catalogFile, CATALOG);
    seedExampleChannels();
    setEnv({ CHANNELS_IMPORT_URL: catalogFile, CHANNELS_IMPORT_MODE: 'once' });
    await runChannelBootstrap();

    // Simulate the user editing their channel list after the first start.
    const file = path.join(dir, 'channels.json');
    const edited = [{ id: 'mine', name: 'Mine', resolver: 'static', url: 'http://x/mine.m3u8' }];
    fs.writeFileSync(file, JSON.stringify(edited, null, 2));

    await runChannelBootstrap(); // same URL, once mode → skip

    const channels = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(channels).toEqual(edited); // NOT overwritten by a re-import
  });

  it('re-imports in once mode when the URL changes (merge into a user list)', async () => {
    const catalogFile = path.join(dir, 'catalog.json');
    const m3uFile = path.join(dir, 'list.m3u');
    fs.writeFileSync(catalogFile, CATALOG);
    fs.writeFileSync(m3uFile, M3U);
    seedExampleChannels();
    setEnv({ CHANNELS_IMPORT_URL: catalogFile, CHANNELS_IMPORT_MODE: 'once' });
    await runChannelBootstrap();

    // URL change → import again; channels.json is no longer the seed → merge.
    setEnv({ CHANNELS_IMPORT_URL: m3uFile, CHANNELS_IMPORT_MODE: 'once' });
    await runChannelBootstrap();

    const channels = readChannelsFile() as Array<{ id: string }>;
    expect(channels.map((c) => c.id).sort()).toEqual([
      '247-beinsportsus',
      '247-sky-sports-main-event',
      'plain-1',
      'tok-1',
    ]);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'channels-import.json'), 'utf8')) as Record<string, unknown>;
    expect(marker['url']).toBe(m3uFile);
    expect(marker['kind']).toBe('m3u');
  });

  it('keeps the existing list and writes no marker when the import fails', async () => {
    seedExampleChannels();
    const before = fs.readFileSync(path.join(dir, 'channels.json'), 'utf8');
    setEnv({ CHANNELS_IMPORT_URL: path.join(dir, 'does-not-exist.m3u'), CHANNELS_IMPORT_MODE: 'always' });

    await runChannelBootstrap(); // must not throw

    expect(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'channels-import.json'))).toBe(false);
  });

  it('is disabled by CHANNELS_IMPORT_MODE=off or an "off" URL', async () => {
    seedExampleChannels();
    const before = fs.readFileSync(path.join(dir, 'channels.json'), 'utf8');

    setEnv({ CHANNELS_IMPORT_URL: 'off', CHANNELS_IMPORT_MODE: 'once' });
    await runChannelBootstrap();
    expect(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'channels-import.json'))).toBe(false);

    setEnv({ CHANNELS_IMPORT_MODE: 'off' }); // default URL, mode off
    await runChannelBootstrap();
    expect(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'channels-import.json'))).toBe(false);
  });

  it('always mode re-imports on every start and replaces when forced', async () => {
    const catalogFile = path.join(dir, 'catalog.json');
    fs.writeFileSync(catalogFile, CATALOG);
    seedExampleChannels();
    setEnv({
      CHANNELS_IMPORT_URL: catalogFile,
      CHANNELS_IMPORT_MODE: 'always',
      CHANNELS_IMPORT_REPLACE: 'true',
    });
    await runChannelBootstrap();
    await runChannelBootstrap(); // second start, no skip

    const channels = readChannelsFile() as Array<{ id: string }>;
    expect(channels.map((c) => c.id).sort()).toEqual(['247-beinsportsus', '247-sky-sports-main-event']);
  });
});
