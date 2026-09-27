/**
 * Verifies CRC-sealed record envelopes, preferring the native scrubber and
 * falling back to an identical TypeScript implementation of the same
 * little-endian layout. The fallback exists so tests exercise the real
 * semantics on a machine with no compiled addon.
 */

import { TakyonBindings } from './proxy';

/** `"CREC"` little-endian, the first four bytes of a sealed envelope. */
export const REC_MAGIC = 0x54524543;
/** Envelope format version this codec writes and accepts. */
export const REC_VERSION = 1;
/** Bytes of envelope header: magic, version, payload length. */
export const REC_HEADER_LEN = 10;
/** Bytes of the trailing CRC32. */
export const REC_CRC_LEN = 4;
/** Total bytes an envelope adds around its payload. */
export const REC_OVERHEAD = REC_HEADER_LEN + REC_CRC_LEN;

/** What one walk of a record extent found. */
export interface ScrubReport {
  /** Envelopes whose CRC verified. */
  readonly ok: number;
  /** Envelopes that failed verification. The walk stops at the first. */
  readonly corrupt: number;
  /** Bytes consumed by the intact envelopes. */
  readonly bytes: number;
  /** True when the walk stopped on a partial trailing envelope. */
  readonly truncated: boolean;
}

/**
 * CRC-32 with the IEEE polynomial, the same one `record_crc.zig` uses.
 * The final xor and the unsigned shift keep the result in u32 space.
 */
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

/**
 * Wraps a payload in a CRC-sealed envelope (mirrors Zig `record_crc.seal`).
 * The CRC covers the header and the payload but not itself.
 *
 * @param payload - The bytes to seal.
 * @returns A new array of `REC_OVERHEAD + payload.length` bytes.
 */
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

/**
 * Verifies one sealed envelope without the native kernel.
 * @param buf - The envelope, or a longer buffer starting with one.
 * @returns True when the magic, version, length, and CRC all agree.
 */
export function verifyRecordFallback(buf: Uint8Array): boolean {
  if (buf.length < REC_OVERHEAD) return false;
  if (view32(buf, 0) !== REC_MAGIC) return false;
  if ((buf[4]! | (buf[5]! << 8)) !== REC_VERSION) return false;
  const plen = view32(buf, 6);
  if (buf.length < REC_OVERHEAD + plen) return false;
  const crc = crc32IEEE(Buffer.concat([buf.subarray(0, REC_HEADER_LEN), buf.subarray(REC_OVERHEAD, REC_OVERHEAD + plen)]));
  return view32(buf, REC_HEADER_LEN) === crc;
}

/**
 * Verifies one envelope, preferring the native kernel.
 *
 * A bridge error is not a corrupt record: it means the addon is stale or
 * misbehaving, so this falls through to the TypeScript verifier rather than
 * reporting the record as bad.
 *
 * @param bindings - Native bindings, or undefined to go straight to the
 *   fallback.
 * @param buf - The envelope to verify.
 * @returns True when the envelope verifies.
 */
export function verifyRecord(bindings: TakyonBindings | undefined, buf: Uint8Array): boolean {
  const fn = bindings?.verify_record;
  if (fn) {
    try {
      return fn.call(bindings, buf);
    } catch {
      // Fall through to the TS verifier on bridge errors.
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

/**
 * Walks concatenated envelopes without the native kernel.
 *
 * Stops at the first failure rather than resynchronizing: the format has no
 * out-of-band length, so the next envelope's start cannot be located after a
 * corrupt one. A run of zero bytes is the arena's unwritten tail, not
 * corruption, so it ends the walk cleanly.
 *
 * @param buf - The extent to walk.
 * @returns Counts of intact and corrupt envelopes, bytes consumed, and
 *   whether the walk stopped on a partial trailing envelope.
 */
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

/**
 * Walks concatenated envelopes, preferring the native kernel.
 *
 * @param bindings - Native bindings, or undefined to go straight to the
 *   fallback.
 * @param buf - The extent to walk.
 * @returns The same report shape as `scrubFallback`, from whichever
 *   implementation ran.
 */
export function scrubRecords(bindings: TakyonBindings | undefined, buf: Uint8Array): ScrubReport {
  const fn = bindings?.scrub_records;
  if (fn) {
    try {
      return fn.call(bindings, buf);
    } catch {
      // Fall through to the TS walker on bridge errors.
    }
  }
  return scrubFallback(buf);
}
