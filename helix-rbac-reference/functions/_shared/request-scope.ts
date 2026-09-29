/**
 * The per-request tenant scope that the RLS policies read.
 *
 * Each request is one transaction. It starts DENY-ALL, and the auth gates in
 * auth.ts narrow it the moment they know who is calling. The policies read two
 * settings: `app.tenant_scopes` and `app.is_service`.
 *
 * SET LOCAL semantics, never SET. The value must die with the transaction. A
 * session-level setting outlives the request on a pooled connection and hands
 * the next caller somebody else's tenants: isolation that occasionally leaks is
 * worse than none, because nobody is looking for it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { currentScopedDb, runWithScopedDb, type Db } from "./db";

export interface RequestScope {
  /**
   * Tenant ids. `"*"` is NOT special here: the policy compares list membership,
   * so a literal "*" would match a tenant named "*" and nothing else. Callers
   * route an all-tenants user down the service path instead (auth.ts).
   */
  tenantScopes: string[];
  /** The service path: bypasses tenant filtering by design. Defaults to false. */
  isService?: boolean;
}

/** Start of every request: sees nothing, privileged for nothing. */
export const DENY_ALL: RequestScope = { tenantScopes: [], isService: false };

/**
 * Encode scopes for `string_to_array(setting, ',')`. A tenant id containing a
 * comma would silently widen the scope, so anything outside [a-z0-9-] is
 * refused rather than trusted.
 */
export function encodeTenantScopes(scopes: string[]): string {
  for (const scope of scopes) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(scope)) {
      throw new Error(`request-scope: refusing an unencodable tenant scope: ${JSON.stringify(scope)}`);
    }
  }
  return scopes.join(",");
}

type Callback = () => Promise<void>;
const pending = new AsyncLocalStorage<{ afterCommit: Callback[]; afterEnd: Callback[] }>();

/**
 * Run `fn` after the request's transaction COMMITS.
 *
 * The whole handler is one transaction, so an inner `db.transaction()` is only
 * a savepoint and code after it can still roll back. Anything non-transactional
 * (a webhook, an email, a queue publish) must go here, or it announces a change
 * that may never exist. Outside a scoped request it runs immediately.
 */
export function onAfterCommit(fn: Callback): void {
  const queues = pending.getStore();
  if (!queues) return void fn();
  queues.afterCommit.push(fn);
}

/**
 * Run `fn` after the request's transaction ENDS, committed or rolled back.
 *
 * For bookkeeping about a refusal (a failed-auth counter, a sign-in knock). A
 * refusal throws, the throw rolls the transaction back, and a write made inside
 * it would vanish with it. `ensureDb()` inside `fn` returns the plain
 * connection, because the transaction is gone by then.
 */
export function onRequestEnd(fn: Callback): void {
  const queues = pending.getStore();
  if (!queues) return void fn();
  queues.afterEnd.push(fn);
}

/** Run `fn` in a transaction with `scope` applied. Everything the request reads happens inside. */
export async function withRequestScope<T>(db: Db, scope: RequestScope, fn: (tx: Db) => Promise<T>): Promise<T> {
  const queues = { afterCommit: [] as Callback[], afterEnd: [] as Callback[] };
  try {
    const result = await pending.run(queues, () =>
      db.transaction(async (tx) => {
        const scoped = tx as unknown as Db;
        await applyScopeTo(scoped, scope);
        return runWithScopedDb(scoped, () => fn(scoped));
      }),
    );
    // Committed. A failing callback must not turn a durable change into a 500
    // that invites a retry; callbacks record their own failures.
    await drain(queues.afterCommit);
    return result;
  } finally {
    await drain(queues.afterEnd);
  }
}

async function drain(callbacks: Callback[]): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch {
      /* the callback owns its failure handling */
    }
  }
}

/**
 * Narrow the scope of the transaction already in flight.
 *
 * Works because `app_users` has no RLS policy: auth can read it while the
 * scope is still deny-all, then set the real scope once it knows the caller.
 * Same transaction, so it still dies with it. No-op outside a scoped request.
 */
export async function applyRequestScope(scope: RequestScope): Promise<void> {
  const tx = currentScopedDb();
  if (!tx) return;
  await applyScopeTo(tx, scope);
}

async function applyScopeTo(tx: Db, scope: RequestScope): Promise<void> {
  const scopes = encodeTenantScopes(scope.tenantScopes);
  // `SET LOCAL` takes no bind parameters; `set_config(name, value, is_local => true)`
  // is the same thing in function form, and is parameterised rather than interpolated.
  await tx.execute(sql`SELECT set_config('app.tenant_scopes', ${scopes}, true)`);
  await tx.execute(sql`SELECT set_config('app.is_service', ${scope.isService === true ? "true" : "false"}, true)`);
}
