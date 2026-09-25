# Rendimiento relacional

- Lectura punto PK: mismo motor ART que el KV, a traves del addon
  (`ArtMirror`, prefijo `tbl:<tabla>:<pk>`). No hay medicion propia de PK
  relacional: la cifra de chaos (`p50 ~0.002 ms`) es del camino KV y es una
  referencia, no una medida de este camino.
- Scan: `O(n)` sobre filas, con proyeccion temprana. `table.scan()` copia cada
  fila (`{...r}`), asi que el scan **si** asigna; la proyeccion reduce el
  trabajo posterior, no la copia.
- Filtro: `matchesWhere` sobre objetos JS, **no** una comparacion en
  `DataView` y **no** sin alloc: esa afirmacion estaba en esta pagina y era
  falsa. Ahora la clausula se compila **una vez** por consulta (cache
  `WeakMap` sobre el propio objeto `where`) en vez de por fila: antes cada fila
  llamaba `Object.entries(where)` y cada `like` compilaba un `new RegExp` por
  fila *y* por predicado. Medido sobre 20k filas (3 corridas por estado, rango
  completo): **3122-5207 us -> 735-754 us**, ~4.3x, con los rangos sin
  solaparse. `in` con 8+ elementos pasa a un `Set` compilado una vez.
  Colateralmente, `like` ahora escapa los metacaracteres de RegExp, asi que un
  `.` en el patron es un punto literal y no un comodin.
  El camino SIMD (`filterU32/filterF64` en
  `src/core/relational/column.zig`) existe y esta expuesto por C-ABI y N-API,
  pero el filtro relacional de TS **todavia no lo invoca**.
- Join hash: build en `Map<val, pk[]>`, probe streaming. `left.scan()` y
  `right.scan()` copian todas las filas antes del probe.
- Agregacion: single-pass en TS con `Math.min(...vals)` / `Math.max(...vals)`,
  que Makefan sobre la pila de llamadas y es un riesgo para columnas grandes;
  iterar en un bucle avoids el limite. Los kernels Zig
  (`kahanSum`/`kahanSumSelected`/`minSelected`/`maxSelected`) estan en
  `src/core/relational/column.zig`, expuestos por C-ABI
  (`takyon_filter_u32/f64`, `takyon_agg_*_selected`) y N-API (`filter_u32/f64`,
  `agg_sum*`), y replicados en `pushdown.ts` con fallback TS identico. El
  columnarizado arena→kernel (zero-copy) sigue siendo trabajo futuro: hoy el TS
  columnariza filas en `Float64Array`.
- Strings: bump + vacuum con doble buffer ya existente.

Nota sobre el bench: `benchmarks/relational/bench.js` mide el motor de TS sin
pushdown nativo, asi que **no** mide los kernels SIMD. Reporta su hardware,
sus semillas por tabla y su metodologia en la salida JSON; ver
[../performance-truth.md](../performance-truth.md) para que significan (y que
no significan) sus numeros.

Harnesses: `benchmarks/relational/bench.js` (seeded) con wrappers por
operacion (`insert/scan/filter/join/agg.js`), o `node scripts/bench_relational.js`.

## Cómo correr

```bash
cd src/sdk/ts && npm run build   # dist requerido por el bench
node benchmarks/relational/bench.js all        # todas las suites
node benchmarks/relational/filter.js           # una suite
node scripts/bench_relational.js               # entrada CI
```

Nativo (requiere `zig build`):

```bash
node scripts/bench_scan.js 10000  # point vs prefix scan vs rango
```

Workload: `20k` filas, semillas LCG por tabla (`users: 42`, `orders: 7`),
`p50/p95/p99` via `performance.now()`, mas `best_p50_ms` como minimo entre
repeticiones. Reporta hardware completo (plataforma, arch, modelo de CPU,
nucleos, memoria, version de Node). Corre como gate en `Relational Checks`
(solo completamiento y aserciones de filas: los tiempos son informativos
porque el hardware compartido de CI no es una referencia estable).
