# Límites relacionales (fase 1)

- Tablas: `<=256` por DB, columnas `1..32`, nombre `1..64`.
- PK: `1..256B UTF-8`, NUL-free (heredado de ART).
- Filas: `totalSize <= 2MB - RECORD_START`, strings en arena `10MB+`.
- Resultados: `MAX_RESULT_ROWS=10k` por llamada (paginación vía `limit/offset`).
- Sin `NULL` en PK, `UNIQUE` solo validado en memoria (fase 1).
