/**
 * Sportsbite IPTV web viewer. No frameworks: vanilla TS + hls.js (+ tiny QR
 * generator), everything bundled locally by esbuild — no CDN dependencies.
 */
import Hls, { type ErrorData } from 'hls.js';
import qrcode from 'qrcode-generator';

// ── types & state ────────────────────────────────────────────────────────────

interface ApiChannel {
  id: string;
  name: string;
  group: string;
  logo?: string;
  tvgId?: string;
  resolver: string;
  status: string;
}

interface DirectInfo {
  url: string;
  expiresAt?: number;
  headers: Record<string, string>;
}

interface SharePayload {
  channel: string;
  name: string;
  live: string;
  m3u8: string;
  playlist: string;
  direct?: DirectInfo | null;
  resolveError?: string;
  vlc: Record<string, string>;
  mpv: Record<string, string>;
}

let channels: ApiChannel[] = [];
let currentId: string | null = null;
let hls: Hls | null = null;
let recoveryStep = 0;
let countdownTimer: number | null = null;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

const token = new URLSearchParams(location.search).get('token') ?? store.get('sb-token') ?? '';
if (token) store.set('sb-token', token);

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as T;
};

const video = $<HTMLVideoElement>('#video');
const wrap = $<HTMLDivElement>('#video-wrap');
const listEl = $<HTMLDivElement>('#channels');
const searchEl = $<HTMLInputElement>('#search');
const groupEl = $<HTMLSelectElement>('#group');
const onlineBtn = $<HTMLButtonElement>('#only-online');
const levelEl = $<HTMLSelectElement>('#level');
const audioEl = $<HTMLSelectElement>('#audio');
const subsEl = $<HTMLSelectElement>('#subs');
const volumeEl = $<HTMLInputElement>('#volume');
const shareModal = $<HTMLDivElement>('#share-modal');
const layoutEl = $<HTMLDivElement>('.layout');
const toggleListBtn = $<HTMLButtonElement>('#btn-toggle-list');

// ── icons ────────────────────────────────────────────────────────────────────

const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS: Record<string, string> = {
  play: svg('<polygon points="7 4 20 12 7 20 7 4" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>'),
  volume: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  mute: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="16" y1="9" x2="22" y2="15"/><line x1="22" y1="9" x2="16" y2="15"/>'),
  fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>'),
  exitFullscreen: svg('<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>'),
  up: svg('<polyline points="18 15 12 9 6 15"/>'),
  down: svg('<polyline points="6 9 12 15 18 9"/>'),
  reload: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>'),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  sidebar: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>'),
};

function setIcon(el: HTMLElement, name: string): void {
  el.innerHTML = ICONS[name] ?? '';
}

function hydrateIcons(): void {
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => setIcon(el, el.dataset['icon'] ?? ''));
}

// ── API ──────────────────────────────────────────────────────────────────────

function withToken(url: string): string {
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withToken(path), {
    ...init,
    headers: { ...(init?.headers ?? {}), ...(token ? { 'x-auth-token': token } : {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

// ── clipboard & toast ────────────────────────────────────────────────────────

let toastTimer: number | null = null;
function toast(msg: string): void {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 1800);
}

/** navigator.clipboard with an execCommand fallback for plain-HTTP LAN use. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Copied');
      return true;
    } catch {
      toast('Copy failed — select the text manually');
      return false;
    } finally {
      ta.remove();
    }
  }
}

// ── channel list ─────────────────────────────────────────────────────────────

function streamUrl(id: string): string {
  return withToken(`${location.origin}/stream/${encodeURIComponent(id)}.m3u8`);
}

function visibleChannels(): ApiChannel[] {
  const q = searchEl.value.trim().toLowerCase();
  const g = groupEl.value;
  const onlineOnly = onlineBtn.getAttribute('aria-pressed') === 'true';
  return channels.filter((c) => {
    if (g && g !== '__all' && c.group !== g) return false;
    if (onlineOnly && c.status !== 'online') return false;
    if (!q) return true;
    return `${c.name} ${c.id} ${c.tvgId ?? ''}`.toLowerCase().includes(q);
  });
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const second = words[1] ?? '';
  return (words.length === 1 ? first.slice(0, 2) : first.charAt(0) + second.charAt(0)).toUpperCase();
}

function renderSkeleton(): void {
  listEl.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const s = document.createElement('div');
    s.className = 'skeleton';
    listEl.appendChild(s);
  }
}

function renderList(): void {
  const vis = visibleChannels();
  listEl.innerHTML = '';

  if (vis.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const filtered = channels.length > 0;
    empty.innerHTML = filtered
      ? '<strong>No channels match</strong>Try clearing the search or filters.'
      : '<strong>No channels yet</strong>Reload the list to try again.';
    listEl.appendChild(empty);
  }

  const frag = document.createDocumentFragment();
  for (const ch of vis) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chan ' + (ch.status === 'online' ? 'online' : ch.status === 'offline' ? 'offline' : '');
    btn.dataset['id'] = ch.id;
    btn.setAttribute('role', 'option');
    const active = ch.id === currentId;
    btn.setAttribute('aria-selected', String(active));
    if (active) btn.classList.add('active');

    const logo = document.createElement('span');
    logo.className = 'chan-logo';
    const fallback = document.createElement('span');
    fallback.textContent = initials(ch.name);
    logo.appendChild(fallback);
    if (ch.logo) {
      // The <img> must be in the DOM from the start: a detached lazy image never loads.
      // It stays invisible (over the initials) until it has loaded successfully.
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.onload = () => {
        img.classList.add('loaded');
        fallback.remove();
      };
      img.onerror = () => img.remove();
      img.src = ch.logo;
      logo.appendChild(img);
    }
    btn.appendChild(logo);

    const txt = document.createElement('span');
    txt.className = 'chan-text';
    const name = document.createElement('div');
    name.className = 'chan-name';
    name.textContent = ch.name;
    const grp = document.createElement('div');
    grp.className = 'chan-group';
    grp.textContent = ch.group;
    txt.appendChild(name);
    txt.appendChild(grp);
    btn.appendChild(txt);

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.title = ch.status;
    btn.appendChild(dot);

    btn.onclick = () => void play(ch);
    frag.appendChild(btn);
  }
  listEl.appendChild(frag);
  $('#list-status').textContent = `${vis.length} of ${channels.length} channels`;
}

/** Update the highlighted row without rebuilding the whole list. */
function markActive(scroll: boolean): void {
  let activeEl: HTMLElement | null = null;
  listEl.querySelectorAll<HTMLElement>('.chan').forEach((el) => {
    const on = el.dataset['id'] === currentId;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
    if (on) activeEl = el;
  });
  if (scroll) (activeEl as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
}

function renderGroups(): void {
  const saved = store.get('sb-group') ?? '__all';
  const groups = [...new Set(channels.map((c) => c.group))].sort((a, b) => a.localeCompare(b));
  groupEl.innerHTML = '';
  const all = document.createElement('option');
  all.value = '__all';
  all.textContent = `All groups (${channels.length})`;
  groupEl.appendChild(all);
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    groupEl.appendChild(opt);
  }
  groupEl.value = groups.includes(saved) ? saved : '__all';
}

async function loadChannels(): Promise<void> {
  const reloadBtn = $('#btn-reload');
  reloadBtn.classList.add('spinning');
  if (channels.length === 0) renderSkeleton();
  try {
    const data = await api<{ channels: ApiChannel[]; total: number }>('/api/channels');
    channels = data.channels;
    renderGroups();
    renderList();
  } catch (err) {
    const msg = (err as Error).message;
    listEl.innerHTML = '';
    $('#list-status').textContent = msg;
    if (msg.toLowerCase().includes('authentication')) {
      showOverlay('Authentication required', 'Add ?token=<AUTH_TOKEN> to the URL.');
    } else if (channels.length === 0) {
      showOverlay('Could not load channels', msg, { retry: true });
    }
  } finally {
    reloadBtn.classList.remove('spinning');
  }
}

// ── overlay & player chrome ──────────────────────────────────────────────────

interface OverlayOpts {
  retry?: boolean;
  spinner?: boolean;
}

function showOverlay(title: string, detail: string, opts: OverlayOpts = {}): void {
  $('#overlay-title').textContent = title;
  $('#overlay-detail').textContent = detail;
  $('#btn-retry').hidden = !opts.retry;
  $('#overlay-spinner').hidden = !opts.spinner;
  wrap.classList.toggle('is-loading', !!opts.spinner);
  wrap.classList.add('has-overlay');
  $('#overlay').hidden = false;
}

function hideOverlay(): void {
  $('#overlay').hidden = true;
  wrap.classList.remove('has-overlay', 'is-loading');
}

let uiTimer: number | null = null;
function showUi(): void {
  wrap.classList.add('ui-on');
  wrap.classList.remove('idle');
  if (uiTimer) clearTimeout(uiTimer);
  if (video.paused) return;
  const hide = () => {
    const active = document.activeElement;
    const busy =
      $('#controls').matches(':hover') || (active instanceof HTMLSelectElement && $('#controls').contains(active));
    if (busy) {
      uiTimer = window.setTimeout(hide, 2000);
      return;
    }
    wrap.classList.remove('ui-on');
    wrap.classList.add('idle');
  };
  uiTimer = window.setTimeout(hide, 3000);
}

function syncVolumeUi(): void {
  volumeEl.value = String(video.muted ? 0 : video.volume);
  setIcon($('#btn-mute'), video.muted || video.volume === 0 ? 'mute' : 'volume');
}

function syncFullscreenUi(): void {
  setIcon($('#btn-fs'), document.fullscreenElement ? 'exitFullscreen' : 'fullscreen');
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void wrap.requestFullscreen().catch(() => {});
}

function togglePlay(): void {
  if (!currentId) return;
  if (video.paused) void video.play().catch(() => {});
  else video.pause();
}

// ── playback ─────────────────────────────────────────────────────────────────

function stopPlayback(): void {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.removeAttribute('src');
  video.load();
  levelEl.innerHTML = '<option value="-1">Quality: Auto</option>';
  audioEl.innerHTML = '<option value="-1">Audio: default</option>';
  subsEl.innerHTML = '<option value="-1">Subtitles: off</option>';
  audioEl.hidden = true;
  subsEl.hidden = true;
  $('#buffering').hidden = true;
}

function cacheBust(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + '_fgt=' + Date.now();
}

async function play(ch: ApiChannel | undefined): Promise<void> {
  if (!ch) return;
  currentId = ch.id;
  recoveryStep = 0;
  store.set('sb-last', ch.id);
  stopPlayback();
  markActive(true);
  $('#np-name').textContent = ch.name;
  $('#hud-name').textContent = ch.name;
  $('#np-status').textContent = '';
  $('#np-badge').hidden = true;
  document.title = `${ch.name} · Sportsbite IPTV`;
  showOverlay(ch.name, 'Tuning in…', { spinner: true });
  showUi();

  const url = streamUrl(ch.id);
  if (Hls.isSupported()) {
    hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      manifestLoadingTimeOut: 15_000,
      manifestLoadingMaxRetry: 6,
      levelLoadingMaxRetry: 6,
      fragLoadingMaxRetry: 8,
      fragLoadingTimeOut: 25_000,
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      fillLevelSelector();
      void video.play().catch(() => mutedAutoplayFallback());
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const lvl = hls?.levels[data.level];
      if (lvl) $('#np-status').textContent = lvl.height ? `${lvl.height}p` : `${Math.round(lvl.bitrate / 1000)} kbps`;
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, fillAudioSelector);
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, fillSubtitleSelector);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      handleFatalError(ch, data);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari / native HLS
    video.src = url;
    video.addEventListener('loadedmetadata', () => void video.play().catch(() => mutedAutoplayFallback()), { once: true });
    video.addEventListener('error', () => handleFatalError(ch, null), { once: true });
  } else {
    showOverlay('HLS not supported', 'This browser cannot play HLS streams.', { retry: true });
  }
}

function mutedAutoplayFallback(): void {
  video.muted = true;
  void video.play().catch(() => {
    showOverlay('Press play', 'Autoplay was blocked — tap the video or press space.');
  });
}

function fillLevelSelector(): void {
  if (!hls) return;
  levelEl.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '-1';
  auto.textContent = 'Quality: Auto';
  levelEl.appendChild(auto);
  hls.levels.forEach((lvl, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = lvl.height
      ? `${lvl.height}p (${Math.round(lvl.bitrate / 1000)} kbps)`
      : `${Math.round(lvl.bitrate / 1000)} kbps`;
    levelEl.appendChild(opt);
  });
}

function fillAudioSelector(): void {
  if (!hls || hls.audioTracks.length <= 1) return;
  audioEl.hidden = false;
  audioEl.innerHTML = '';
  hls.audioTracks.forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Audio: ${t.name || t.lang || i}`;
    audioEl.appendChild(opt);
  });
  audioEl.value = String(hls.audioTrack);
}

function fillSubtitleSelector(): void {
  if (!hls || hls.subtitleTracks.length === 0) return;
  subsEl.hidden = false;
  subsEl.innerHTML = '';
  const off = document.createElement('option');
  off.value = '-1';
  off.textContent = 'Subtitles: off';
  subsEl.appendChild(off);
  hls.subtitleTracks.forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Subs: ${t.name || t.lang || i}`;
    subsEl.appendChild(opt);
  });
}

/** Escalating recovery: media/network retry → restart load → fresh tune-in → give up. */
function handleFatalError(ch: ApiChannel, data: ErrorData | null): void {
  if (ch.id !== currentId) return;
  recoveryStep++;
  if (recoveryStep === 1 && hls) {
    if (data?.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else hls.startLoad();
    return;
  }
  if (recoveryStep === 2 && hls) {
    hls.startLoad();
    return;
  }
  if (recoveryStep === 3) {
    // Fresh tune-in: re-fetch the playlist (server re-resolves expired URLs).
    const bust = cacheBust(streamUrl(ch.id));
    if (hls) hls.loadSource(bust);
    else video.src = bust;
    return;
  }
  $('#np-status').textContent = 'error';
  $('#np-badge').hidden = true;
  showOverlay(
    'Playback failed',
    data
      ? `${data.details} — the upstream may be offline or the token expired.`
      : 'The stream could not be loaded.',
    { retry: true },
  );
}

function stepChannel(dir: 1 | -1): void {
  const vis = visibleChannels();
  if (vis.length === 0) return;
  const idx = vis.findIndex((c) => c.id === currentId);
  const next = idx === -1 ? (dir === 1 ? 0 : vis.length - 1) : (idx + dir + vis.length) % vis.length;
  void play(vis[next]);
}

// ── channel list visibility ──────────────────────────────────────────────────

function setListHidden(hidden: boolean): void {
  layoutEl.classList.toggle('list-hidden', hidden);
  const label = hidden ? 'Show channel list (L)' : 'Hide channel list (L)';
  toggleListBtn.title = label;
  toggleListBtn.setAttribute('aria-label', label.replace(' (L)', ''));
  toggleListBtn.setAttribute('aria-expanded', String(!hidden));
  store.set('sb-list-hidden', hidden ? '1' : '0');
  if (!hidden) markActive(true);
}

// ── share & export panel ─────────────────────────────────────────────────────

type OsChoice = 'posix' | 'powershell' | 'cmd';
let shareOs: OsChoice = 'posix';
let vlcSource: 'live' | 'direct' = 'live';
let mpvSource: 'live' | 'direct' = 'live';
let currentShare: SharePayload | null = null;
let shareReq = 0;

function osSuffixKey(prefix: 'live' | 'direct', os: OsChoice): string {
  return prefix + (os === 'posix' ? '' : os === 'powershell' ? 'Win' : 'Cmd');
}

function fmtExpiry(expiresAt: number | undefined): string {
  if (!expiresAt) return 'Expiry unknown';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'EXPIRED — press Refresh to re-resolve';
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const at = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Expires at ${at} (in ${mins}m ${secs}s)`;
}

function startCountdown(el: HTMLElement, expiresAt: number | undefined): void {
  if (countdownTimer) clearInterval(countdownTimer);
  const tick = () => {
    el.textContent = fmtExpiry(expiresAt);
    el.classList.toggle('warn-text', !!expiresAt && expiresAt - Date.now() < 60_000);
  };
  tick();
  if (expiresAt) countdownTimer = window.setInterval(tick, 1000);
}

function makeRow(
  title: string,
  badge: { cls: string; text: string } | null,
  desc: string,
  recommended = false,
): { row: HTMLDivElement; valueBox: HTMLTextAreaElement } {
  const row = document.createElement('div');
  row.className = 'share-row' + (recommended ? ' recommended' : '');
  const head = document.createElement('div');
  head.className = 'share-row-head';
  const t = document.createElement('span');
  t.className = 'share-row-title';
  t.textContent = title;
  head.appendChild(t);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'badge ' + badge.cls;
    b.textContent = badge.text;
    head.appendChild(b);
  }
  const d = document.createElement('div');
  d.className = 'share-row-desc';
  d.textContent = desc;
  row.appendChild(head);
  row.appendChild(d);
  const valueBox = document.createElement('textarea');
  valueBox.readOnly = true;
  valueBox.rows = 2;
  valueBox.spellcheck = false;
  valueBox.onfocus = () => valueBox.select();
  return { row, valueBox };
}

function attachCopyRow(row: HTMLDivElement, valueBox: HTMLTextAreaElement, getValue: () => string): void {
  const wrapEl = document.createElement('div');
  wrapEl.className = 'share-value';
  wrapEl.appendChild(valueBox);
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = async () => {
    if (await copyText(getValue())) {
      copyBtn.textContent = 'Copied ✓';
      window.setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    }
  };
  wrapEl.appendChild(copyBtn);
  row.appendChild(wrapEl);
}

function renderShareRows(): void {
  const s = currentShare;
  if (!s) return;
  const rowsEl = $('#share-rows');
  rowsEl.innerHTML = '';

  // 1 — Our Live URL (recommended)
  {
    const { row, valueBox } = makeRow(
      'Our Live URL',
      { cls: 'rec', text: 'Recommended' },
      'Keeps working. Token refresh is handled for you.',
      true,
    );
    valueBox.value = s.live;
    attachCopyRow(row, valueBox, () => s.live);
    rowsEl.appendChild(row);
  }

  // 2 — Dynamic M3U8 stream URL
  {
    const { row, valueBox } = makeRow(
      'Dynamic M3U8 Stream URL',
      null,
      'For IPTV players (TiviMate, OTT Navigator, etc.).',
    );
    valueBox.value = s.m3u8;
    attachCopyRow(row, valueBox, () => s.m3u8);
    const extra = document.createElement('div');
    extra.className = 'share-row-controls';
    const playlistBtn = document.createElement('button');
    playlistBtn.className = 'btn ghost small';
    playlistBtn.textContent = 'Copy full playlist URL';
    playlistBtn.onclick = () => void copyText(s.playlist);
    extra.appendChild(playlistBtn);
    row.appendChild(extra);
    rowsEl.appendChild(row);
  }

  // 3 — Direct URL (raw upstream, expiring)
  {
    const { row, valueBox } = makeRow(
      'Direct URL',
      { cls: 'warn', text: 'Raw upstream' },
      'Raw link that expires and may require specific headers. Prefer the Live URL.',
    );
    valueBox.value = s.direct?.url ?? (s.resolveError ? `unavailable: ${s.resolveError}` : 'unavailable');
    attachCopyRow(row, valueBox, () => valueBox.value);

    if (s.direct) {
      const controls = document.createElement('div');
      controls.className = 'share-row-controls';
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'btn small';
      refreshBtn.textContent = '↻ Refresh';
      refreshBtn.onclick = async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing…';
        try {
          await api(`/api/channels/${encodeURIComponent(s.channel)}/refresh`, { method: 'POST' });
          // Re-fetch the whole payload so the VLC/MPV direct commands update too.
          currentShare = await api<SharePayload>(`/api/channels/${encodeURIComponent(s.channel)}/share`);
          renderShareRows();
          toast('Direct URL re-resolved');
        } catch (err) {
          toast((err as Error).message);
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ Refresh';
        }
      };
      controls.appendChild(refreshBtn);
      row.appendChild(controls);
    }

    const expiry = document.createElement('div');
    expiry.className = 'expiry';
    row.appendChild(expiry);
    startCountdown(expiry, s.direct?.expiresAt);
    rowsEl.appendChild(row);
  }

  // 4 — VLC, 5 — MPV (source toggle + OS dropdown)
  for (const [player, kind] of [
    ['VLC', 'vlc'],
    ['MPV', 'mpv'],
  ] as const) {
    const { row, valueBox } = makeRow(
      player,
      null,
      `Command to open in ${player} (Live URL needs no headers).`,
    );
    let source: 'live' | 'direct' = kind === 'vlc' ? vlcSource : mpvSource;
    const cmd = () => s[kind][osSuffixKey(source, shareOs)] ?? '(unavailable — direct URL missing or expired; refresh it above)';

    const controls = document.createElement('div');
    controls.className = 'share-row-controls';

    const toggle = document.createElement('div');
    toggle.className = 'toggle';
    for (const mode of ['live', 'direct'] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = mode === 'live' ? 'Live URL' : 'Direct URL';
      b.className = source === mode ? 'on' : '';
      b.onclick = () => {
        source = mode;
        if (kind === 'vlc') vlcSource = mode;
        else mpvSource = mode;
        toggle.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        valueBox.value = cmd();
      };
      toggle.appendChild(b);
    }
    controls.appendChild(toggle);

    const osSelect = document.createElement('select');
    osSelect.setAttribute('aria-label', `${player} shell`);
    for (const [val, label] of [
      ['posix', 'Linux / macOS (sh)'],
      ['powershell', 'Windows (PowerShell)'],
      ['cmd', 'Windows (cmd.exe)'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      osSelect.appendChild(opt);
    }
    osSelect.value = shareOs;
    osSelect.onchange = () => {
      shareOs = osSelect.value as OsChoice;
      renderShareRows(); // keep VLC and MPV rows in sync
    };
    controls.appendChild(osSelect);
    row.appendChild(controls);

    valueBox.value = cmd();
    attachCopyRow(row, valueBox, () => valueBox.value);
    rowsEl.appendChild(row);
  }
}

async function openShare(): Promise<void> {
  if (!currentId) {
    toast('Play a channel first');
    return;
  }
  const req = ++shareReq;
  const id = currentId;
  shareModal.hidden = false;
  currentShare = null;
  $('#qr').innerHTML = '';
  $('#share-rows').innerHTML = '<div class="rows-loading"><div class="spinner" role="status" aria-label="Loading"></div></div>';
  $('#btn-close-share').focus();

  try {
    const s = await api<SharePayload>(`/api/channels/${encodeURIComponent(id)}/share`);
    if (req !== shareReq) return; // closed or superseded while loading
    currentShare = s;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(s.live);
      qr.make();
      $('#qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0 });
    } catch {
      $('#qr').textContent = 'QR unavailable';
    }
    renderShareRows();
  } catch (err) {
    if (req !== shareReq) return;
    closeShare();
    toast(`Could not load share info: ${(err as Error).message}`);
  }
}

function closeShare(): void {
  if (shareModal.hidden) return;
  shareReq++;
  shareModal.hidden = true;
  if (countdownTimer) clearInterval(countdownTimer);
  currentShare = null;
  $('#btn-share').focus();
}

// ── wiring ───────────────────────────────────────────────────────────────────

function initControls(): void {
  hydrateIcons();

  // restore preferences
  const savedVol = Number(store.get('sb-vol') ?? '0.9');
  video.volume = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 0.9;
  video.muted = store.get('sb-muted') === '1';
  onlineBtn.setAttribute('aria-pressed', store.get('sb-online') === '1' ? 'true' : 'false');
  syncVolumeUi();
  setListHidden(store.get('sb-list-hidden') === '1');
  toggleListBtn.onclick = () => setListHidden(!layoutEl.classList.contains('list-hidden'));

  searchEl.oninput = renderList;
  groupEl.onchange = () => {
    store.set('sb-group', groupEl.value);
    renderList();
  };
  onlineBtn.onclick = () => {
    const on = onlineBtn.getAttribute('aria-pressed') !== 'true';
    onlineBtn.setAttribute('aria-pressed', String(on));
    store.set('sb-online', on ? '1' : '0');
    renderList();
  };

  // transport
  $('#btn-play').onclick = togglePlay;
  $('#btn-prev').onclick = () => stepChannel(-1);
  $('#btn-next').onclick = () => stepChannel(1);
  video.onplay = () => {
    setIcon($('#btn-play'), 'pause');
    showUi();
  };
  video.onpause = () => {
    setIcon($('#btn-play'), 'play');
    showUi();
  };
  video.onplaying = () => {
    recoveryStep = 0;
    $('#buffering').hidden = true;
    hideOverlay();
    $('#np-badge').hidden = false;
  };
  video.onwaiting = () => {
    if (currentId && !wrap.classList.contains('has-overlay')) $('#buffering').hidden = false;
  };
  video.oncanplay = () => ($('#buffering').hidden = true);
  video.onvolumechange = () => {
    syncVolumeUi();
    store.set('sb-vol', String(video.volume));
    store.set('sb-muted', video.muted ? '1' : '0');
  };

  $('#btn-mute').onclick = () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
  };
  volumeEl.oninput = () => {
    const v = Number(volumeEl.value);
    video.volume = v;
    video.muted = v === 0;
  };

  // fullscreen
  $('#btn-fs').onclick = toggleFullscreen;
  document.addEventListener('fullscreenchange', syncFullscreenUi);
  video.ondblclick = toggleFullscreen;

  // click-to-play (mouse) / tap-to-reveal controls (touch)
  let lastPointer = 'mouse';
  wrap.addEventListener('pointerdown', (e) => (lastPointer = e.pointerType));
  wrap.addEventListener('pointermove', showUi);
  wrap.addEventListener('focusin', showUi);
  video.onclick = () => {
    if (lastPointer === 'mouse' || wrap.classList.contains('ui-on')) togglePlay();
    showUi();
  };

  // tracks
  levelEl.onchange = () => {
    if (hls) hls.currentLevel = Number(levelEl.value);
  };
  audioEl.onchange = () => {
    if (hls) hls.audioTrack = Number(audioEl.value);
  };
  subsEl.onchange = () => {
    if (hls) hls.subtitleTrack = Number(subsEl.value);
  };

  // actions
  $('#btn-copy-playlist').onclick = () => void copyText(withToken(`${location.origin}/playlist.m3u8`));
  $('#btn-copy-stream').onclick = () => {
    if (currentId) void copyText(streamUrl(currentId));
    else toast('Pick a channel first');
  };
  $('#btn-share').onclick = () => void openShare();
  $('#btn-close-share').onclick = closeShare;
  shareModal.onclick = (e) => {
    if (e.target === shareModal) closeShare();
  };
  $('#btn-rotate').onclick = async () => {
    if (!currentShare) return;
    if (!confirm('Regenerate this channel\'s share token?\n\nAll previously shared links for it will stop working.')) return;
    try {
      await api(`/api/channels/${encodeURIComponent(currentShare.channel)}/rotate-token`, { method: 'POST' });
      await openShare(); // refetch with the fresh token
      toast('Token regenerated — old links are dead');
    } catch (err) {
      toast((err as Error).message);
    }
  };
  $('#btn-reload').onclick = () => void loadChannels();
  $('#btn-retry').onclick = () => {
    const ch = channels.find((c) => c.id === currentId);
    if (ch) void play(ch);
    else void loadChannels();
  };

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) && !(target === volumeEl);

    if (e.key === 'Escape') {
      if (!shareModal.hidden) closeShare();
      else if (target === searchEl && searchEl.value) {
        searchEl.value = '';
        renderList();
      } else if (typing) target.blur();
      return;
    }
    if (typing || !shareModal.hidden) return;

    switch (e.key) {
      case '/':
        e.preventDefault();
        if (layoutEl.classList.contains('list-hidden')) setListHidden(false);
        searchEl.focus();
        break;
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
        toggleListBtn.click();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'm':
      case 'M':
        $('#btn-mute').click();
        break;
      case ' ':
      case 'Spacebar':
        // let a focused button handle its own activation
        if (target.tagName === 'BUTTON') return;
        e.preventDefault();
        togglePlay();
        break;
    }
  });
}

async function main(): Promise<void> {
  initControls();
  await loadChannels();
  // Auto-tune? No — keep it user-driven (autoplay policies). Just highlight the last channel.
  const last = store.get('sb-last');
  if (last && channels.some((c) => c.id === last)) {
    $('#overlay-detail').textContent = `Choose a channel, or press ↑ / ↓. Last watched: ${channels.find((c) => c.id === last)?.name ?? ''}`;
  }
}

void main();
