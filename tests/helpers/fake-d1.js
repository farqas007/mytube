// =============================================================================
// MyTube — real-SQLite D1 test double (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// A D1-like binding backed by node:sqlite. Unlike the older hand-rolled stubs
// this one executes every statement in real SQLite, so FTS5 MATCH, bm25(),
// joins, triggers, ON CONFLICT and rowid all behave the way they do in D1.
// That is what makes it usable for the local-search work: relevance order,
// tie-breaking and the video_fts triggers are the things under test.
//
// The schema is not hand-written here. The real migrations/000N_*.sql files are
// read and applied in order, so the fake can never drift from production D1.
//
// Exposes the D1 surface this repo uses: prepare() -> bind() -> first() / all()
// / run(), plus db.batch() with D1's atomic all-or-nothing semantics and its
// { success, meta: { changes } } result shape.
//
// Run: node --test tests/testFakeD1.js
// =============================================================================

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HELPERS_DIR, "..", "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "migrations");

// D1 accepts null, number, string, boolean, ArrayBuffer and TypedArray. It
// rejects undefined, and so must this fake: silently coercing it to null would
// let a real production 500 hide behind a passing local test.
function normalizeParam(value, position) {
  if (value === undefined) {
    throw new TypeError(
      "fake-d1: undefined cannot be bound (parameter " + (position + 1) +
      "). D1 rejects undefined too."
    );
  }

  if (value === null) {
    return null;
  }

  const type = typeof value;

  if (type === "string" || type === "number" || type === "bigint") {
    return value;
  }

  // SQLite has no boolean storage class.
  if (type === "boolean") {
    return value ? 1 : 0;
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }

  throw new TypeError(
    "fake-d1: cannot bind value of type " + type + " (parameter " + (position + 1) + ")"
  );
}

function normalizeParams(values) {
  // D1 accepts bind([a, b]) as well as bind(a, b).
  const list = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;

  return list.map(normalizeParam);
}

function runMeta(result) {
  return {
    changes: Number(result.changes ?? 0),
    last_row_id: Number(result.lastInsertRowid ?? 0)
  };
}

class FakeD1Statement {
  constructor(db, sql, params) {
    this._db = db;
    this._sql = sql;
    this._params = params;
  }

  // bind() returns a NEW statement, exactly like D1, so one prepared template
  // can be reused for many rows without them sharing bindings.
  bind(...values) {
    return new FakeD1Statement(this._db, this._sql, normalizeParams(values));
  }

  async first() {
    const row = this._execute("get") ?? null;
    this._db._record("first", this._sql);
    return row;
  }

  async all() {
    const rows = this._execute("all");
    this._db._record("all", this._sql);
    return { success: true, results: rows, meta: runMeta({ changes: 0 }) };
  }

  async run() {
    const result = this._execute("run");
    this._db._record("run", this._sql);
    return { success: true, meta: runMeta(result) };
  }

  _execute(method) {
    const prepared = this._db._prepare(this._sql);
    return prepared[method](...this._params);
  }
}

class FakeD1Database {
  constructor(options = {}) {
    const { migrations = MIGRATIONS_DIR, schema = null } = options;

    this._sqlite = new DatabaseSync(":memory:");
    this.stats = { prepare: 0, all: 0, first: 0, run: 0, batch: 0 };
    this.sqlLog = [];

    if (schema) {
      this._sqlite.exec(schema);
    }
    else if (migrations) {
      applyMigrations(this._sqlite, migrations);
    }
  }

  prepare(sql) {
    this.stats.prepare += 1;
    return new FakeD1Statement(this, sql, []);
  }

  // D1 runs a batch inside one transaction: either every statement applies or
  // none does. The result array is positional and carries the same shape the
  // caller already checks ({ success, meta: { changes } }).
  async batch(statements) {
    if (!Array.isArray(statements)) {
      throw new TypeError("fake-d1: db.batch() requires an array of prepared statements");
    }

    this.stats.batch += 1;
    this.sqlLog.push("BATCH(" + statements.length + ")");

    const results = [];
    this._sqlite.exec("BEGIN");

    try {
      for (const statement of statements) {
        if (!(statement instanceof FakeD1Statement)) {
          throw new TypeError("fake-d1: db.batch() received a non-prepared value");
        }

        this.sqlLog.push(statement._sql);
        results.push({ success: true, meta: runMeta(statement._execute("run")) });
      }
    }
    catch (error) {
      this._sqlite.exec("ROLLBACK");
      throw error;
    }

    this._sqlite.exec("COMMIT");
    return results;
  }

  // Convenience for test setup/teardown; not part of the D1 search surface.
  exec(sql) {
    return this._sqlite.exec(sql);
  }

  close() {
    this._sqlite.close();
  }

  _prepare(sql) {
    return this._sqlite.prepare(sql);
  }

  _record(kind, sql) {
    this.stats[kind] += 1;
    this.sqlLog.push(sql);
  }
}

export function applyMigrations(sqlite, dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter(name => name.endsWith(".sql")).sort();

  if (!files.length) {
    throw new Error("fake-d1: no migrations found in " + dir);
  }

  for (const file of files) {
    sqlite.exec(readFileSync(path.join(dir, file), "utf8"));
  }

  return files;
}

export function createFakeD1(options = {}) {
  return new FakeD1Database(options);
}

export default createFakeD1;
