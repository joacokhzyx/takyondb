# Query API

```ts
const db = new RelationalDatabase(takyon);
const users = db.createTable('users', {
  columns: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'age', type: 'uint32' },
    { name: 'balance', type: 'float64', nullable: true },
  ],
});
users.insert({ id: 'u1', age: 28, balance: 10.5 });
db.from('users').where({ age: { gte: 18 } }).select(['id','age']).limit(10).all();
db.from('users').count();
db.from('orders').join(users, 'user_id', 'id').select(['*']).all();
```

- `where`: `eq/ne/gt/gte/lt/lte/in/like` por columna, `AND` implícito, `OR` vía array.
- `select`: proyección (zero-copy: solo lee columnas pedidas).
- `orderBy/limit/offset`, agregaciones `count/sum/avg/min/max`.
- Ejecución TS fase 1: scan por registro de PKs en memoria + `find()` zero-copy.
  Fase 2: pushdown a Zig (filtro SIMD, agregación vectorizada).
