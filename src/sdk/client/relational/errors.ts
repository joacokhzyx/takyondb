/**
 * ============================================================================
 * File: errors.ts
 * Description: Typed errors for the relational layer.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

export class RelationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelationalError';
  }
}

export class TableExistsError extends RelationalError {
  constructor(table: string) {
    super(`table '${table}' already exists`);
    this.name = 'TableExistsError';
  }
}

export class TableNotFoundError extends RelationalError {
  constructor(table: string) {
    super(`table '${table}' not found`);
    this.name = 'TableNotFoundError';
  }
}

export class ConstraintError extends RelationalError {
  constructor(message: string) {
    super(message);
    this.name = 'ConstraintError';
  }
}

export class QueryError extends RelationalError {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}
