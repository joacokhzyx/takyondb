# Transacciones

Fase 1: batch atómico lógico.

- `db.transaction(tx => { tx.insert(...); tx.update(...); })`
- Bufferiza ops en memoria, valida constraints, luego aplica en orden.
  Si falla validación, no aplica nada (rollback lógico).
- Durabilidad por op vía `pushDelta/notifyArena` + `checkpoint()` opcional
  al final (`trigger_checkpoint`).

Fase 2: MVCC ligero (row version + snapshot read) + WAL tx markers.
No se copia 2PC distribuido. Single-node primero.
