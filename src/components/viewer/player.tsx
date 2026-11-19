'use client';

/**
 * HLS player: video element + hls.js, custom auto-hiding controls, overlay
 * states (idle / loading / error with the server's REAL failure message),
 * quality + audio track selectors, fullscreen, volume persistence.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { ErrorData } from 'hls.js';
import { Play, Pause, ChevronUp, ChevronDown, Volume2, VolumeX, Maximize, Minimize, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useViewer, prefs, visibleChannels } from '@/lib/store';
import { currentToken, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface LevelInfo {
  index: number;
  label: string;
}

export function Player() {
  const channels = useViewer((s) => s.channels);
  const currentId = useViewer((s) => s.currentId);
  const setCurrent = useViewer((s) => s.setCurrent);
  const openShare = useViewer((s) => s.openShare);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoveryRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  const playRequestRef = useRef(0);

  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [buffering, setBuffering] = useState(false);
  const [uiOn, setUiOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [overlay, setOverlay] = useState<
    { kind: 'idle'; detail?: string } | { kind: 'loading'; title: string } | { kind: 'error'; title: string; detail: string }
  >({ kind: 'idle' });
  const [npStatus, setNpStatus] = useState('');
  const [levels, setLevels] = useState<LevelInfo[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);

  const current = channels.find((c) => c.id === currentId) ?? null;

  // ── stream URL + token ────────────────────────────────────────────────────
  const streamUrl = useCallback(
    (id: string): string => {
      const base = `${location.origin}/stream/${encodeURIComponent(id)}.m3u8`;
      const t = currentToken();
      return t ? `${base}?token=${encodeURIComponent(t)}` : base;
    },
    [],
  );

  // ── stop any playback ─────────────────────────────────────────────────────
  const stopPlayback = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
    setLevels([]);
    setCurrentLevel(-1);
    setBuffering(false);
  }, []);

  // ── real upstream error text (replaces generic hls.js codes) ──────────────
  const fetchRealError = useCallback(
    async (channelId: string): Promise<string | null> => {
      try {
        const url = `${location.origin}/stream/${encodeURIComponent(channelId)}.m3u8`;
        const res = await fetch(url);
        if (res.ok) return null;
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return body?.error ?? `HTTP ${res.status}`;
      } catch {
        return null;
      }
    },
    [],
  );

  // ── core play routine ─────────────────────────────────────────────────────
  const play = useCallback(
    async (channel: { id: string; name: string }) => {
      const req = ++playRequestRef.current;
      recoveryRef.current = 0;
      setCurrent(channel.id);
      stopPlayback();
      setNpStatus('');
      setOverlay({ kind: 'loading', title: channel.name });
      setUiOn(true);
      document.title = `${channel.name} · StreamProxy IPTV`;

      const supported = await import('hls.js').then(
        (m) => m.default.isSupported() || videoRef.current?.canPlayType('application/vnd.apple.mpegurl'),
      );
      if (req !== playRequestRef.current) return;
      if (!supported) {
        setOverlay({ kind: 'error', title: 'HLS not supported', detail: 'This browser cannot play HLS streams.' });
        return;
      }

      const HlsCtor = (await import('hls.js')).default;
      if (req !== playRequestRef.current) return;
      const video = videoRef.current;
      if (!video) return;

      const fatalHandler = async (_event: unknown, data: ErrorData) => {
        if (channel.id !== useViewer.getState().currentId) return;
        recoveryRef.current += 1;
        const step = recoveryRef.current;
        const hls = hlsRef.current;
        if (step <= 2 && hls) {
          if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else hls.startLoad();
          return;
        }
        if (step === 3) {
          // Fresh tune-in: re-fetch the playlist (server re-resolves expired URLs).
          const bust = `${streamUrl(channel.id)}${streamUrl(channel.id).includes('?') ? '&' : '?'}_fgt=${Date.now()}`;
          if (hls) hls.loadSource(bust);
          else video.src = bust;
          recoveryRef.current = 4;
          return;
        }
        setNpStatus('error');
        const real = await fetchRealError(channel.id);
        if (req !== playRequestRef.current) return;
        setOverlay({
          kind: 'error',
          title: 'Playback failed',
          detail:
            real ??
            (data
              ? `${data.details} — the upstream may be offline or the token expired.`
              : 'The stream could not be loaded.'),
        });
      };

      if (HlsCtor.isSupported()) {
        const hls = new HlsCtor({
          lowLatencyMode: false,
          liveSyncDurationCount: 3,
          manifestLoadingTimeOut: 15_000,
          manifestLoadingMaxRetry: 6,
          levelLoadingMaxRetry: 6,
          fragLoadingMaxRetry: 8,
          fragLoadingTimeOut: 25_000,
        });
        hlsRef.current = hls;
        hls.loadSource(streamUrl(channel.id));
        hls.attachMedia(video);
        hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
          setLevels(
            hls.levels.map((lvl, i) => ({
              index: i,
              label: lvl.height ? `${lvl.height}p (${Math.round(lvl.bitrate / 1000)} kbps)` : `${Math.round(lvl.bitrate / 1000)} kbps`,
            })),
          );
          setCurrentLevel(-1);
          void video.play().catch(() => mutedAutoplay(video, () => setOverlay({ kind: 'idle', detail: 'Autoplay was blocked — tap the video or press space.' })));
        });
        hls.on(HlsCtor.Events.LEVEL_SWITCHED, (_e, data) => {
          const lvl = hls.levels[data.level];
          if (lvl) setNpStatus(lvl.height ? `${lvl.height}p` : `${Math.round(lvl.bitrate / 1000)} kbps`);
        });
        hls.on(HlsCtor.Events.ERROR, fatalHandler);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari / native HLS
        video.src = streamUrl(channel.id);
        video.addEventListener(
          'loadedmetadata',
          () => void video.play().catch(() => mutedAutoplay(video, () => setOverlay({ kind: 'idle', detail: 'Autoplay was blocked — tap the video or press space.' }))),
          { once: true },
        );
        video.addEventListener('error', () => void fatalHandler(null, { details: 'media error' } as unknown as ErrorData), { once: true });
      }
    },
    [fetchRealError, setCurrent, stopPlayback, streamUrl],
  );

  // ── play requests from the channel list (viewer forwards the channel) ─────
  useEffect(() => {
    const handler = (e: Event) => {
      const ch = (e as CustomEvent<{ id: string; name: string }>).detail;
      if (ch?.id) void play(ch);
    };
    window.addEventListener('sp-play-channel', handler);
    return () => window.removeEventListener('sp-play-channel', handler);
  }, [play]);

  // stepChannel: prev/next within the visible list
  const stepChannel = useCallback(
    (dir: 1 | -1) => {
      const vis = visibleChannels(useViewer.getState());
      if (vis.length === 0) return;
      const idx = vis.findIndex((c) => c.id === useViewer.getState().currentId);
      const next = idx === -1 ? (dir === 1 ? 0 : vis.length - 1) : (idx + dir + vis.length) % vis.length;
      const target = vis[next];
      if (target) void play(target);
    },
    [play],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!currentId || !video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, [currentId]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen().catch(() => {});
  }, []);

  // ── video element events ─────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const savedVol = Number(prefs.get('volume') ?? '0.9');
    video.volume = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 0.9;
    video.muted = prefs.get('muted') === '1';
    setVolume(video.volume);
    setMuted(video.muted);

    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    const onPlaying = () => {
      recoveryRef.current = 0;
      setBuffering(false);
      setOverlay({ kind: 'idle' });
    };
    const onWaiting = () => {
      if (useViewer.getState().currentId) setBuffering(true);
    };
    const onCanPlay = () => setBuffering(false);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
      prefs.set('volume', String(video.volume));
      prefs.set('muted', video.muted ? '1' : '0');
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('volumechange', onVolume);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('volumechange', onVolume);
    };
  }, []);

  // ── controls auto-hide ────────────────────────────────────────────────────
  const showUi = useCallback(() => {
    setUiOn(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (videoRef.current?.paused) return;
    hideTimerRef.current = window.setTimeout(() => {
      const active = document.activeElement;
      const busy = wrapRef.current?.matches(':hover') || (active instanceof HTMLElement && wrapRef.current?.contains(active));
      if (busy) {
        hideTimerRef.current = window.setTimeout(() => setUiOn(false), 2000);
        return;
      }
      setUiOn(false);
    }, 3000);
  }, []);

  useEffect(() => {
    document.addEventListener('fullscreenchange', () => setFullscreen(Boolean(document.fullscreenElement)));
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  // ── global keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) && target !== videoRef.current;
      const dialogOpen = Boolean(document.querySelector('[role="dialog"]'));

      if (e.key === 'Escape') {
        if (typing) target.blur();
        return;
      }
      if (typing || dialogOpen) return;

      switch (e.key) {
        case '/': {
          e.preventDefault();
          const search = document.querySelector<HTMLInputElement>('#channel-search');
          search?.focus();
          break;
        }
        case 'ArrowUp':
          e.preventDefault();
          stepChannel(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          stepChannel(1);
          break;
        case 'l':
        case 'L':
          useViewer.getState().setListHidden(!useViewer.getState().listHidden);
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'm':
        case 'M': {
          const video = videoRef.current;
          if (video) {
            video.muted = !video.muted;
            if (!video.muted && video.volume === 0) video.volume = 0.5;
          }
          break;
        }
        case ' ':
        case 'Spacebar':
          if (target.tagName === 'BUTTON') return;
          e.preventDefault();
          togglePlay();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepChannel, toggleFullscreen, togglePlay]);

  const setQuality = (index: string) => {
    const idx = Number(index);
    setCurrentLevel(idx);
    if (hlsRef.current) hlsRef.current.currentLevel = idx;
  };

  const changeVolume = (v: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = v === 0;
  };

  const copyStreamUrl = async () => {
    if (!currentId) return;
    try {
      await navigator.clipboard.writeText(streamUrl(currentId));
      const { toast } = await import('sonner');
      toast.success('Stream URL copied');
    } catch {
      const { toast } = await import('sonner');
      toast.error('Copy failed — select the text manually');
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        ref={wrapRef}
        tabIndex={0}
        aria-label="Video player. Up and down arrows change channel, F toggles fullscreen, M mutes."
        className={cn(
          'group relative aspect-video w-full overflow-hidden rounded-xl border border-border/60 bg-black outline-none',
          !uiOn && 'cursor-none',
        )}
        onPointerMove={showUi}
        onDoubleClick={toggleFullscreen}
      >
        <video ref={videoRef} playsInline className="h-full w-full" onClick={() => { if (currentId) togglePlay(); showUi(); }} />

        {/* buffering spinner */}
        {buffering && overlay.kind !== 'loading' && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" role="status" aria-label="Buffering">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/15 border-t-primary" />
          </div>
        )}

        {/* overlay: idle / loading / error */}
        {(overlay.kind !== 'idle' || !currentId) && (
          <div
            className={cn(
              'absolute inset-0 z-10 grid place-items-center p-4 text-center',
              overlay.kind === 'idle' ? 'bg-black/35' : 'bg-black/80',
            )}
          >
            <div className="max-w-md space-y-3">
              {overlay.kind === 'loading' && (
                <>
                  <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-white/15 border-t-primary" role="status" aria-label="Loading" />
                  <p className="text-lg font-semibold">{overlay.title}</p>
                  <p className="text-sm text-muted-foreground">Tuning in…</p>
                </>
              )}
              {overlay.kind === 'idle' && (
                <>
                  { }
                  <img src="/favicon.svg" alt="" className="mx-auto h-20 w-20 rounded-2xl" />
                  <p className="text-xl font-bold">Pick a channel</p>
                  <p className="text-sm text-muted-foreground">
                    {overlay.detail ?? 'Choose one from the list, or press ↑ / ↓.'}
                  </p>
                </>
              )}
              {overlay.kind === 'error' && (
                <>
                  <p className="text-lg font-bold text-destructive">{overlay.title}</p>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{overlay.detail}</p>
                  <Button
                    onClick={() => {
                      const ch = channels.find((c) => c.id === currentId);
                      if (ch) void play(ch);
                    }}
                  >
                    <RefreshCw className="h-4 w-4" /> Retry
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {/* controls */}
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-2 bg-gradient-to-t from-black/90 to-transparent px-3 pb-2 pt-10 transition-opacity duration-200',
            uiOn ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <ControlButton title="Play / Pause (space)" onClick={togglePlay} disabled={!currentId}>
            {paused ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
          </ControlButton>
          <ControlButton title="Previous channel (↑)" onClick={() => stepChannel(-1)} className="hidden sm:inline-flex">
            <ChevronUp className="h-5 w-5" />
          </ControlButton>
          <ControlButton title="Next channel (↓)" onClick={() => stepChannel(1)} className="hidden sm:inline-flex">
            <ChevronDown className="h-5 w-5" />
          </ControlButton>
          <ControlButton
            title="Mute (m)"
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = !video.muted;
              if (!video.muted && video.volume === 0) video.volume = 0.5;
            }}
          >
            {muted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </ControlButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            title="Volume"
            aria-label="Volume"
            className="hidden w-24 accent-primary sm:block"
          />
          <div className="flex-1" />
          {levels.length > 1 && (
            <Select value={String(currentLevel)} onValueChange={setQuality}>
              <SelectTrigger size="sm" className="h-9 w-[150px] bg-black/60 border-border/50" aria-label="Quality">
                <SelectValue placeholder="Quality" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="-1">Quality: Auto</SelectItem>
                {levels.map((l) => (
                  <SelectItem key={l.index} value={String(l.index)}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <ControlButton title="Fullscreen (f)" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </ControlButton>
        </div>
      </div>

      {/* now playing */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex w-full min-w-0 items-center gap-2.5 sm:w-auto sm:flex-1">
          <span className="truncate text-lg font-bold">{current ? current.name : 'Nothing playing'}</span>
          {current && <Badge variant="live">LIVE</Badge>}
          {npStatus && <span className="shrink-0 text-sm text-muted-foreground">{npStatus}</span>}
        </div>
        <div className="flex w-full justify-between gap-2 sm:w-auto sm:justify-end">
          <Button variant="ghost" size="sm" onClick={copyStreamUrl} disabled={!currentId} title="Copy this channel's stream URL">
            Stream URL
          </Button>
          <Button size="sm" onClick={() => currentId && openShare(currentId)} disabled={!currentId}>
            Share &amp; export
          </Button>
        </div>
      </div>
    </div>
  );
}

function mutedAutoplay(video: HTMLVideoElement, onBlocked: () => void): void {
  video.muted = true;
  void video.play().catch(onBlocked);
}

function ControlButton({
  children,
  onClick,
  title,
  disabled,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn('h-9 w-9 shrink-0 bg-black/50 text-white hover:bg-black/70 hover:text-white', className)}
    >
      {children}
    </Button>
  );
}
