/**
 * ============================================================================
 * File: scrub.test.ts
 * Description: Parity tests for the scrubber mirror (fallback path).
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { scrubFallback, scrubRecords, sealRecord, verifyRecord, verifyRecordFallback } from './scrub';

describe('scrub mirror', () => {
  it('seals and verifies', () => {
    const sealed = sealRecord(new TextEncoder().encode('hello'));
    expect(verifyRecordFallback(sealed)).toBe(true);
    expect(verifyRecord(undefined, sealed)).toBe(true);
    const bad = Uint8Array.from(sealed);
    bad[bad.length - 1] ^= 0x01;
    expect(verifyRecordFallback(bad)).toBe(false);
    expect(verifyRecordFallback(new Uint8Array(0))).toBe(false);
  });

  it('walks extents and stops at corruption', () => {
    const a = sealRecord(new TextEncoder().encode('alpha'));
    const b = sealRecord(new TextEncoder().encode('beta!'));
    const buf = new Uint8Array(a.length + b.length + 8);
    buf.set(a, 0);
    buf.set(b, a.length);
    const rep = scrubFallback(buf);
    expect(rep.ok).toBe(2);
    expect(rep.corrupt).toBe(0);
    expect(rep.bytes).toBe(a.length + b.length);

    const bad = Uint8Array.from(buf);
    bad[a.length + 14] ^= 0x01;
    const rep2 = scrubFallback(bad);
    expect(rep2.ok).toBe(1);
    expect(rep2.corrupt).toBe(1);
  });

  it('flags truncation', () => {
    const a = sealRecord(new TextEncoder().encode('full'));
    const b = sealRecord(new TextEncoder().encode('second'));
    const buf = new Uint8Array(a.length + b.length);
    buf.set(a, 0);
    buf.set(b, a.length);
    const rep = scrubFallback(buf.subarray(0, buf.length - 2));
    expect(rep.ok).toBe(1);
    expect(rep.truncated).toBe(true);
  });

  it('delegates to native when present', () => {
    const native = {
      verify_record: () => true,
      scrub_records: () => ({ ok: 7, corrupt: 0, bytes: 70, truncated: false }),
    } as never;
    expect(verifyRecord(native, new Uint8Array(20))).toBe(true);
    expect(scrubRecords(native, new Uint8Array(20)).ok).toBe(7);
  });
});
