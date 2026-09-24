# Índices

- PK: ART nativo, `O(k)` punto, lock-free.
- Secundario fase 1 (TS): namespace `idx:<tbl>:<col>:<val>->pk`.
  `UNIQUE` rechaza duplicado; no-unique concatena `#<n>`.
- Mirror PK (`client/relational/mirror.ts:ArtMirror`): publica
  `tbl:<tabla>:<pk> -> offset` en el ART del motor vía
  `insert_index/search_index/remove_index`, así las PKs relacionales
  reutilizan WAL, snapshots y recovery en vez de un mapa paralelo.
  Los offsets deben ser reales (`TakyonDB.allocateRecordOffset`).
- Mantenimiento síncrono en `insert/update/delete` (mismo ring, misma
  durabilidad WAL). Sin background async que rompa lecturas.
- Fase 2 (Zig): raíces ART múltiples + `scanRange(prefix)` nativo para
  range queries sin roundtrips N-API.

No se copia B-tree con page locks. ART + bump + vacuum ya dan
concurrencia y GC de strings.
