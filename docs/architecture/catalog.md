# Catálogo persistente

Fase 1: catálogo en memoria (`Map<table,TableDef>`) + WAL implícito
vía deltas de filas. Al reiniciar, la app recrea tablas (mismo schema)
y los datos sobreviven en snapshot+WAL (ART + arenas).

Fase 2: `__catalog__:<table>` records con schema serializado fijo
(magic + version + columnas), cubiertos por snapshot verificado y
recovery two-pass. `CREATE TABLE IF NOT EXISTS` idempotente.
