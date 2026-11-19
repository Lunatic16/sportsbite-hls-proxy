'use client';

/**
 * Channel sidebar: search, group filter, online-only chip, scrollable list
 * with live status dots and per-row status checks.
 */
import { useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewer, visibleChannels } from '@/lib/store';
import { cn } from '@/lib/utils';
import { runChecks } from './checks';

export function ChannelList() {
  const channels = useViewer((s) => s.channels);
  const loading = useViewer((s) => s.loadingChannels);
  const error = useViewer((s) => s.channelsError);
  const search = useViewer((s) => s.search);
  const setSearch = useViewer((s) => s.setSearch);
  const group = useViewer((s) => s.group);
  const setGroup = useViewer((s) => s.setGroup);
  const onlineOnly = useViewer((s) => s.onlineOnly);
  const setOnlineOnly = useViewer((s) => s.setOnlineOnly);
  const currentId = useViewer((s) => s.currentId);
  const checkAllActive = useViewer((s) => s.checkAllActive);

  const groups = useMemo(
    () => [...new Set(channels.map((c) => c.group))].sort((a, b) => a.localeCompare(b)),
    [channels],
  );
  const vis = useMemo(() => visibleChannels(useViewer.getState()), [channels, search, group, onlineOnly]);

  const [checkingRow, setCheckingRow] = useState<string | null>(null);

  const checkOne = async (id: string) => {
    setCheckingRow(id);
    try {
      await runChecks([id], 1, (result) => {
        useViewer.getState().patchChannel(result.id, {
          status: result.status,
          lastChecked: new Date().toISOString(),
        });
      });
    } finally {
      setCheckingRow(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="channel-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search channels"
            aria-label="Search channels"
            autoComplete="off"
            className="pr-9"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setSearch('')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Badge variant="outline" className="shrink-0 tabular-nums text-muted-foreground">
          {vis.length}/{channels.length}
        </Badge>
      </div>

      <div className="flex items-center gap-2">
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger className="h-9 min-w-0 flex-1" aria-label="Group filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="__all">All groups ({channels.length})</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g} value={g}>{g}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={onlineOnly ? 'default' : 'outline'}
          size="sm"
          className="h-9 shrink-0"
          aria-pressed={onlineOnly}
          onClick={() => setOnlineOnly(!onlineOnly)}
          title="Only show channels that are online"
        >
          <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', onlineOnly ? 'bg-primary-foreground' : 'bg-primary')} />
          Online
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-lg border bg-card/40 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <div role="listbox" aria-label="Channels" className="w-full divide-y divide-border/60">
          {loading && channels.length === 0 && (
            <div className="p-0">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3">
                  <Skeleton className="h-9 w-14 rounded-md" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && channels.length === 0 && !error && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">No channels yet</p>
              <p>Import a playlist or reload to try again.</p>
            </div>
          )}

          {!loading && error && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <p className="mb-1 font-medium text-destructive">Could not load channels</p>
              <p className="whitespace-pre-wrap">{error}</p>
            </div>
          )}

          {!loading && channels.length > 0 && vis.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">No channels match</p>
              <p>Try clearing the search or filters{onlineOnly ? ', or run a status check' : ''}.</p>
            </div>
          )}

          {vis.map((ch) => (
            <ChannelRow
              key={ch.id}
              id={ch.id}
              name={ch.name}
              group={ch.group}
              logo={ch.logo}
              status={ch.status}
              active={ch.id === currentId}
              checking={checkingRow === ch.id || (checkAllActive && ch.status === 'checking')}
              onSelect={() => window.dispatchEvent(new CustomEvent('sp-play', { detail: ch.id }))}
              onCheck={() => void checkOne(ch.id)}
            />
          ))}
        </div>
      </ScrollArea>

      <p className="px-1 text-xs text-muted-foreground" aria-live="polite">
        {error ? '' : `${vis.length} of ${channels.length} channels`}
      </p>
    </div>
  );
}

function ChannelRow({
  id, name, group, logo, status, active, checking, onSelect, onCheck,
}: {
  id: string;
  name: string;
  group: string;
  logo?: string;
  status: string;
  active: boolean;
  checking: boolean;
  onSelect: () => void;
  onCheck: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-id={id}
      className={cn(
        'group relative flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60',
      )}
      onClick={onSelect}
    >
      {active && <span className="absolute inset-y-2 left-0 w-1 rounded-r bg-primary" aria-hidden />}
      <span className="grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-border/60 bg-background/60 text-xs font-extrabold tracking-wide text-primary">
        {logo ? (
           
          <img src={logo} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain p-1" />
        ) : (
          initials(name)
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-semibold', status === 'offline' && 'text-muted-foreground')}>{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{group}</span>
      </span>
      <button
        type="button"
        aria-label={`Check status of ${name}`}
        title="Check status"
        className="hidden h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground group-hover:grid"
        onClick={(e) => {
          e.stopPropagation();
          onCheck();
        }}
      >
        {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      </button>
      <StatusDot status={status} />
    </div>
  );
}

export function StatusDot({ status }: { status: string }) {
  if (status === 'checking') {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="checking" />;
  }
  return (
    <span
      className={cn(
        'h-2.5 w-2.5 shrink-0 rounded-full',
        status === 'online' && 'bg-primary shadow-[0_0_0_3px] shadow-primary/15',
        status === 'offline' && 'bg-destructive',
        status === 'unknown' && 'bg-muted-foreground/40',
      )}
      title={status}
      aria-label={status}
    />
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const second = words[1] ?? '';
  return (words.length === 1 ? first.slice(0, 2) : first.charAt(0) + second.charAt(0)).toUpperCase();
}
