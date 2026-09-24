# Índices

- PK: ART nativo, `O(k)` punto, lock-free.
- Secundario fase 1 (TS): namespace `idx:<tbl>:<col>:<val>->pk`.
  `UNIQUE` rechaza duplicado; no-unique concatena `#<n>`.
- Mantenimiento síncrono en `insert/update/delete` (mismo ring, misma
  durabilidad WAL). Sin background async que rompa lecturas.
- Fase 2 (Zig): raíces ART múltiples + `scanRange(prefix)` nativo para
  range queries sin roundtrips N-API.

No se copia B-tree con page locks. ART + bump + vacuum ya dan
concurrencia y GC de strings.
