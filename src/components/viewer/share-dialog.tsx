'use client';

/**
 * Share & export dialog: QR + Live URL, M3U8, Direct URL (with expiry
 * countdown + refresh), and VLC/MPV command builders (source + OS toggles).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useViewer } from '@/lib/store';
import { api, fetchShare, refreshDirect, rotateToken, ApiError } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { OsChoice, SharePayload } from '@/lib/types';
import { OS_LABELS } from '@/lib/types';

export function ShareDialog() {
  const shareChannelId = useViewer((s) => s.shareChannelId);
  const openShare = useViewer((s) => s.openShare);
  const token = useViewer((s) => s.token);
  const setTokenDialogOpen = useViewer((s) => s.setTokenDialogOpen);

  const [share, setShare] = useState<SharePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [qrSvg, setQrSvg] = useState('');
  const reqRef = useRef(0);

  const load = useCallback(async (channelId: string, req: number) => {
    setError(null);
    try {
      const payload = await fetchShare(channelId);
      if (req !== reqRef.current) return;
      setShare(payload);
      try {
        const qrcode = (await import('qrcode-generator')).default;
        const qr = qrcode(0, 'M');
        qr.addData(payload.live);
        qr.make();
        setQrSvg(qr.createSvgTag({ cellSize: 3, margin: 0 }));
      } catch {
        setQrSvg('');
      }
    } catch (err) {
      if (req !== reqRef.current) return;
      if (err instanceof ApiError && err.isAuthError) {
        setTokenDialogOpen(true);
        openShare(null);
        return;
      }
      setError((err as Error).message);
    }
  }, [openShare, setTokenDialogOpen]);

  useEffect(() => {
    if (!shareChannelId) {
      setShare(null);
      return;
    }
    const req = ++reqRef.current;
    void load(shareChannelId, req);
  }, [shareChannelId, load]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed — select the text manually');
    }
  };

  const onRotate = async () => {
    if (!share) return;
    setConfirmRotate(false);
    setRotating(true);
    try {
      await rotateToken(share.channel);
      await load(share.channel, reqRef.current);
      toast.success('Token regenerated — old links are dead');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRotating(false);
    }
  };

  return (
    <Dialog open={Boolean(shareChannelId)} onOpenChange={(open) => !open && openShare(null)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            Share &amp; export
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={rotating || !share}
              onClick={() => setConfirmRotate(true)}
            >
              <RefreshCw className={cn('mr-1 h-3.5 w-3.5', rotating && 'animate-spin')} />
              Regenerate token
            </Button>
          </DialogTitle>
          <DialogDescription>
            Links carry this channel&apos;s share token{token ? ' plus your auth token' : ''} — rotate it to kill old ones.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {!share && !error && (
          <div className="grid place-items-center py-10">
            <div className="h-9 w-9 animate-spin rounded-full border-4 border-muted border-t-primary" role="status" aria-label="Loading" />
          </div>
        )}

        {share && (
          <div className="grid gap-5 sm:grid-cols-[180px_1fr]">
            <div className="hidden text-center sm:block">
              <div
                className="inline-block rounded-xl bg-white p-2.5 [&_svg]:block"
                dangerouslySetInnerHTML={{ __html: qrSvg || '<div style="padding:40px;color:#333;font-size:12px">QR unavailable</div>' }}
              />
              <p className="mt-2 text-xs text-muted-foreground">Scan to open on phone / TV</p>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <ShareRow
                title="Our Live URL"
                badge={{ text: 'Recommended', variant: 'rec' }}
                desc="Keeps working. Token refresh is handled for you."
                value={share.live}
                onCopy={() => copy(share.live)}
              />
              <ShareRow
                title="Dynamic M3U8 Stream URL"
                desc="For IPTV players (TiviMate, OTT Navigator, etc.)."
                value={share.m3u8}
                onCopy={() => copy(share.m3u8)}
                extra={
                  <Button variant="outline" size="sm" className="h-8" onClick={() => void copy(share.playlist)}>
                    Copy full playlist URL
                  </Button>
                }
              />
              <ShareRow
                title="Direct URL"
                badge={{ text: 'Raw upstream', variant: 'warn' }}
                desc="Raw link that expires and may require specific headers. Prefer the Live URL."
                value={share.direct?.url ?? (share.resolveError ? `unavailable: ${share.resolveError}` : 'unavailable')}
                onCopy={() => copy(share.direct?.url ?? '')}
                extra={
                  share.direct ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={async () => {
                          try {
                            await refreshDirect(share.channel);
                            const fresh = await fetchShare(share.channel);
                            setShare(fresh);
                            toast.success('Direct URL re-resolved');
                          } catch (err) {
                            toast.error((err as Error).message);
                          }
                        }}
                      >
                        <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
                      </Button>
                      <ExpiryCountdown expiresAt={share.direct.expiresAt} />
                    </div>
                  ) : undefined
                }
              />
              <PlayerCommandRow share={share} player="vlc" onCopy={copy} />
              <PlayerCommandRow share={share} player="mpv" onCopy={copy} />
            </div>
          </div>
        )}
      </DialogContent>

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate this channel&apos;s share token?</AlertDialogTitle>
            <AlertDialogDescription>
              All previously shared links for this channel will stop working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRotate()}>Regenerate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

function ExpiryCountdown({ expiresAt }: { expiresAt?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!expiresAt) return <span className="text-xs text-muted-foreground">Expiry unknown</span>;
  const ms = expiresAt - now;
  if (ms <= 0) return <span className="text-xs font-semibold text-destructive">EXPIRED — press Refresh to re-resolve</span>;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const at = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const warn = ms < 60_000;
  return (
    <span className={cn('text-xs tabular-nums', warn ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
      Expires at {at} (in {mins}m {secs}s)
    </span>
  );
}

function ShareRow({
  title, badge, desc, value, onCopy, extra,
}: {
  title: string;
  badge?: { text: string; variant: 'rec' | 'warn' };
  desc: string;
  value: string;
  onCopy: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-accent/30 p-3.5',
        badge?.variant === 'rec' && 'border-primary/50',
        badge?.variant === 'warn' && 'border-destructive/40',
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold">{title}</span>
        {badge && <Badge variant={badge.variant}>{badge.text}</Badge>}
      </div>
      <p className="mb-2.5 text-xs text-muted-foreground">{desc}</p>
      {extra && <div className="mb-2.5 flex flex-wrap items-center gap-2">{extra}</div>}
      <div className="flex items-stretch gap-2">
        <textarea
          readOnly
          rows={2}
          value={value}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          className="min-h-11 flex-1 resize-none rounded-lg border border-border bg-background/70 px-3 py-2 font-mono text-xs break-all focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <Button variant="outline" size="sm" className="min-w-20 self-start" onClick={onCopy}>Copy</Button>
      </div>
    </div>
  );
}

function PlayerCommandRow({
  share, player, onCopy,
}: {
  share: SharePayload;
  player: 'vlc' | 'mpv';
  onCopy: (text: string) => void;
}) {
  const [source, setSource] = useState<'live' | 'direct'>('live');
  const [os, setOs] = useState<OsChoice>('posix');

  const suffix = os === 'posix' ? '' : os === 'powershell' ? 'Win' : 'Cmd';
  const key = `${source}${suffix}`;
  const cmd = share[player][key] ?? '(unavailable — direct URL missing or expired; refresh it above)';

  return (
    <ShareRow
      title={player.toUpperCase()}
      desc={`Command to open in ${player.toUpperCase()} (Live URL needs no headers).`}
      value={cmd}
      onCopy={() => onCopy(cmd)}
      extra={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {(['live', 'direct'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  source === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setSource(mode)}
              >
                {mode === 'live' ? 'Live URL' : 'Direct URL'}
              </button>
            ))}
          </div>
          <Select value={os} onValueChange={(v) => setOs(v as OsChoice)}>
            <SelectTrigger size="sm" className="h-8 w-[190px]" aria-label={`${player.toUpperCase()} shell`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OS_LABELS.map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    />
  );
}
