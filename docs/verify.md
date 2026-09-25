# Cómo verificar

```bash
zig fmt --check src/ build.zig
zig build test # 73/73 en Linux
cd src/sdk/ts && npm run test # tsc --noEmit + 27 archivos / 97 tests
node scripts/check_relational.js # 23 archivos / 69 tests relacionales
node scripts/docs_check.js # referencias de docs
node scripts/e2e_relational_test.js
node scripts/bench_relational.js # requiere dist: cd src/sdk/ts && npm run build
node scripts/run-e2e.js # 8 suites (incl. catalog; prebuild de dist automático)
```
