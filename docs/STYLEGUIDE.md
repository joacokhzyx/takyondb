# TakyonDB Style Guide

This style guide establishes strict formatting, naming conventions, and documentation rules for the TakyonDB project. Consistency is critical for a high-performance, system-level storage engine.

---

## 1. Naming Conventions

### Zig (`src/core/`)
*   **Files:** `snake_case.zig`
*   **Variables, Struct Fields, & Function Names:** `snake_case`
*   **Structs, Unions, Enums, & Types:** `PascalCase`
*   **Constants & Comptime variables:** `ALL_CAPS` or `camelCase` depending on usage context, but `snake_case` or `PascalCase` for types is preferred.

### TypeScript (`src/sdk/`)
*   **Files:** `snake_case.ts` (actual tree: `client/proxy.ts`, `client/schema.ts`, `client/layout.ts`, `takyon.ts`, `index.ts`)
*   **Variables, Fields, & Functions:** `camelCase`
*   **Classes, Interfaces, & Enums:** `PascalCase`
*   **Constants:** `UPPER_SNAKE_CASE`

---

## 2. Formatting Requirements

*   **Zig Core:** Every commit must run and pass `zig fmt`. Unformatted Zig code will fail CI gates.
*   **TypeScript SDK:** Uses `prettier` for code formatting and `eslint` for linting. All code must compile cleanly without warnings or errors.

---

## 3. File headers

A source file states what it is for in one line, at the top, and nothing
else. The banner format this guide used to mandate — filename, author,
license, in a box — was removed on purpose: it repeated the filename the
reader can already see, and across the SDK it was 42% of all comments in
`src/`. The Zig files that still carry a license line keep it; nothing
requires it, and adding one is not a contribution.

What every file does owe the reader is a statement of purpose, in prose,
written by whoever wrote the module.

## 4. Tests

Every Zig module carries inline `test "..."` blocks, aggregated into
`zig build test` by `src/core/test.zig`. Every TypeScript module has a
sibling `*.test.ts`. A module without either is a gap, and it is visible
in review rather than in a coverage report nobody reads.

A test that cannot fail is worse than no test. If an assertion cannot
tell success from a broken system, fix the assertion or mark the case
`xfail` with the reason.

## 5. Docstrings and function documentation

Every public function, structure, or interface must have explicit comments outlining behavior, parameters, returns, and error handling states.

### Zig Rules
*   Use triple-slash `///` documentation comments for public items.
*   **Allocator Policy:** If a function performs any memory allocation, it MUST accept an `Allocator` parameter and document whether it can fail (e.g., return `error.OutOfMemory`). Avoid hidden allocations.

```zig
/// Maps a zero-copy shared memory segment for the database file.
///
/// Arguments:
///   - `allocator`: Memory allocator used for internal bookkeeping structures.
///   - `path`: The absolute file path of the database.
///
/// Returns:
///   - A pointer to the mapped virtual memory segment, or an error.
///
/// Errors:
///   - `error.OutOfMemory` if bookkeeping allocations fail.
///   - `error.FileNotFound` if the target path does not exist.
pub fn mapSharedMemory(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    // ...
}
```

### TypeScript Rules
*   Use JSDoc formatting (`/** ... */`) for TS classes, interfaces, and public methods.
*   Document parameters and return types clearly.

```typescript
/**
 * Proxies a shared memory buffer to mutate objects directly.
 * 
 * @param buffer - The mapped shared memory buffer.
 * @param layout - The byte offset mapping descriptor.
 * @returns A transparent Proxy object.
 * @throws {MemoryAccessError} If layout bounds are violated.
 */
export function createMemoryProxy(buffer: ArrayBuffer, layout: LayoutDescriptor): object {
    // ...
}
```

---

## 6. Rules that are not formatting

* **No hidden allocation.** A Zig function that allocates takes an
  `Allocator` and documents whether it can fail with
  `error.OutOfMemory`. A caller that cannot see the allocation cannot see
  the failure.
* **No magic numbers.** Use the constants in
  `src/core/memory/layout.zig`. They exist so that the arena map has one
  definition instead of several that agree until they do not.
* **No comment that restates the code.** `// Allocate offset for this
  record` above a call to `allocateRecordOffset` is deleted. A comment
  earns its place by saying what the code cannot: why, what breaks
  otherwise, what the history was.
* **US English, and check the diff before pushing.** A find-and-replace
  has already put `alignmint` inside a live parameter name in this
  codebase.
