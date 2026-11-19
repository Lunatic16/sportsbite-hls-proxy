'use client';

/**
 * Viewer shell: header (brand, search hint, playlist URL, check-all, status,
 * reload), sidebar + player layout (desktop side-by-side, mobile stacked),
 * dialogs, keyboard shortcut wiring, token flow and auto status checks.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Copy, ListTree, PanelLeftClose, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewer, prefs } from '@/lib/store';
import { currentToken, fetchChannels, reloadChannels, setTokenProvider, ApiError } from '@/lib/api';
import { toast } from 'sonner';
import { ChannelList } from './channel-list';
import { Player } from './player';
import { ShareDialog } from './share-dialog';
import { TokenDialog } from './token-dialog';
import { ServerStatus } from './server-status';
import { runChecks } from './checks';
import { cn } from '@/lib/utils';

export function Viewer() {
  const token = useViewer((s) => s.token);
  const setToken = useViewer((s) => s.setToken);
  const setChannels = useViewer((s) => s.setChannels);
  const setLoading = useViewer((s) => s.setLoading);
  const setChannelsError = useViewer((s) => s.setChannelsError);
  const patchChannel = useViewer((s) => s.patchChannel);
  const setTokenDialogOpen = useViewer((s) => s.setTokenDialogOpen);
  const listHidden = useViewer((s) => s.listHidden);
  const setListHidden = useViewer((s) => s.setListHidden);
  const checkAllActive = useViewer((s) => s.checkAllActive);
  const checkProgress = useViewer((s) => s.checkProgress);
  const setCheckAll = useViewer((s) => s.setCheckAll);

  const stopChecksRef = useRef(false);
  const bootstrappedRef = useRef(false);

  // ── token bootstrap: ?token= wins, localStorage remembered ────────────────
  useEffect(() => {
    const urlToken = new URLSearchParams(location.search).get('token');
    const stored = prefs.get('token') ?? '';
    setToken(urlToken ?? stored);
    setTokenProvider(() => useViewer.getState().token);
  }, [setToken]);

  // ── status checks (auto after load, manual via header button) ──────────
  const checkAll = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    stopChecksRef.current = false;
    setCheckAll(true, { done: 0, total: ids.length });
    let done = 0;
    const total = ids.length;
    await runChecks(
      ids,
      4,
      (result) => {
        done += 1;
        patchChannel(result.id, {
          status: result.status,
          lastChecked: new Date().toISOString(),
        });
        setCheckAll(true, { done, total });
      },
      () => stopChecksRef.current,
    );
    setCheckAll(false);
  }, [patchChannel, setCheckAll]);

  // ── channel loading ───────────────────────────────────────────────────────
  const loadChannels = useCallback(
    async (opts: { withSkeleton?: boolean } = {}) => {
      if (opts.withSkeleton) setLoading(true);
      try {
        const data = await fetchChannels();
        setChannels(data.channels);
        setChannelsError(null);
        // Auto-check small channel lists when nothing has a status yet, so the
        // Online filter works out of the box (first load, after token save,
        // after a fresh import).
        const fresh = useViewer.getState().channels;
        if (
          fresh.length > 0 &&
          fresh.length <= 60 &&
          !useViewer.getState().checkAllActive &&
          fresh.every((c) => c.status === 'unknown')
        ) {
          void checkAll(fresh.map((c) => c.id));
        }
      } catch (err) {
        const e = err as ApiError;
        if (e instanceof ApiError && e.isAuthError) {
          setTokenDialogOpen(true);
        }
        if (useViewer.getState().channels.length === 0) {
          setChannelsError(e.message);
        } else {
          toast.error(`Channel refresh failed: ${e.message}`);
        }
      } finally {
        setLoading(false);
      }
    },
    [setChannels, setChannelsError, setLoading, setTokenDialogOpen, checkAll],
  );

  // ── bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    useViewer.setState({
      group: prefs.get('group') ?? '__all',
      onlineOnly: prefs.get('onlineOnly') === '1',
      listHidden: prefs.get('listHidden') === '1',
    });
    void (async () => {
      await loadChannels({ withSkeleton: true });
    })();
  }, []);

  // ── play requests from the channel list ───────────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const ch = useViewer.getState().channels.find((c) => c.id === id);
      if (ch) {
        window.dispatchEvent(new CustomEvent('sp-play-channel', { detail: ch }));
      }
    };
    window.addEventListener('sp-play', handler);
    return () => window.removeEventListener('sp-play', handler);
  }, []);

  const copyPlaylist = async () => {
    const url = `${location.origin}/playlist.m3u8${currentToken() ? `?token=${encodeURIComponent(currentToken())}` : ''}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Playlist URL copied');
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        {/* ── header ── */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card/50 px-3 sm:px-4">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            title={listHidden ? 'Show channel list (L)' : 'Hide channel list (L)'}
            aria-label={listHidden ? 'Show channel list' : 'Hide channel list'}
            aria-expanded={!listHidden}
            onClick={() => setListHidden(!listHidden)}
          >
            {listHidden ? <ListTree className="h-4.5 w-4.5" /> : <PanelLeftClose className="h-4.5 w-4.5" />}
          </Button>
          <div className="flex shrink-0 items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-8 w-8 rounded-lg border border-border/60" />
            <h1 className="hidden text-base font-extrabold tracking-tight sm:block">
              StreamProxy <span className="text-primary">IPTV</span>
            </h1>
          </div>

          <div className="mx-2 hidden min-w-0 flex-1 items-center text-sm text-muted-foreground md:flex">
            <kbd className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[10px]">/</kbd>
            <span className="ml-1.5 truncate">search · ↑↓ channels · space play · f fullscreen</span>
          </div>
          <div className="flex-1 md:hidden" />

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 px-2.5"
              onClick={() => void copyPlaylist()}
              title="Copy the playlist URL for IPTV players"
            >
              <Copy className="h-4 w-4" />
              <span className="hidden sm:inline">Playlist URL</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 px-2.5"
              disabled={checkAllActive}
              onClick={() => {
                const ids = useViewer.getState().channels.map((c) => c.id);
                if (ids.length === 0) {
                  toast.error('No channels to check');
                  return;
                }
                void checkAll(ids);
              }}
              title="Check every channel's online status"
            >
              {checkAllActive ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              <span className="hidden tabular-nums sm:inline">
                {checkAllActive ? `${checkProgress.done}/${checkProgress.total}` : 'Check status'}
              </span>
            </Button>
            <ServerStatus />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              title="Reload channel list"
              aria-label="Reload channel list"
              onClick={() => {
                void reloadChannels()
                  .then(() => loadChannels())
                  .then(() => toast.success('Channel list reloaded'))
                  .catch((err) => toast.error((err as Error).message));
              }}
            >
              <RefreshCw className="h-4.5 w-4.5" />
            </Button>
          </div>
        </header>

        {/* ── body ── */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <main className="order-1 flex min-h-0 min-w-0 flex-1 flex-col justify-start gap-3 p-3 lg:order-2 lg:justify-center lg:p-4">
            <div className="mx-auto w-full max-w-[min(100%,calc((100dvh-var(--header-h,56px)-120px)*16/9))]">
              <Player />
            </div>
          </main>
          <aside
            className={cn(
              'order-2 flex min-h-0 flex-col gap-2.5 border-t p-3 lg:order-1 lg:w-[360px] lg:shrink-0 lg:border-r lg:border-t-0 lg:p-4',
              listHidden && 'hidden',
            )}
          >
            <ChannelList />
          </aside>
        </div>

        <ShareDialog />
        <TokenDialog onSaved={() => void loadChannels()} />
      </div>
    </TooltipProvider>
  );
}
