'use client';

/**
 * Server status card: uptime, node version, channels, memory, cache stats.
 * Auto-refreshes every 15s while open.
 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { fetchStatus } from '@/lib/api';
import type { StatusInfo } from '@/lib/types';

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function ServerStatus() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchStatus());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Defer the initial fetch to the next tick — keeps the effect free of
    // synchronous setState (react-hooks/set-state-in-effect).
    const initial = window.setTimeout(() => void load(), 0);
    const t = window.setInterval(() => void load(), 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(t);
    };
  }, [open, load]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9" title="Server status" aria-label="Server status">
          <Activity className="h-4.5 w-4.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Activity className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Server status</span>
          <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={() => void load()} aria-label="Refresh status">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {!error && !status && (
          <div className="grid place-items-center py-8">
            <div className="h-7 w-7 animate-spin rounded-full border-4 border-muted border-t-primary" role="status" aria-label="Loading" />
          </div>
        )}
        {status && (
          <div className="space-y-1 px-4 py-3 text-sm">
            <Row label="Version" value={`v${status.version} · Node ${status.node.replace(/^v/, '')}`} />
            <Row label="Uptime" value={fmtUptime(status.uptimeSec)} />
            <Row label="Channels" value={`${status.online} online / ${status.channels} total`} />
            <Row label="Memory" value={`${status.memory.rssMb} MB RSS · ${status.memory.heapMb} MB heap`} />
            <Separator className="my-2" />
            <Row label="Playlist cache" value={`${status.cache.playlists.entries} / ${status.cache.playlists.max}`} />
            <Row
              label="Segment cache"
              value={`${status.cache.segments.entries} (${(status.cache.segments.bytes / 1024 / 1024).toFixed(1)} MB${status.config.segCacheTtlMs ? '' : ' — TTL off'})`}
            />
            <Row label="Resolutions cached" value={String(status.cache.resolutions.entries)} />
            <Separator className="my-2" />
            <Row label="Auth" value={status.config.authRequired ? 'AUTH_TOKEN required' : 'open LAN mode'} />
            <Row
              label="Share tokens"
              value={status.config.shareTokenRequired ? 'required on stream URLs' : 'optional (validated when present)'}
            />
            <Row
              label="Segment cache limit"
              value={`${status.config.segCacheMb} MB${status.config.segCacheTtlMs ? `, ${Math.round(status.config.segCacheTtlMs / 1000)}s TTL` : ''}`}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
