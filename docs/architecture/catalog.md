# Catálogo persistente

Fase 1: catálogo en memoria (`Map<table,TableDef>`) + WAL implícito
vía deltas de filas. Al reiniciar, la app recrea tablas (mismo schema)
y los datos sobreviven en snapshot+WAL (ART + arenas). DDL JSON lateral
(`catalog_store.ts`: `saveCatalog/loadCatalogDefs/restoreCatalog`) como
puente operativo.

Fase 2 (shipped): `__catalog__:<table>` records con schema serializado fijo
(magic + version + columnas), cubiertos por snapshot verificado y
recovery two-pass. `CREATE TABLE IF NOT EXISTS` idempotente.
Codec fijo Zig (`persist.zig`: `encode/decodeHeader/decodeColumn`,
tamper tests) + `catalogKey/isCatalogKey` (`index.zig`) + espejo TS
(`catalog_record.ts`: mismo layout LE + `CatalogRecordStore` save/load vía
ART + string arena) + E2E reboot (`e2e_catalog_reboot_test.js`: DDL sobrevive
SIGKILL sin JSON, en CI).
