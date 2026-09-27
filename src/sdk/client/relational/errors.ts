/** The error hierarchy the relational layer throws. Every subclass sets
 * `name` so a caller can branch on it after a cross-realm copy. */

/**
 * Base class for every relational error. `instanceof Error` alone is not a
 * useful test here, because the errors cross a `MessagePort` in some
 * embedding paths and lose their prototype; compare `name` instead.
 */
export class RelationalError extends Error {
  /**
   * @param message - Human-readable description, including the offending
   *   table, column, or key.
   */
  constructor(message: string) {
    super(message);
    this.name = 'RelationalError';
  }
}

/** Thrown by `RelationalDatabase.createTable` for a name already in use. */
export class TableExistsError extends RelationalError {
  /**
   * @param table - The name that was already taken.
   */
  constructor(table: string) {
    super(`table '${table}' already exists`);
    this.name = 'TableExistsError';
  }
}

/** Thrown when a table is looked up or dropped and no such table exists. */
export class TableNotFoundError extends RelationalError {
  /**
   * @param table - The name that was not found.
   */
  constructor(table: string) {
    super(`table '${table}' not found`);
    this.name = 'TableNotFoundError';
  }
}

/**
 * Thrown when a write would violate a declared constraint: a duplicate
 * primary key, an attempt to change one, or a UNIQUE conflict.
 */
export class ConstraintError extends RelationalError {
  /**
   * @param message - Description of the violated constraint.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ConstraintError';
  }
}

/** Thrown by the SQL parser for anything outside the supported subset. */
export class QueryError extends RelationalError {
  /**
   * @param message - Description of the parse failure, quoting the offending
   *   text.
   */
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}
