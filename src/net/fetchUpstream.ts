/**
 * Upstream HTTP via undici: keep-alive Agent (with SSRF-safe DNS lookup),
 * manual redirects (each hop re-validated), retries with backoff for
 * transient failures, timeouts, and abort propagation on client disconnect.
 *
 * Pitfalls honored (see skills/hls-stream-resolver):
 *  - undici request() bodies are ALREADY Node Readables — never wrap in
 *    Readable.fromWeb (it throws at runtime).
 *  - Unused bodies must be drained with body.dump(), never destroy()ed
 *    (destroy on an unconsumed body emits an async AbortError that becomes
 *    an unhandled rejection).
 */
import { Agent, request, type Dispatcher } from 'undici';
import { loadConfig } from '../config.js';
import { assertUpstreamAllowed, createSafeLookup } from './ssrf.js';

let agent: Agent | undefined;

export function getAgent(): Agent {
  if (agent) return agent;
  const cfg = loadConfig();
  agent = new Agent({
    connections: 256,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connect: {
      timeout: cfg.connectTimeoutMs,
      lookup: createSafeLookup(cfg.allowPrivateUpstreams) as never,
    },
  });
  return agent;
}

export async function destroyAgent(): Promise<void> {
  if (agent) {
    await agent.destroy();
    agent = undefined;
  }
}

export interface UpstreamHeaders {
  'user-agent'?: string;
  referer?: string;
  origin?: string;
  cookie?: string;
  authorization?: string;
  [name: string]: string | undefined;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  /** Node Readable — pipe directly, do NOT wrap with Readable.fromWeb. */
  body: Dispatcher.ResponseData['body'];
  /** URL after following all redirects — use for relative URI resolution. */
  finalUrl: string;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function isRetryable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; name?: string };
  if (!e) return false;
  if (e.code === 'ABORT_ERR' || e.name === 'AbortError') return false; // caller gone / timeout handled below
  if (e.code && RETRYABLE_CODES.has(e.code)) return true;
  if (/socket hang up|network timeout|other side closed/i.test(e.message ?? '')) return true;
  return false;
}

function buildRequestHeaders(
  url: URL,
  headers: UpstreamHeaders | undefined,
  defaultUserAgent: string,
  stripRefererHosts: string[],
): Record<string, string> {
  const out: Record<string, string> = {
    'user-agent': headers?.['user-agent'] ?? defaultUserAgent,
    accept: '*/*',
    // identity: we want the raw bytes (image-wrapped TS, TS sync bytes).
    'accept-encoding': 'identity',
  };
  const hostKey = url.hostname.toLowerCase();
  const strip = stripRefererHosts.some((h) => hostKey.includes(h));
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!value) continue;
    const lower = name.toLowerCase();
    if (lower === 'user-agent' || lower === 'accept-encoding') continue;
    if ((lower === 'referer' || lower === 'origin') && strip) continue; // e.g. TikTok CDN 403s on Referer
    out[lower] = value;
  }
  return out;
}

export interface FetchUpstreamOptions {
  headers?: UpstreamHeaders;
  /** AbortSignal triggered when the client disconnects. */
  signal?: AbortSignal;
  /** Override overall request timeout (ms). */
  timeoutMs?: number;
  method?: string;
}

/**
 * GET (or custom method) an upstream URL with SSRF validation on every hop,
 * manual redirects, and retry-with-backoff on transient errors / 5xx.
 */
export async function fetchUpstream(
  url: string,
  options: FetchUpstreamOptions = {},
): Promise<UpstreamResponse> {
  const cfg = loadConfig();
  const timeoutMs = options.timeoutMs ?? cfg.requestTimeoutMs;
  let currentUrl = url;
  let redirectsLeft = cfg.maxRedirects;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    assertUpstreamAllowed(currentUrl, cfg.allowPrivateUpstreams);
    const parsed = new URL(currentUrl);
    const reqHeaders = buildRequestHeaders(
      parsed,
      options.headers,
      cfg.userAgent,
      cfg.stripRefererHosts,
    );

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const attemptSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let res: Dispatcher.ResponseData;
    try {
      res = await request(currentUrl, {
        method: options.method ?? 'GET',
        headers: reqHeaders,
        dispatcher: getAgent(),
        signal: attemptSignal,
        // No maxRedirections: request() never auto-follows redirects; the
        // manual loop below SSRF-validates every hop.
      });
    } catch (err) {
      if (options.signal?.aborted) throw err; // client gone — do not retry
      if (attempt < cfg.maxRetries && isRetryable(err)) {
        await backoff(attempt);
        continue;
      }
      throw new UpstreamError(
        `upstream request failed: ${(err as Error).message}`,
        undefined,
        (err as { code?: string }).code,
      );
    }

    // Redirects: drain the (tiny) body, validate the next hop, follow.
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      const location = res.headers['location'];
      const loc = Array.isArray(location) ? location[0] : location;
      await res.body.dump().catch(() => {});
      if (!loc) throw new UpstreamError('upstream redirect without Location', res.statusCode);
      const next = new URL(loc, currentUrl).toString();
      if (redirectsLeft <= 0) throw new UpstreamError('too many redirects', res.statusCode);
      redirectsLeft--;
      const from = new URL(currentUrl);
      const to = new URL(next);
      if (from.origin !== to.origin && options.headers) {
        // Strip credentials when a redirect crosses origins.
        const sanitized: UpstreamHeaders = { ...options.headers };
        delete sanitized.authorization;
        delete sanitized.cookie;
        options = { ...options, headers: sanitized };
      }
      currentUrl = next;
      attempt--; // redirects don't consume retry budget
      continue;
    }

    if (res.statusCode >= 500 || res.statusCode === 429) {
      const status = res.statusCode;
      await res.body.dump().catch(() => {});
      if (attempt < cfg.maxRetries) {
        await backoff(attempt);
        continue;
      }
      throw new UpstreamError(`upstream returned ${status}`, status);
    }

    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }

    return {
      status: res.statusCode,
      headers: flat,
      body: res.body,
      finalUrl: currentUrl,
    };
  }
  throw new UpstreamError('unreachable'); // loop always returns or throws
}

async function backoff(attempt: number): Promise<void> {
  const base = 300 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 150);
  await new Promise((r) => setTimeout(r, base + jitter));
}

/** Collect the whole body as a Buffer with a size cap (playlist/keys). */
export async function readBodyWithCap(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new UpstreamError(`upstream body exceeds ${maxBytes} bytes`, undefined, 'BODY_TOO_LARGE');
    }
    chunks.push(buf);
    if (signal?.aborted) throw new Error('aborted while reading body');
  }
  return Buffer.concat(chunks);
}

