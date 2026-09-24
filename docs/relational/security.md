# Seguridad relacional

- Sin auth en daemon (localhost `127.0.0.1:7723` admin). Expón solo en
  red confiable; usa firewall/service mesh en producción futura.
- Valida longitudes de PK y columnas antes de `insert_index` (evita OOM).
- Ver `SECURITY.md` para reportes.
