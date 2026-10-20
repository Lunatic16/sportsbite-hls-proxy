/**
 * Shared test setup: deterministic env before any module import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env['NODE_ENV'] = 'test';
process.env['PROXY_SECRET'] = 'unit-test-secret-0123456789abcdef';
process.env['DATA_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hls-test-'));
process.env['CACHE_TTL_PLAYLIST_MS'] = '0';
process.env['CACHE_TTL_VOD_MS'] = '0';
process.env['SEG_CACHE_TTL_MS'] = '0';
process.env['SHARE_TOKEN_TTL'] = '0';
