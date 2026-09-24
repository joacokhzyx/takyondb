# Operación relacional

- Daemon flags iguales (`--data-dir`, `--checkpoint-sec`, `--port`).
- Tablas no requieren migración de daemon: usan mismo `data.takyon`.
- `HEALTH/METRICS` ya exponen `ring_depth/wal_bytes/uptime`; añade
  `CHECKPOINT` tras batches grandes (`trigger_checkpoint`).
- Backup: copia `data.takyon + data.takyon.snap` con daemon parado o
  tras `CHECKPOINT` + pausa de escrituras.
