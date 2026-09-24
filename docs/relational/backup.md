# Backup relacional

1. `echo CHECKPOINT | nc 127.0.0.1 7723` (o SDK `triggerCheckpoint()`).
2. Espera `ring_depth=0` en `METRICS`.
3. Copia `data.takyon` + `data.takyon.snap` del `--data-dir`.
4. Restaura copiando ambos y arrancando el daemon (recovery verifica CRC).
