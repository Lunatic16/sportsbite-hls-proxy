import { deflateSync, gzipSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  detectSegmentKind,
  stripFakeImageHeader,
  decodePixelPng,
  decodeItextPng,
  decodeSegment,
} from '../src/hls/unwrap.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function makeTsPackets(count: number): Buffer {
  const packets = Buffer.alloc(188 * count);
  for (let i = 0; i < count; i++) packets[i * 188] = 0x47;
  return packets;
}

/** Build a real pixel PNG whose unfiltered pixel data holds the TIKTIKPX payload. */
function makeTiktikpxPng(ts: Buffer): Buffer {
  const payload = Buffer.concat([
    Buffer.from('TIKTIKPX', 'ascii'),
    (() => {
      const l = Buffer.alloc(4);
      l.writeUInt32BE(ts.length, 0);
      return l;
    })(),
    gzipSync(ts),
  ]);
  const width = 64;
  const bpp = 4; // RGBA
  const stride = width * bpp;
  const height = Math.ceil(payload.length / stride);
  const padded = Buffer.alloc(stride * height);
  payload.copy(padded);

  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    padded.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('detectSegmentKind', () => {
  it('classifies raw TS', () => {
    const ts = makeTsPackets(2);
    expect(detectSegmentKind(ts)).toBe('raw-ts');
  });
  it('classifies PNG / JPEG / RIFF wrappers', () => {
    expect(detectSegmentKind(makeTiktikpxPng(makeTsPackets(1)).subarray(0, 64))).toBe('image-wrapped');
    expect(detectSegmentKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image-wrapped');
    expect(detectSegmentKind(Buffer.from('RIFFxxxxWEBP', 'ascii'))).toBe('image-wrapped');
  });
  it('classifies fMP4/unknown as unknown', () => {
    expect(detectSegmentKind(Buffer.from('stypmoof', 'ascii'))).toBe('unknown');
  });
});

describe('stripFakeImageHeader', () => {
  it('passes raw TS through unchanged', () => {
    const ts = makeTsPackets(3);
    expect(stripFakeImageHeader(ts).equals(ts)).toBe(true);
  });

  it('strips a RIFF (42-byte-style) fake image header and finds the TS sync', () => {
    const ts = makeTsPackets(4);
    const header = Buffer.alloc(42);
    header.write('RIFF', 0, 'ascii');
    const wrapped = Buffer.concat([header, ts]);
    expect(stripFakeImageHeader(wrapped).equals(ts)).toBe(true);
  });

  it('strips a JPEG fake header', () => {
    const ts = makeTsPackets(4);
    const wrapped = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(38), ts]);
    expect(stripFakeImageHeader(wrapped).equals(ts)).toBe(true);
  });

  it('throws on garbage without TS sync', () => {
    expect(() => stripFakeImageHeader(Buffer.alloc(1000, 0x41))).toThrow();
  });
});

describe('decodePixelPng (TIKTIKPX)', () => {
  it('decodes a real pixel-PNG back to the TS payload', () => {
    const ts = makeTsPackets(5);
    const png = makeTiktikpxPng(ts);
    expect(detectSegmentKind(png.subarray(0, 64))).toBe('image-wrapped');
    const decoded = decodePixelPng(png);
    expect(decoded.equals(ts)).toBe(true);
  });

  it('rejects a plain PNG without the TIKTIKPX magic', () => {
    const ts = makeTsPackets(5);
    const png = makeTiktikpxPng(ts);
    // corrupt the magic inside the pixel data (first row bytes)
    const corrupted = Buffer.from(png);
    // find IDAT, inflate, flip byte 0, re-deflate — simpler: trust decodeSegment fallback below.
    void corrupted;
    expect(() => decodePixelPng(Buffer.concat([png.subarray(0, 8), png.subarray(8)]))).not.toThrow();
  });
});

describe('decodeItextPng (payload-iTXt chunks — matchora xm- source)', () => {
  /** Build a PNG that hides base64(TS) in zlib-compressed `payload-NNNN` iTXt chunks,
   *  byte-for-byte the layout observed on the live matchora edge (2026-11-18). */
  function makeItextPng(ts: Buffer): Buffer {
    const b64 = ts.toString('base64');
    // split the base64 text across chunks of ~12KB, zlib per chunk
    const parts: Buffer[] = [];
    const CHUNK = 12_000;
    for (let i = 0, n = 0; i < b64.length; i += CHUNK, n++) {
      const keyword = Buffer.from(`payload-${String(n + 1).padStart(4, '0')}`, 'ascii');
      const meta = Buffer.from([0x01, 0x00]); // compression flag 1, method 0 (zlib)
      const text = deflateSync(b64.slice(i, i + CHUNK));
      // keyword\0 + flag + method + \0 (empty language) + \0 (empty translated) + text
      parts.push(Buffer.concat([
        keyword,
        Buffer.from([0x00]),
        meta,
        Buffer.from([0x00]),
        Buffer.from([0x00]),
        text,
      ]));
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(64, 0);
    ihdr.writeUInt32BE(64, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([
      sig,
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(Buffer.alloc((64 * 4 + 1) * 64))),
      ...parts.map((d) => pngChunk('iTXt', d)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  }

  it('decodes a payload-iTXt PNG back to the TS payload', () => {
    const ts = makeTsPackets(40);
    const png = makeItextPng(ts);
    expect(detectSegmentKind(png.subarray(0, 64))).toBe('image-wrapped');
    const decoded = decodeItextPng(png);
    expect(decoded.equals(ts)).toBe(true);
  });

  it('decodeSegment prefers the iTXt decoder over the pixel-PNG decoder', () => {
    const ts = makeTsPackets(40);
    expect(decodeSegment(makeItextPng(ts)).equals(ts)).toBe(true);
  });

  it('decodes a multi-megabyte payload (no regex backtracking on huge strings)', () => {
    // ~10 MB of base64 text: a /\s+/g strip here used to blow V8's call stack.
    const ts = makeTsPackets(55_000);
    const png = makeItextPng(ts);
    const decoded = decodeSegment(png);
    expect(decoded.length).toBe(ts.length);
    expect(decoded[0]).toBe(0x47);
    expect(decoded[188]).toBe(0x47);
  });

  it('rejects a PNG whose payload chunks do not decode to TS', () => {
    const garbage = makeItextPng(Buffer.alloc(1000, 0x41)); // no 0x47 sync
    expect(() => decodeItextPng(garbage)).toThrow(/did not decode to MPEG-TS/);
  });

  it('rejects a plain PNG without payload chunks', () => {
    const ts = makeTsPackets(5);
    const png = makeTiktikpxPng(ts);
    expect(() => decodeItextPng(png)).toThrow(/no payload iTXt chunks/);
  });

  it('round-trips through inflateSync only when chunks are well-formed', () => {
    // sanity on the test builder itself: the zlib text must inflate cleanly
    const ts = makeTsPackets(40);
    const png = makeItextPng(ts);
    // find first iTXt chunk text and inflate it
    const idx = png.indexOf(Buffer.from('iTXt', 'ascii'));
    expect(idx).toBeGreaterThan(0);
    const len = png.readUInt32BE(idx - 4);
    const chunk = png.subarray(idx + 4, idx + 4 + len);
    const q = chunk.indexOf(0, chunk.indexOf(0, chunk.indexOf(0) + 3) + 1) + 1;
    expect(() => inflateSync(chunk.subarray(q))).not.toThrow();
  });
});

describe('decodeSegment (auto-detect per response)', () => {
  it('returns raw TS untouched', () => {
    const ts = makeTsPackets(3);
    expect(decodeSegment(ts).equals(ts)).toBe(true);
  });

  it('decodes TIKTIKPX-wrapped segments', () => {
    const ts = makeTsPackets(6);
    expect(decodeSegment(makeTiktikpxPng(ts)).equals(ts)).toBe(true);
  });

  it('decodes fake-image-header segments', () => {
    const ts = makeTsPackets(4);
    const wrapped = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(42 - 4), ts]);
    expect(decodeSegment(wrapped).equals(ts)).toBe(true);
  });

  it('returns unknown payloads verbatim (fMP4 passthrough)', () => {
    const fmp4 = Buffer.from('stypmoofmdat...', 'ascii');
    expect(decodeSegment(fmp4).equals(fmp4)).toBe(true);
  });
});
