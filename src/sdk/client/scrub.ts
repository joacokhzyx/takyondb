/**
 * ============================================================================
 * File: scrub.ts
 * Description: Scrubber mirror with native kernels plus pure-TS fallback.
 *   Verifies `record_crc`-sealed KV envelopes (TREC magic + CRC32) and
 *   walks concatenated extents reporting { ok, corrupt, bytes, truncated }.
 *   The TS fallback implements the identical layout LE so E2E and unit
 *   tests exercise the same semantics without a built addon.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { TakyonBindings } from './proxy';

export const REC_MAGIC = 0x54524543;
export const REC_VERSION = 1;
export const REC_HEADER_LEN = 10;
export const REC_CRC_LEN = 4;
export const REC_OVERHEAD = REC_HEADER_LEN + REC_CRC_LEN;

export interface ScrubReport {
  readonly ok: number;
  readonly corrupt: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

function crc32IEEE(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function view32(buf: Uint8Array, off: number): number {
  // Unsigned: bitwise OR yields signed i32, but CRCs live in u32 space.
  return (
    (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! * 0x1000000)) >>>
    0
  );
}

/** Seals a payload (mirrors Zig record_crc.seal). */
export function sealRecord(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(REC_OVERHEAD + payload.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, REC_MAGIC, true);
  v.setUint16(4, REC_VERSION, true);
  v.setUint32(6, payload.length, true);
  const crc = crc32IEEE(Buffer.concat([out.subarray(0, REC_HEADER_LEN), payload]));
  v.setUint32(REC_HEADER_LEN, crc, true);
  out.set(payload, REC_OVERHEAD);
  return out;
}

/** Verifies one sealed envelope (pure TS). */
export function verifyRecordFallback(buf: Uint8Array): boolean {
  if (buf.length < REC_OVERHEAD) return false;
  if (view32(buf, 0) !== REC_MAGIC) return false;
  if ((buf[4]! | (buf[5]! << 8)) !== REC_VERSION) return false;
  const plen = view32(buf, 6);
  if (buf.length < REC_OVERHEAD + plen) return false;
  const crc = crc32IEEE(Buffer.concat([buf.subarray(0, REC_HEADER_LEN), buf.subarray(REC_OVERHEAD, REC_OVERHEAD + plen)]));
  return view32(buf, REC_HEADER_LEN) === crc;
}

/** Verifies one envelope, preferring the native kernel. */
export function verifyRecord(bindings: TakyonBindings | undefined, buf: Uint8Array): boolean {
  const fn = bindings?.verify_record;
  if (fn) {
    try {
      return fn.call(bindings, buf);
    } catch {
      // Fall through.
    }
  }
  return verifyRecordFallback(buf);
}

function declaredLen(buf: Uint8Array): number | null {
  if (buf.length < REC_HEADER_LEN) return null;
  if (view32(buf, 0) !== REC_MAGIC) return null;
  if ((buf[4]! | (buf[5]! << 8)) !== REC_VERSION) return null;
  return view32(buf, 6);
}

/** Walks concatenated envelopes (pure TS). */
export function scrubFallback(buf: Uint8Array): ScrubReport {
  let ok = 0;
  let corrupt = 0;
  let bytes = 0;
  let truncated = false;
  let off = 0;
  while (off < buf.length) {
    const rest = buf.subarray(off);
    const plen = declaredLen(rest);
    if (plen === null) {
      if (rest.every((b) => b === 0)) break;
      corrupt += 1;
      break;
    }
    if (rest.length < REC_OVERHEAD + plen) {
      truncated = true;
      break;
    }
    if (!verifyRecordFallback(rest.subarray(0, REC_OVERHEAD + plen))) {
      corrupt += 1;
      break;
    }
    ok += 1;
    bytes += REC_OVERHEAD + plen;
    off += REC_OVERHEAD + plen;
  }
  return { ok, corrupt, bytes, truncated };
}

/** Walks concatenated envelopes, preferring the native kernel. */
export function scrubRecords(bindings: TakyonBindings | undefined, buf: Uint8Array): ScrubReport {
  const fn = bindings?.scrub_records;
  if (fn) {
    try {
      return fn.call(bindings, buf);
    } catch {
      // Fall through.
    }
  }
  return scrubFallback(buf);
}
