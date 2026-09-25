# Relational core (Zig)

Módulos en `src/core/relational/`:

- `types.zig`: tipos físicos y tamaños.
- `catalog.zig`: `TableDef` con PK única.
- `row.zig`: bitmap NULL + magic/version + sealed 12B headers
  (`initHeader/seal/verify`, CRC32 over header + payload; tamper tests).
- `filter.zig`: `matchInt/matchFloat` sin alloc.
- `aggregation.zig`: acumulador streaming.
- `scan.zig`: `ScanCursor` sobre offsets.
- `query.zig`: `PlanKind/LimitSpec`.
- `join.zig`: probe por búsqueda binaria.
- `tx.zig`: `TxBatch` lógico.
- `column.zig`: kernels vectorizados (filtro SIMD 8 lanes → selection
  vector, suma Kahan) sobre slices prestados, sin allocar.

Más `ArtIndex.scanPrefix` (`src/core/index/art.zig`): colecta acotada del
subárbol bajo un prefijo (stack explícito, sin allocador, budget
anti-corrupción `65536`, `0` ante nodos corruptos). Expuesto como
`takyon_scan_prefix` (C-ABI) → `scan_prefix` (N-API, `Uint32Array`) →
`ArtMirror.scanTable` (TS, un roundtrip por tabla).

Y `ArtIndex.scanRange`: filtra por sufijo en [`lo`, `hi`] con poda del
subárbol provablemente sobre `hi` (complejidad del subárbol coincidente).
Expuesto como `takyon_scan_range` → `scan_range` → `ArtMirror.scanRange`.
E2E `e2e_scan_test.js` cubre ambos contra daemon vivo.

Nota de alcance: los kernels de `column.zig` operan sobre slices
prestados; el wiring que los alimenta desde filas de la arena
(tras `scanPrefix`/`scanRange`) es trabajo futuro — no se finge
integración que no existe.

Todos con tests unitarios, `zig fmt` limpio, integrados en
`src/core/test.zig` y expuestos vía `src/core/lib.zig`.
