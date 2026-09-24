# Arquitectura relacional (overview)

```
TS SDK (Database/Table/Query/Join/Tx/SQL)
  -> validación + plan lógico
  -> ART namespaced (tbl:/idx:/__catalog__) vía C-ABI existente
  -> RingBuffer MPMC -> WAL segmentado -> snapshot atómico
  -> SharedArena zero-copy (records + strings + ART)
```

Fase 2 Zig añade: raíces ART múltiples, `scanRange`, filtro SIMD,
agregación vectorizada, vacuum multi-columna ya iniciado.

Nada de TCP JSON. Nada de B-tree con locks. Todo reutiliza lo mejor
de Takyon: lock-free, bump allocators, CRC WAL, vacuum.
