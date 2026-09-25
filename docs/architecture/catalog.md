# Catálogo persistente

Fase 1: catálogo en memoria (`Map<table,TableDef>`) + WAL implícito
vía deltas de filas. Al reiniciar, la app recrea tablas (mismo schema)
y los datos sobreviven en snapshot+WAL (ART + arenas). DDL JSON lateral
(`catalog_store.ts`: `saveCatalog/loadCatalogDefs/restoreCatalog`) como
puente operativo.

Fase 2 (en curso): `__catalog__:<table>` records con schema serializado fijo
(magic + version + columnas), cubiertos por snapshot verificado y
recovery two-pass. `CREATE TABLE IF NOT EXISTS` idempotente.
Shipped: codec fijo Zig (`persist.zig`: `encode/decodeHeader/decodeColumn`,
tamper tests) + `catalogKey/isCatalogKey` (`index.zig`) + espejo TS
(`catalog_record.ts`: mismo layout LE, round-trip + tamper tests).
Pendiente: E2E reboot que escribe `__catalog__` vía ART y restaura sin JSON.
