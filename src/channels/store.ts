/**
 * Channel store: loads channels.json, keeps an in-memory map, saves atomically
 * (tmp + rename) and reloads on external file changes (debounced).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { getLogger } from '../util/logger.js';
import type { Channel } from './types.js';

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'channel';
}

class ChannelStore {
  private channels = new Map<string, Channel>();
  private watcher: fs.FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private loaded = false;

  load(): void {
    const cfg = loadConfig();
    const log = getLogger();
    if (!fs.existsSync(cfg.channelsFile)) {
      seedDefaultChannels(cfg.channelsFile);
    }
    const raw = fs.readFileSync(cfg.channelsFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${cfg.channelsFile} must contain a JSON array`);
    this.channels.clear();
    for (const entry of parsed as Channel[]) {
      if (!entry || typeof entry !== 'object') continue;
      const ch = entry as Channel;
      if (!ch.id || !ch.name || !ch.resolver) continue;
      this.channels.set(ch.id.toLowerCase(), { ...ch, id: ch.id });
    }
    this.loaded = true;
    log.info({ count: this.channels.size, file: cfg.channelsFile }, 'channels loaded');
    this.watch();
  }

  /** Seed channels.json from channels.example.json on very first start. */
  private seedDefault(file: string): void {
    seedDefaultChannels(file);
  }

  private watch(): void {
    if (this.watcher) return;
    const cfg = loadConfig();
    try {
      this.watcher = fs.watch(path.dirname(cfg.channelsFile), (_event, filename) => {
        if (filename && path.resolve(path.dirname(cfg.channelsFile), filename) !== path.resolve(cfg.channelsFile)) {
          return;
        }
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          try {
            this.load();
          } catch (err) {
            getLogger().warn({ err: (err as Error).message }, 'channels.json reload failed');
          }
        }, 500);
      });
      this.watcher.on('error', () => {
        /* e.g. dir removed; store still works from memory */
      });
    } catch {
      /* watching is best-effort (some filesystems don't support it) */
    }
  }

  ensureLoaded(): void {
    if (!this.loaded) this.load();
  }

  /** Atomic save: write tmp file, rename over the target. */
  save(list?: Channel[]): void {
    const cfg = loadConfig();
    const data = JSON.stringify(list ?? this.list(), null, 2) + '\n';
    const tmp = cfg.channelsFile + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, cfg.channelsFile);
  }

  list(): Channel[] {
    return [...this.channels.values()];
  }

  get(id: string): Channel | undefined {
    return this.channels.get(id.toLowerCase()) ?? this.channels.get(id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  upsertMany(incoming: Channel[], replace = false): { added: number; updated: number; total: number } {
    this.ensureLoaded();
    if (replace) this.channels.clear();
    let added = 0;
    let updated = 0;
    for (const ch of incoming) {
      const key = ch.id.toLowerCase();
      if (this.channels.has(key)) {
        const existing = this.channels.get(key)!;
        this.channels.set(key, { ...existing, ...ch, id: existing.id });
        updated++;
      } else {
        this.channels.set(key, ch);
        added++;
      }
    }
    this.save();
    return { added, updated, total: this.channels.size };
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }
}

function seedDefaultChannels(file: string): void {
  const log = getLogger();
  try {
    const examplePath = path.resolve('./channels.example.json');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, file);
      log.info({ file }, 'seeded channels.json from channels.example.json');
      return;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not seed channels.json');
  }
  fs.writeFileSync(file, '[]\n');
}

export const store = new ChannelStore();
