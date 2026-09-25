# Backup relacional

1. `echo CHECKPOINT | nc 127.0.0.1 7723` (o SDK `triggerCheckpoint()`).
2. Espera `ring_depth=0` en `METRICS`.
3. Copia `data.takyon` + `data.takyon.snap` del `--data-dir`.
4. Copia el catálogo DDL (`saveCatalog(db, '<data-dir>/catalog.json')`):
   sin él, un reinicio recupera los datos pero no los schemas.
5. Restaura copiando todo y arrancando el daemon (recovery verifica CRC),
   luego `restoreCatalog(db, '<data-dir>/catalog.json')` (idempotente).
