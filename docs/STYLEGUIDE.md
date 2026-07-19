# TakyonDB Style Guide

This style guide establishes strict formatting, naming conventions, and documentation rules for the TakyonDB project. Consistency is critical for a high-performance, system-level storage engine.

---

## 1. Naming Conventions

### Zig (`src/core/`)
*   **Files:** `snake_case.zig`
*   **Variables, Struct Fields, & Function Names:** `snake_case`
*   **Structs, Unions, Enums, & Types:** `PascalCase`
*   **Constants & Comptime variables:** `ALL_CAPS` or `camelCase` depending on usage context, but `snake_case` or `PascalCase` for types is preferred.

### TypeScript (`src/sdk/ts/`)
*   **Files:** `kebab-case.ts` (or `PascalCase.ts` for classes)
*   **Variables, Fields, & Functions:** `camelCase`
*   **Classes, Interfaces, & Enums:** `PascalCase`
*   **Constants:** `UPPER_SNAKE_CASE`

---

## 2. Formatting Requirements

*   **Zig Core:** Every commit must run and pass `zig fmt`. Unformatted Zig code will fail CI gates.
*   **TypeScript SDK:** Uses `prettier` for code formatting and `eslint` for linting. All code must compile cleanly without warnings or errors.

---

## 3. Mandatory Documentation Headers

Every source file must begin with a structured header detailing its file name, purpose, author/maintenance information, and license notices.

### Zig Header Template
```zig
// ============================================================================
// File: [filename.zig]
// Description: [Provide a brief, high-level overview of the module logic]
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
// ============================================================================
```

### TypeScript Header Template
```typescript
/**
 * ============================================================================
 * File: [filename.ts]
 * Description: [Provide a brief, high-level overview of the module/class]
 * Author/Maintainer: TakyonDB Team
 * License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
 * ============================================================================
 */
```

---

## 4. Docstrings & Function Documentation

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
