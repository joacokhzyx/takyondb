# Modelo de datos relacional

## Tabla

- `name`: `1..64` chars, `[a-zA-Z_][a-zA-Z0-9_]*`, NUL-free.
- `columns`: lista ordenada, `1..32` columnas.
- `primaryKey`: una columna, inmutable, `NOT NULL`, `UNIQUE`.
- Filas: header fijo + columnas fijas + fat pointers para variable.

## Tipos (fase 1)

`bool | int8 | int16 | int32 | int64 | uint8 | uint16 | uint32 | float32 |
float64 | string | bytes | timestamp_ms`

Mapeo físico:

- fijos: `1/2/4/8B LE`, `bool=1B (0/1)`, `timestamp_ms=int64`.
- variable: `string/bytes = 8B fat pointer (u32 offset + u32 len)` en
  `Strings Arena`, igual que `proxy.ts` actual.
- `NULL`: bitmap en header de fila (1 bit por columna nullable).

## Fila física

`[u32 magic | u16 version | u16 null_bitmap_len | null_bitmap | columnas...]`

- `magic=0x54524F57 ("TROW")`, `version=1`.
- Checksum `CRC32` opcional fase 2 (hoy WAL ya protege torn writes).

## Claves en ART

- PK: `"tbl:<table>:<pk_string>" -> offset`.
- Secundario: `"idx:<table>:<col>:<val>" -> pk` (lista si no-unique, fase 1
  permite duplicados con sufijo `#n`).
- Catálogo: `"__catalog__:<table>" -> offset` (schema serializado fijo).

Todo cabe en el único ART actual sin cambiar Zig (fase 1 TS).
Fase 2 Zig añadirá raíces ART múltiples + scan nativo.
