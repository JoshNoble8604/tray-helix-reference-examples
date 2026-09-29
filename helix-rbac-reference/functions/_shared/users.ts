/**
 * Changing who can do what, safely: the rules, the audit trail, removal, and
 * invite links. Endpoints stay a gate, a call, and a response.
 *
 * The two rules that matter:
 *
 *  1. NEVER LOSE THE LAST ADMIN. The bootstrap closes itself once an admin
 *     exists, so demoting or removing the final one locks everybody out with no
 *     in-app way back. Only CLAIMED admins count (signed in, `idp_subject` set):
 *     an invited admin nobody has signed in as cannot keep a real admin's seat.
 *  2. NOBODY EDITS THEIR OWN ACCESS. Not a privilege ceiling (an admin can grant
 *     anything anyway) but a mistake filter: self-demotion is the likeliest way
 *     to lock yourself out.
 *
 * Plus: identity binding is ONE-WAY, and the audit table is APPEND-ONLY.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { schema, type Db } from "./db";
import { httpError, setting } from "./http";

/** Mirrors the CHECK constraint in 0001_rbac.sql. */
export const ROLES = ["admin", "editor", "approver", "viewer"] as const;
export type Role = (typeof ROLES)[number];

type UserRow = typeof schema.appUsers.$inferSelect;
export interface AuditEvent {
  kind: string;
  before: unknown;
  after: unknown;
}

export interface AccessPatch {
  role?: Role;
  tenantScopes?: string[];
  isActive?: boolean;
  /**
   * Bind a waiting sign-in to this account. One-way: an identity may be bound
   * to an account that has none, and never moved or overwritten. Repointing an
   * existing user's identity would be a silent account takeover.
   */
  idpSubject?: string;
}

/* ------------------------------------------------------ last-admin guard --- */

/**
 * Serialise every change that could SHRINK the claimed-admin set. Take it
 * FIRST in the transaction, before any row lock.
 *
 * Row locks alone deadlock: two admins demoting each other lock A-then-B and
 * B-then-A, and Postgres aborts one (the invariant holds, but a legitimate
 * request becomes a 500). A lock ORDER would fix that until someone adds a
 * query that ignores it. One named advisory lock cannot be taken in the wrong
 * order, and it also covers rows that do not exist yet. Transaction-scoped, so
 * it releases on commit or rollback. Contention is irrelevant here.
 */
export async function lockAdminSet(db: Db): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app:admin_set'))`);
}

/** Active, claimed admins, optionally excluding one. Call under lockAdminSet. */
export async function claimedAdminCount(db: Db, excludingId?: string): Promise<number> {
  const conditions = [
    eq(schema.appUsers.role, "admin"),
    eq(schema.appUsers.isActive, true),
    isNotNull(schema.appUsers.idpSubject),
  ];
  if (excludingId) conditions.push(ne(schema.appUsers.id, excludingId));
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.appUsers).where(and(...conditions));
  return Number(row?.n ?? 0);
}

function isClaimedAdmin(u: UserRow): boolean {
  return u.role === "admin" && u.isActive && u.idpSubject !== null;
}

/** Throws on a patch that is not allowed. Run inside the write's transaction, after lockAdminSet. */
export async function assertPatchAllowed(db: Db, subject: UserRow, patch: AccessPatch, actorId: string): Promise<void> {
  if (subject.id === actorId) httpError(409, "you cannot change your own role, scopes or active state");
  if (patch.idpSubject !== undefined && subject.idpSubject !== null) {
    httpError(409, "this account is already bound to a sign-in; an identity cannot be rebound");
  }
  // Demotion and deactivation are the same failure spelled two ways: one check.
  const losesAdmin =
    isClaimedAdmin(subject) && ((patch.role !== undefined && patch.role !== "admin") || patch.isActive === false);
  if (losesAdmin && (await claimedAdminCount(db, subject.id)) === 0) {
    httpError(409, "refusing to remove the last admin; promote another admin first");
  }
}

/* ------------------------------------------------------------------ audit --- */

/** One audit row per kind of change. Computed from the row BEFORE the write. */
export function diffKinds(subject: UserRow, patch: AccessPatch): AuditEvent[] {
  const events: AuditEvent[] = [];
  if (patch.role !== undefined && patch.role !== subject.role) {
    events.push({ kind: "role_changed", before: subject.role, after: patch.role });
  }
  if (patch.tenantScopes !== undefined) {
    const before = [...subject.tenantScopes].sort();
    const after = [...patch.tenantScopes].sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) events.push({ kind: "scopes_changed", before, after });
  }
  if (patch.isActive !== undefined && patch.isActive !== subject.isActive) {
    events.push({ kind: patch.isActive ? "activated" : "deactivated", before: subject.isActive, after: patch.isActive });
  }
  if (patch.idpSubject !== undefined && subject.idpSubject === null) {
    // The opaque id itself is of no use to a reviewer; that it was claimed is.
    events.push({ kind: "claimed", before: null, after: "bound by admin" });
  }
  return events;
}

/**
 * Append audit rows. Call in the SAME transaction as the change: an access
 * change that commits without its audit row is a change nobody can attribute.
 */
export async function recordAccessChange(args: { db: Db; subject: UserRow; actorEmail: string; events: AuditEvent[] }) {
  const { db, subject, actorEmail, events } = args;
  if (events.length === 0) return;
  await db.insert(schema.appUserEvents).values(
    events.map((e) => ({
      subjectId: subject.id,
      subjectEmail: subject.email,
      actorEmail,
      kind: e.kind,
      before: e.before as never,
      after: e.after as never,
    })),
  );
}

/* ---------------------------------------------------------------- removal --- */
// A row cannot be deleted: the append-only audit trail references it, and
// deleting history to delete a person erases exactly what a reviewer needs.
// Removal strips everything and appends `removed`; lists hide those accounts;
// adding the same email again restores it as a fresh, unbound invite.

/** Ids whose latest removed/restored event is `removed`. */
export async function removedUserIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ subjectId: schema.appUserEvents.subjectId, kind: schema.appUserEvents.kind })
    .from(schema.appUserEvents)
    .where(inArray(schema.appUserEvents.kind, ["removed", "restored"]))
    .orderBy(desc(schema.appUserEvents.createdAt), desc(schema.appUserEvents.id));
  const latest = new Map<string, string>();
  for (const r of rows) if (!latest.has(r.subjectId)) latest.set(r.subjectId, r.kind);
  return new Set([...latest].filter(([, kind]) => kind === "removed").map(([id]) => id));
}

export async function removeUser(db: Db, id: string, actor: { id: string; email: string }): Promise<UserRow> {
  if (id === actor.id) httpError(409, "you cannot remove yourself");
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await lockAdminSet(t);
    const [row] = await t.select().from(schema.appUsers).where(eq(schema.appUsers.id, id)).for("update");
    if (!row) httpError(404, "user not found");
    if (isClaimedAdmin(row) && (await claimedAdminCount(t, row.id)) === 0) {
      httpError(409, "refusing to remove the last admin; promote another admin first");
    }
    const [updated] = await t
      .update(schema.appUsers)
      .set({ isActive: false, idpSubject: null, tenantScopes: [], updatedAt: new Date() })
      .where(eq(schema.appUsers.id, id))
      .returning();
    await recordAccessChange({
      db: t,
      subject: row,
      actorEmail: actor.email,
      events: [{ kind: "removed", before: { role: row.role, tenantScopes: row.tenantScopes, signedIn: !!row.idpSubject }, after: null }],
    });
    return updated;
  });
}

export async function restoreRemoved(
  db: Db,
  row: UserRow,
  access: { role: Role; tenantScopes: string[] },
  actorEmail: string,
): Promise<UserRow> {
  const [restored] = await db
    .update(schema.appUsers)
    .set({ ...access, isActive: true, idpSubject: null, updatedAt: new Date() })
    .where(and(eq(schema.appUsers.id, row.id), sql`${schema.appUsers.idpSubject} IS NULL`))
    .returning();
  if (!restored) httpError(409, "that account changed while it was being restored; try again");
  await recordAccessChange({ db, subject: row, actorEmail, events: [{ kind: "restored", before: null, after: access }] });
  return restored;
}

/* ---------------------------------------------------------------- invites --- */
// Identity gives an opaque id and no email, so the app cannot tell which
// sign-in is which invited person. An invite link supplies the missing fact:
// the admin sends it to one person, and whoever opens it while signed in is,
// by construction, that person.
//
// Stateless token `{u, iat, exp}` HMAC-signed with INVITE_SIGNING_SECRET.
// Single use without a nonce table: redemption sets idp_subject only WHERE it
// is still NULL, under a row lock, so only the first can succeed.

export const INVITE_DAYS = 7;

function inviteKey(): Buffer {
  const secret = setting("INVITE_SIGNING_SECRET");
  if (!secret) throw new Error("INVITE_SIGNING_SECRET is not set; cannot mint or verify invites");
  // Derived under its own label so this key can never verify any other token type.
  return createHmac("sha256", secret).update("app-invite:v1").digest();
}

const sign = (body: string) => createHmac("sha256", inviteKey()).update(body).digest();

export function mintInvite(userId: string, now = new Date()): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000);
  const body = Buffer.from(JSON.stringify({ u: userId, iat: now.getTime(), exp: expiresAt.getTime() })).toString("base64url");
  return { token: `${body}.${sign(body).toString("base64url")}`, expiresAt };
}

export type InviteCheck =
  | { ok: true; userId: string; issuedAt: Date }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyInvite(token: string, now = new Date()): InviteCheck {
  const [body, mac] = token.split(".");
  if (!body || !mac) return { ok: false, reason: "malformed" };
  const given = Buffer.from(mac, "base64url");
  const expected = sign(body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let payload: { u?: unknown; iat?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.u !== "string") return { ok: false, reason: "malformed" };
  if (!(Number(payload.exp) > now.getTime())) return { ok: false, reason: "expired" };
  return { ok: true, userId: payload.u, issuedAt: new Date(Number(payload.iat) || 0) };
}

/**
 * Bind `subject` to the invited account, once. Refuses (never overwrites) an
 * account already bound, a disabled one, a link issued before a removal, and a
 * sign-in that already has an account.
 */
export async function redeemInvite(db: Db, userId: string, subject: string, issuedAt: Date): Promise<{ email: string }> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [row] = await t.select().from(schema.appUsers).where(eq(schema.appUsers.id, userId)).for("update");
    if (!row || !row.isActive) httpError(403, "this invite is no longer valid; ask for a new one");
    // Removing someone cancels every link already sent, even if they are re-added.
    const [removal] = await t
      .select({ at: schema.appUserEvents.createdAt })
      .from(schema.appUserEvents)
      .where(and(eq(schema.appUserEvents.subjectId, userId), eq(schema.appUserEvents.kind, "removed")))
      .orderBy(desc(schema.appUserEvents.createdAt))
      .limit(1);
    if (removal && removal.at.getTime() >= issuedAt.getTime()) httpError(403, "this invite was cancelled; ask for a new one");

    const [taken] = await t.select({ id: schema.appUsers.id }).from(schema.appUsers).where(eq(schema.appUsers.idpSubject, subject));
    if (taken) httpError(409, "your sign-in already has an account here");

    const [bound] = await t
      .update(schema.appUsers)
      .set({ idpSubject: subject, updatedAt: new Date() })
      .where(and(eq(schema.appUsers.id, userId), sql`${schema.appUsers.idpSubject} IS NULL`))
      .returning();
    if (!bound) httpError(409, "this invite has already been used; ask for a new one");

    await t.delete(schema.appSigninRequests).where(eq(schema.appSigninRequests.idpSubject, subject));
    await recordAccessChange({ db: t, subject: row, actorEmail: row.email, events: [{ kind: "claimed", before: null, after: "invite link" }] });
    return { email: row.email };
  });
}
