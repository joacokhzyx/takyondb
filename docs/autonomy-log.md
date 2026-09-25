# Autonomía total (bitácora)

- Agentes no necesarios para fase 1; trabajo directo con commits atómicos.
- Cada módulo TS/Zig + test + docs en commits separados convencionales.
- Verificación continua: `zig fmt`, `zig build test`, `vitest`.
- Fallo preexistente (`vacuum WAL-logged relocation`) intacto, no introducido.
- Nota posterior: ese fallo se corrigió (`OFF_B` 20 → 28, offsets disjuntos);
  `zig build test` va 73/73. Se conserva la línea anterior como registro.
