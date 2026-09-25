# Índices

- PK: ART nativo, `O(k)` punto, lock-free.
- Secundario fase 1 (TS): namespace `idx:<tbl>:<col>:<val>->pk`.
  `UNIQUE` rechaza duplicado; no-unique concatena `#<n>`.
- Mirror PK (`client/relational/mirror.ts:ArtMirror`): publica
  `tbl:<tabla>:<pk> -> offset` en el ART del motor vía
  `insert_index/search_index/remove_index`, así las PKs relacionales
  reutilizan WAL, snapshots y recovery en vez de un mapa paralelo.
  Los offsets deben ser reales (`TakyonDB.allocateRecordOffset`).
- Secundario nativo (`client/relational/secondary_native.ts`):
  `NativeSecondaryIndex` guarda `idx:<tabla>:<col>:<valor><U+001F><pk>
  -> offset` en el mismo ART (durable + cross-process). `lookup`
  por valor exacto vía `scan_prefix`, `lookupRange` vía `scan_range`,
  `lookupNumericRange(lo,hi)` vía bounds `padU32Hex` (sin zero-pad manual),
  `cardinality()` vía `scan_prefix`, `UNIQUE` opcional.
- Mantenimiento síncrono en `insert/update/delete` (mismo ring, misma
  durabilidad WAL). Sin background async que rompa lecturas.
- Fase 2 (Zig, parcial entregado): raíces lógicas múltiples
  (`src/core/relational/multiroot.zig`: registry + flags UNIQUE +
  cardinalidad + pads hex `padU32Hex/padI64Hex16` NUL-free que preservan
  orden) + `scanRange(prefix)` nativo ya existente. Físico (un ArtIndex
  por offset de arena) futuro: rompería el formato snapshot.

No se copia B-tree con page locks. ART + bump + vacuum ya dan
concurrencia y GC de strings.
