/**
 * Per-channel share-token secrets, persisted at DATA_DIR/tokens.json.
 * Rotating a channel's secret invalidates its old share links.
 * Memoized on globalThis so all route bundles share one file buffer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { getLogger } from './logger';
import { randomSecret } from './sign';

interface TokenFile {
  secrets: Record<string, string>;
}

interface GlobalState {
  __iptvShareStore?: { data: TokenFile; loaded: boolean };
}

const g = globalThis as unknown as GlobalState;

function state(): { data: TokenFile; loaded: boolean } {
  if (!g.__iptvShareStore) g.__iptvShareStore = { data: { secrets: {} }, loaded: false };
  return g.__iptvShareStore;
}

function tokensFile(): string {
  return path.join(loadConfig().dataDir, 'tokens.json');
}

function load(): void {
  const s = state();
  if (s.loaded) return;
  s.loaded = true;
  const file = tokensFile();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TokenFile>;
      if (parsed.secrets && typeof parsed.secrets === 'object') {
        Object.assign(s.data.secrets, parsed.secrets);
      }
    }
  } catch (err) {
    getLogger().warn({ err: (err as Error).message }, 'tokens.json unreadable; starting fresh');
  }
}

function persist(): void {
  const file = tokensFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state().data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function getChannelSecret(channelId: string): string {
  load();
  const s = state();
  let secret = s.data.secrets[channelId];
  if (!secret) {
    secret = randomSecret();
    s.data.secrets[channelId] = secret;
    persist();
  }
  return secret;
}

/** Rotate: new secret → all previously issued links for this channel die. */
export function rotateChannelSecret(channelId: string): string {
  load();
  const secret = randomSecret();
  state().data.secrets[channelId] = secret;
  persist();
  return secret;
}
