# Styleguide relacional

- TS: `camelCase` funciones, `PascalCase` clases, `UPPER_SNAKE` consts.
- Zig: `snake_case` funciones, `PascalCase` tipos, `ALL_CAPS` consts.
- Sin magic numbers: usa `layout.zig/layout.ts` y `types.ts/types.zig`.
- Funciones puras donde sea posible; documenta `Allocator` si allocas.
