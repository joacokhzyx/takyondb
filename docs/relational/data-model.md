# Data model

Types, tables, and the physical row format.

## Tables

* `name` must match `[a-zA-Z_][a-zA-Z0-9_]*`. There is no separate length
  rule; the identifier pattern is the whole rule.
* `columns` is an ordered array of 1 to 32 definitions, with exactly one
  primary key.
* The primary key is immutable, `NOT NULL` and `UNIQUE`.
* Names longer than one byte are fine as long as they match the pattern.
  A previous revision of this page claimed a `1..64` character limit that
  nothing enforced.

## Types

```text
bool  int8  int16  int32  int64  uint8  uint16  uint32
float32  float64  string  bytes  timestamp_ms
```

The physical mapping:

| Kind | Types | Encoding |
|---|---|---|
| Fixed | `bool`, the integers, `float32`, `float64`, `timestamp_ms` | 1, 2, 4 or 8 bytes, little-endian. `bool` is one byte, 0 or 1. `timestamp_ms` is `int64` |
| Variable | `string`, `bytes` | An 8-byte fat pointer: `u32` offset plus `u32` length, into the engine's string region |
| Null | Any nullable column | One bit per column in the row's null bitmap |

## The physical row

```text
[u32 magic | u16 version | u16 null_bitmap_len | u32 crc32 | bitmap | columns...]
```

* `magic` is `0x54524F57`, `"TROW"`.
* `version` is `1`.
* `crc32` covers bytes `[0..8)` plus everything after the 12-byte header,
  so neither the header nor the payload can be altered without detection.
  `row.zig` implements `initHeader`, `seal` and `verify`, with tamper
  tests.

An earlier revision of this page called that checksum optional and
"phase 2". It is implemented, tested and exported, and it is not optional:
what is not wired is the daemon writing every row through `seal`. A row
sealed by hand verifies; a row written by the current write path does not
carry a checksum yet. That gap is in [../next-steps.md](../next-steps.md).

## Keys in the index

| Namespace | Form | Points at |
|---|---|---|
| Primary key | `tbl:<table>:<pk>` | A record offset |
| Secondary index | `idx:<table>:<col>:<padded value><U+001F><pk>` | A record offset, one entry per pair |
| Catalog | `__catalog__:<table>` | A serialized table definition |

The separator is `0x1F`, not the `#n` suffix an earlier revision of this
page described. Values are padded so byte order equals numeric order, and
`pk` follows the separator so one value can map to many rows.

Everything fits in the engine's one radix index without a second tree,
which is the property that lets a relational key share the log, the
snapshots and recovery with a key-value one. See
[indexes.md](indexes.md).

## Sizes

| Limit | Value |
|---|---|
| Columns per table | 1 to 32 |
| Result rows per query call | 10,000 |
| Native scan offsets per call | 4,096 |
| Primary key length | 1 to 256 bytes, NUL-free |

The full table with the gate that relaxes each row is in
[limits.md](limits.md).
