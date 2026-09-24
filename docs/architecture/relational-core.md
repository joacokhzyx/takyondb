# Relational core (Zig)

Módulos en `src/core/relational/`:

- `types.zig`: tipos físicos y tamaños.
- `catalog.zig`: `TableDef` con PK única.
- `row.zig`: bitmap NULL + magic/version.
- `filter.zig`: `matchInt/matchFloat` sin alloc.
- `aggregation.zig`: acumulador streaming.
- `scan.zig`: `ScanCursor` sobre offsets.
- `query.zig`: `PlanKind/LimitSpec`.
- `join.zig`: probe por búsqueda binaria.
- `tx.zig`: `TxBatch` lógico.

Todos con tests unitarios, `zig fmt` limpio, integrados en
`src/core/test.zig` y expuestos vía `src/core/lib.zig`.
