/**
 * `defineFunction`, wrapped in one DENY-ALL transaction for the whole handler.
 *
 *  - `ensureDb()` returns that transaction, so no call site changes;
 *  - a handler that reads tenant data before authenticating sees nothing;
 *  - the scope dies with the transaction, so a pooled connection cannot carry
 *    one caller's tenants into the next request;
 *  - a partially applied request becomes impossible (a welcome side effect).
 *
 * Use it for every endpoint that touches tenant data. Plain `defineFunction`
 * is fine for endpoints that touch none (health checks, /session).
 */
import { defineFunction } from "@trayai/helix-sdk";
import type { z } from "zod";
import { ensureDb } from "./db";
import { DENY_ALL, withRequestScope } from "./request-scope";

type Handler<S extends z.ZodTypeAny> = Parameters<typeof defineFunction<S>>[0];

export function defineScopedFunction<S extends z.ZodTypeAny>(handler: Handler<S>) {
  return defineFunction<S>(async (ctx) => {
    const db = await ensureDb();
    return withRequestScope(db, DENY_ALL, () => handler(ctx) as Promise<unknown>);
  });
}
