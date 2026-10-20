/**
 * Wrapped-segment decoding for the `timst` (TimStreams) source: TS smuggled
 * through TikTok's image CDN. Ported from the verified research decoders.
 *
 * The same upstream mixes disguises across channels and over time, so the
 * wrapper is detected PER RESPONSE, never per channel:
 *   1. raw TS            — first byte 0x47 → passthrough (streamed)
 *   2. fake image header — PNG/JPEG/RIFF magic + raw TS (scan for sync)
 *   3. pixel PNG         — real PNG whose pixel data holds
 *                          b'TIKTIKPX' + u32 BE length + gzip(TS)
 */
import { gunzipSync, inflateSync } from 'node:zlib';

export type SegmentKind = 'raw-ts' | 'image-wrapped' | 'unknown';

/** Cheap classification from the first bytes of a segment response. */
export function detectSegmentKind(head: Buffer): SegmentKind {
  if (head.length === 0) return 'unknown';
  if (head[0] === 0x47 && (head.length < 188 || head[188] === 0x47)) return 'raw-ts';
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image-wrapped'; // PNG
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image-wrapped'; // JPEG
  if (head.subarray(0, 4).toString('ascii') === 'RIFF') return 'image-wrapped'; // WEBP etc.
  return 'unknown';
}

/**
 * Old disguise: image magic + raw TS. Returns clean TS, or input unchanged
 * if it is already raw TS.
 */
export function stripFakeImageHeader(seg: Buffer): Buffer {
  if (seg.length > 0 && seg[0] === 0x47) return seg;
  const magics = [Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('RIFF', 'ascii'), Buffer.from([0xff, 0xd8, 0xff])];
  const isImage = magics.some((m) => seg.subarray(0, m.length).equals(m));
  if (!isImage) throw new Error('not a wrapped TS segment');
  // Scan for a 0x47 sync byte repeated every 188 bytes (3 consecutive packets).
  const limit = Math.min(seg.length - 376, 65_536);
  for (let off = 0; off < limit; off++) {
    if (seg[off] === 0x47 && seg[off + 188] === 0x47 && seg[off + 376] === 0x47) {
      return seg.subarray(off);
    }
  }
  throw new Error('no TS sync pattern found in image-wrapped segment');
}

interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  idat: Buffer[];
}

function parsePng(seg: Buffer): PngInfo {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!seg.subarray(0, 8).equals(sig)) throw new Error('not a PNG');
  let p = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let seenIhdr = false;
  const idat: Buffer[] = [];
  while (p + 12 <= seg.length) {
    const len = seg.readUInt32BE(p);
    const type = seg.subarray(p + 4, p + 8).toString('ascii');
    if (type === 'IHDR') {
      width = seg.readUInt32BE(p + 8);
      height = seg.readUInt32BE(p + 12);
      bitDepth = seg[p + 16];
      colorType = seg[p + 17];
      seenIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(seg.subarray(p + 8, p + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (!seenIhdr) throw new Error('PNG missing IHDR');
  return { width, height, bitDepth, colorType, idat };
}

/**
 * New disguise: a real PNG whose raw (unfiltered) pixel data starts with
 * ASCII `TIKTIKPX` + u32 BE length + gzip(TS). Implements PNG scanline
 * unfiltering (filters 0–4) for bit depth 8, color type 2 (RGB) / 6 (RGBA).
 */
export function decodePixelPng(seg: Buffer): Buffer {
  const { width, height, colorType, idat } = parsePng(seg);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    if (rowStart >= raw.length) break;
    const filter = raw[rowStart];
    const src = rowStart + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let i = 0; i < stride && src + i < raw.length; i++) {
      let x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      switch (filter) {
        case 1:
          x = (x + a) & 255;
          break;
        case 2:
          x = (x + b) & 255;
          break;
        case 3:
          x = (x + ((a + b) >> 1)) & 255;
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          x = (x + pred) & 255;
          break;
        }
        default:
          break; // filter 0 = None
      }
      out[dst + i] = x;
    }
  }
  if (out.subarray(0, 8).toString('ascii') !== 'TIKTIKPX') {
    throw new Error('not a TIKTIKPX pixel PNG');
  }
  const len = out.readUInt32BE(8);
  return gunzipSync(out.subarray(12, 12 + len));
}

/** Decode any wrapped segment; returns input unchanged if it is already raw. */
export function decodeSegment(seg: Buffer): Buffer {
  if (seg.length > 4 && seg.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    try {
      return decodePixelPng(seg);
    } catch {
      // fall through to fake-header strip
    }
  }
  try {
    return stripFakeImageHeader(seg);
  } catch {
    return seg; // not a wrapper we know — serve verbatim
  }
}
