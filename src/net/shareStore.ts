/**
 * Per-channel share-token secrets, persisted at DATA_DIR/tokens.json.
 * Rotating a channel's secret invalidates its old share links.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { getLogger } from '../util/logger.js';
import { randomSecret } from '../net/sign.js';

interface TokenFile {
  secrets: Record<string, string>;
}

const fileData: TokenFile = { secrets: {} };
let loaded = false;

function tokensFile(): string {
  return path.join(loadConfig().dataDir, 'tokens.json');
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const file = tokensFile();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TokenFile>;
      if (parsed.secrets && typeof parsed.secrets === 'object') {
        Object.assign(fileData.secrets, parsed.secrets);
      }
    }
  } catch (err) {
    getLogger().warn({ err: (err as Error).message }, 'tokens.json unreadable; starting fresh');
  }
}

function persist(): void {
  const file = tokensFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fileData, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function getChannelSecret(channelId: string): string {
  load();
  let secret = fileData.secrets[channelId];
  if (!secret) {
    secret = randomSecret();
    fileData.secrets[channelId] = secret;
    persist();
  }
  return secret;
}

/** Rotate: new secret → all previously issued links for this channel die. */
export function rotateChannelSecret(channelId: string): string {
  load();
  const secret = randomSecret();
  fileData.secrets[channelId] = secret;
  persist();
  return secret;
}
