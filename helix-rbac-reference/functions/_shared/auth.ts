/**
 * Endpoint gates. Every endpoint calls exactly one of these (or an explicit
 * combination) before it reads tenant data.
 *
 * Two kinds of caller:
 *  - a workflow or backend job holding SERVICE_TOKEN: the trusted path, sees
 *    every tenant, and every access is logged;
 *  - a person signed in through Helix Identity: an `app_users` row, gated on
 *    ROLE (what they may do) AND TENANT SCOPE (which tenants they may see).
 *
 * The roles:
 *   admin     configures AND decides. With `*` scope, also manages people.
 *   editor    configures, does not decide.
 *   approver  decides, does not configure.
 *   viewer    reads. Read-only by exclusion, which is why no gate names it.
 * Editing and approving are separate on purpose: approving is the irreversible
 * act, and whoever tunes the thing should not automatically sign it off.
 *
 * Every gate fails CLOSED and, after its LAST refusal, narrows the request
 * scope so RLS admits exactly this caller's tenants.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { TrayContext } from "@trayai/helix-sdk";
import { ensureDb, rowsOf, schema, type Db } from "./db";
import { httpError, setting } from "./http";
import { applyRequestScope, onRequestEnd } from "./request-scope";
import { lockAdminSet, recordAccessChange } from "./users";

type AnyCtx = TrayContext<any>;
export type AppUserRow = typeof schema.appUsers.$inferSelect;

/** The roles that may change tenant data (as opposed to decide on it). */
export const EDIT_ROLES = ["admin", "editor"] as const;
/** The roles that may make the irreversible decision. */
export const APPROVE_ROLES = ["admin", "approver"] as const;

export interface GateOptions {
  /**
   * Answer 404 with this message, instead of 403, when the TENANT is out of
   * scope. Use it on detail endpoints, where the id is the secret: "not yours"
   * and "no such row" must look identical or the difference enumerates other
   * tenants' ids. Do not use it on list endpoints (the caller chose the tenant),
   * and it never applies to ROLE refusals: "you are not an approver" reveals
   * nothing about which ids exist.
   */
  maskAsNotFound?: string;
}

/* ------------------------------------------------------------ service --- */

function header(ctx: AnyCtx, name: string): string | undefined {
  const headers = (ctx.headers ?? {}) as Record<string, string | undefined>;
  return headers[name] ?? headers[name.toLowerCase()];
}

/** Fails CLOSED when SERVICE_TOKEN is unset: an unset gate is a refusal, not an open door. */
export function serviceAuthOk(ctx: AnyCtx): boolean {
  const expected = setting("SERVICE_TOKEN");
  if (!expected) return false;
  const auth = header(ctx, "authorization");
  const provided = header(ctx, "x-service-token") ?? (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined);
  if (!provided) return false;
  // Constant time. Hashing gives both sides the equal length timingSafeEqual needs.
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * The service gate WITHOUT touching scope. Synchronous on purpose: an async
 * gate whose call site forgets `await` throws into a floating promise and lets
 * the request through, and TypeScript will not catch the omission.
 */
export function requireServiceAuth(ctx: AnyCtx): void {
  if (!serviceAuthOk(ctx)) ctx.error(401, "invalid service token");
  ctx.log.info("service-token access", { path: ctx.path, executionId: ctx.executionId });
}

/** The service gate AND the unfiltered scope it implies. What service endpoints want. */
export async function requireServiceScope(ctx: AnyCtx): Promise<void> {
  requireServiceAuth(ctx);
  await narrowScopeToService();
}

/* -------------------------------------------------------------- scope --- */

export function hasTenantScope(scopes: readonly string[] | null | undefined, tenantId: string): boolean {
  if (!scopes) return false;
  return scopes.includes("*") || scopes.includes(tenantId);
}

/**
 * Tell the database what this request may see.
 *
 * Call only AFTER every refusal in the gate has had its chance: narrowing first
 * lets a handler read tenant rows on behalf of a caller it is about to reject.
 *
 * A `*` scope is routed down the SERVICE path, not written into the setting:
 * the policy compares list membership, so "*" would match a tenant literally
 * named "*" and nothing else. A wildcard that silently denies everything is
 * worse than one that is refused.
 */
export async function narrowScopeTo(user: { tenantScopes?: string[] | null } | null): Promise<void> {
  const scopes = user?.tenantScopes ?? [];
  if (scopes.includes("*")) return narrowScopeToService();
  await applyRequestScope({ tenantScopes: scopes, isService: false });
}

/** One name for the unfiltered scope, so "who sees everything" has one thing to grep for. */
export async function narrowScopeToService(): Promise<void> {
  await applyRequestScope({ tenantScopes: [], isService: true });
}

/* ----------------------------------------------------------- identity --- */

/**
 * Resolve the Helix Identity session to an `app_users` row. Null = no access.
 *
 * Matches on the identity SUBJECT only, never on email. Identity promises an
 * opaque id; matching any other value (an email typed into a local dev header,
 * say) is a second door around the binding step, which is supposed to be the
 * only thing that grants access.
 */
export async function getAppUser(ctx: AnyCtx): Promise<AppUserRow | null> {
  const subject = ctx.identity?.user?.id;
  if (!subject) return null;

  const [user] = await (await ensureDb())
    .select()
    .from(schema.appUsers)
    .where(eq(schema.appUsers.idpSubject, subject))
    .limit(1);
  if (user) return user.isActive ? user : null;

  const bootstrapped = await bootstrapAdmin(ctx, subject);
  if (bootstrapped) return bootstrapped;

  // No account. Record the knock so an admin can see who is waiting: Identity
  // gives us no email, so this is the only way they learn this person exists.
  // A doorbell, not a key: returning null is what denies.
  noteSigninRequest(ctx, subject);
  return null;
}

function noteSigninRequest(ctx: AnyCtx, subject: string): void {
  // After the request ends, or the refusal's rollback erases the knock.
  onRequestEnd(async () => {
    try {
      await (await ensureDb())
        .insert(schema.appSigninRequests)
        .values({ idpSubject: subject })
        .onConflictDoUpdate({
          target: schema.appSigninRequests.idpSubject,
          set: { lastSeen: new Date(), attempts: sql`${schema.appSigninRequests.attempts} + 1` },
        });
    } catch (err) {
      // Bookkeeping must never turn a 401 into a 500.
      ctx.log.warn("could not record sign-in request", { reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * The first admin, for ONE identity named in advance.
 *
 * "First sign-in while no admin exists becomes admin" is a race any identity
 * the outer SSO admits can win. So the subject is PRE-BOUND:
 * BOOTSTRAP_ADMIN_SUBJECT must equal the authenticated subject. You cannot know
 * your opaque subject before signing in, so: sign in, be refused, read your
 * subject from `app_signin_requests` (or the log line below), set it, sign in
 * again. Closes itself once a real admin exists.
 */
async function bootstrapAdmin(ctx: AnyCtx, subject: string): Promise<AppUserRow | null> {
  const email = setting("BOOTSTRAP_ADMIN_EMAIL")?.toLowerCase();
  if (!email) return null;
  const expected = setting("BOOTSTRAP_ADMIN_SUBJECT");
  if (!expected) {
    ctx.log.error("BOOTSTRAP_ADMIN_EMAIL is set without BOOTSTRAP_ADMIN_SUBJECT; refusing. Set it to the observed subject.", {
      observedSubject: subject,
    });
    return null;
  }
  if (expected !== subject) return null;

  const db = await ensureDb();
  return db.transaction(async (tx) => {
    const t = tx as unknown as typeof db;
    await lockAdminSet(t);
    // Only an admin someone has actually signed in as counts. A seeded,
    // unclaimed admin row must not block the first genuine sign-in.
    const [claimed] = await t
      .select({ id: schema.appUsers.id })
      .from(schema.appUsers)
      .where(and(eq(schema.appUsers.role, "admin"), eq(schema.appUsers.isActive, true), isNotNull(schema.appUsers.idpSubject)))
      .limit(1);
    if (claimed) return null;

    const [created] = await t
      .insert(schema.appUsers)
      .values({ email, idpSubject: subject, role: "admin", tenantScopes: ["*"] })
      .onConflictDoUpdate({
        target: schema.appUsers.email,
        set: { idpSubject: subject, role: "admin", tenantScopes: ["*"], isActive: true, updatedAt: new Date() },
      })
      .returning();
    await recordAccessChange({
      db: t,
      subject: created,
      actorEmail: "bootstrap",
      events: [{ kind: "created", before: null, after: { role: "admin", tenantScopes: ["*"], via: "bootstrap" } }],
    });
    ctx.log.warn("bootstrap admin claimed; unset BOOTSTRAP_ADMIN_EMAIL now", { email });
    return created;
  });
}

/* ---------------------------------------------------------- ownership --- */

/**
 * The tenant that owns a record, or null for no such record. Readable at
 * deny-all because `app_record_tenant` is SECURITY DEFINER and returns only the
 * tenant id. Lets a detail endpoint authorise BEFORE it reads the row.
 */
export async function recordTenant(db: Db, id: string): Promise<string | null> {
  const rows = rowsOf<{ tenant_id: string | null }>(await db.execute(sql`SELECT app_record_tenant(${id}::uuid) AS tenant_id`));
  return rows[0]?.tenant_id ?? null;
}

/* -------------------------------------------------------------- gates --- */

/**
 * Is there ANY caller? 401 if not.
 *
 * Detail endpoints look up a row's owner before they can authorise, and that
 * lookup answers for any id. Without this, an anonymous caller gets 404 for a
 * missing id and 401 for a real one: the same enumeration oracle.
 */
export async function requireSomeCaller(ctx: AnyCtx): Promise<void> {
  if (serviceAuthOk(ctx)) return;
  if (await getAppUser(ctx)) return;
  await recordAuthFailure();
  ctx.error(401, "authentication required");
}

/** Read gate: the service token, OR a signed-in user scoped to the tenant. */
export async function requireTenantRead(ctx: AnyCtx, tenantId: string, opts: GateOptions = {}): Promise<void> {
  // A missing tenant is a 400, refused before anything else. hasTenantScope("*", undefined)
  // would answer YES about no particular tenant, one refactor away from a hole.
  if (typeof tenantId !== "string" || tenantId.trim() === "") ctx.error(400, "tenantId is required");
  if (serviceAuthOk(ctx)) {
    await requireServiceScope(ctx);
    return;
  }
  const user = await getAppUser(ctx);
  // 401 is never masked: it is about the caller, not about the row.
  if (!user) {
    await recordAuthFailure();
    ctx.error(401, "authentication required");
  }
  if (!hasTenantScope(user.tenantScopes, tenantId)) {
    ctx.error(opts.maskAsNotFound ? 404 : 403, opts.maskAsNotFound ?? "tenant not in your scope");
  }
  await narrowScopeTo(user);
}

/** Role gate, optionally with a tenant. Users only: the service token is not a role. */
export async function requireRole(
  ctx: AnyCtx,
  roles: readonly string[],
  tenantId?: string,
  opts: GateOptions = {},
): Promise<AppUserRow> {
  const user = await getAppUser(ctx);
  if (!user) {
    await recordAuthFailure();
    ctx.error(401, "sign-in required");
  }
  // Role refusal first, and never masked.
  if (!roles.includes(user.role)) ctx.error(403, `role ${roles.join(" or ")} required`);
  if (tenantId !== undefined && !hasTenantScope(user.tenantScopes, tenantId)) {
    ctx.error(opts.maskAsNotFound ? 404 : 403, opts.maskAsNotFound ?? "tenant not in your scope");
  }
  await narrowScopeTo(user);
  return user;
}

/** The decision gate: approver or admin, AND the tenant in scope. */
export function requireApprover(ctx: AnyCtx, tenantId: string, opts: GateOptions = {}): Promise<AppUserRow> {
  return requireRole(ctx, APPROVE_ROLES, tenantId, opts);
}

/**
 * Refuse unless the user holds every tenant (`*`).
 *
 * For controls whose effect is not confined to one tenant. Managing people is
 * the main one: a one-tenant admin could otherwise grant anyone, including a
 * second account of their own, every tenant.
 */
export function requireAllTenants(user: { tenantScopes?: string[] | null }, what: string): void {
  if (!(user.tenantScopes ?? []).includes("*")) httpError(403, `${what} needs access to all tenants`);
}

/**
 * Count a refused authentication, durably, so it can be alerted on.
 * Written after the request ends (the refusal rolls its transaction back).
 * Never throws: the refusal is what matters.
 */
export async function recordAuthFailure(): Promise<void> {
  onRequestEnd(async () => {
    try {
      await (await ensureDb())
        .insert(schema.authFailures)
        .values({ day: sql`current_date`, count: 1 })
        .onConflictDoUpdate({ target: schema.authFailures.day, set: { count: sql`${schema.authFailures.count} + 1` } });
    } catch {
      /* best effort */
    }
  });
}
