# Migración KV -> Relacional

- Colecciones existentes (`Collection`) siguen funcionando. Son el
  sustrato zero-copy.
- Para migrar: define `RelationalTable` con mismo nombre, inserta filas
  desde `collection.scan` manual (itera PKs conocidas).
- Claves: `users:alice` (KV) -> `tbl:users:alice` (relacional). Script
  de migración recorre ART vía lista de PKs en app (fase 1) o `scanRange`
  nativo (fase 2).
- Sin downtime single-node: doble escritura durante migración, luego
  `drop` de colección vieja (ART `remove`).
