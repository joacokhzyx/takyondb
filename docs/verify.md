# Cómo verificar

```bash
zig fmt --check src/ build.zig
zig build test # 41/42 (1 preexistente)
cd src/sdk/ts && npm run test:unit # 54 passed
node scripts/e2e_relational_test.js
node scripts/bench_relational.js
```
