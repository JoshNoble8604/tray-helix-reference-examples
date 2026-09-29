/**
 * Postgres access. Only the pieces the RBAC design needs.
 *
 * The important one is `ensureDb()`: inside a scoped request it returns that
 * request's transaction (see request-scope.ts), so every module that reads the
 * database gets the tenant scope without knowing it exists.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../db/schema";
import { setting } from "./http";

export { schema };
export type Db = PostgresJsDatabase<typeof schema>;

let db: Db | null = null;

/**
 * The scoped transaction for the current request. AsyncLocalStorage, not a
 * module-level variable: a global would silently apply one request's tenant
 * scope to another's query the moment two requests share a process.
 */
const scopedTx = new AsyncLocalStorage<Db>();

export function runWithScopedDb<T>(tx: Db, fn: () => Promise<T>): Promise<T> {
  return scopedTx.run(tx, fn);
}

export function currentScopedDb(): Db | null {
  return scopedTx.getStore() ?? null;
}

/**
 * The request's transaction if there is one, else the connection.
 *
 * Always go through this; never hold on to a `Db` captured earlier. A read on
 * a different connection has no scope set, so once RLS is armed it returns
 * nothing rather than erroring. With `max: 1` it is worse: it queues behind the
 * open transaction that holds the only connection, and the request hangs.
 */
export async function ensureDb(): Promise<Db> {
  const scoped = scopedTx.getStore();
  if (scoped) return scoped;
  if (db) return db;
  const url = setting("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is not set");
  const [{ drizzle }, { default: postgres }] = await Promise.all([
    import("drizzle-orm/postgres-js"),
    import("postgres"),
  ]);
  // One request per invocation: a pool buys nothing and costs pooler slots.
  // `prepare: false` is required by transaction-mode poolers.
  const client = postgres(url, { max: 1, prepare: false, idle_timeout: 180, connect_timeout: 10 });
  db = drizzle(client, { schema });
  return db;
}

/** Test seam: inject a drizzle instance (the tests use PGlite). */
export function setDb(next: Db | null): void {
  db = next;
}

/** Rows from `db.execute()`, whichever driver answered (postgres.js: array; PGlite: {rows}). */
export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])) as T[];
}
