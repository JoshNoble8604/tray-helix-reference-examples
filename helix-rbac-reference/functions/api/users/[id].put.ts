/**
 * PUT /users/:id: change role, tenant scopes or active state, or bind a
 * waiting sign-in (idpSubject). Admin with all tenants only.
 *
 * Read, validate, write, audit and clean up in ONE transaction. Split, the
 * change can commit without its audit row, and the last-admin check becomes a
 * check-then-act two admins can both pass.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { defineScopedFunction } from "../../_shared/scoped-function";
import { ensureDb, schema, type Db } from "../../_shared/db";
import { requireAllTenants, requireRole } from "../../_shared/auth";
import { ROLES, assertPatchAllowed, diffKinds, lockAdminSet, recordAccessChange } from "../../_shared/users";
import { httpError } from "../../_shared/http";

export const input = z.object({
  id: z.string().uuid(),
  role: z.enum(ROLES).optional(),
  tenantScopes: z.array(z.string().regex(/^(\*|[a-z0-9][a-z0-9-]*)$/)).max(100).optional(),
  isActive: z.boolean().optional(),
  /** Bind a waiting sign-in to this account. One-way. */
  idpSubject: z.string().min(1).max(200).optional(),
});

export default defineScopedFunction<typeof input>(async (ctx) => {
  const { id, role, tenantScopes, isActive, idpSubject } = ctx.input;
  const actor = await requireRole(ctx, ["admin"]);
  requireAllTenants(actor, "managing people");
  if ([role, tenantScopes, isActive, idpSubject].every((v) => v === undefined)) {
    httpError(400, "nothing to change; supply role, tenantScopes, isActive or idpSubject");
  }
  const db = await ensureDb();
  const patch = { role, tenantScopes, isActive, idpSubject };

  const { updated, events } = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await lockAdminSet(t); // BEFORE any row lock: see users.ts
    const [row] = await t.select().from(schema.appUsers).where(eq(schema.appUsers.id, id)).for("update");
    if (!row) httpError(404, "user not found");
    await assertPatchAllowed(t, row, patch, actor.id);
    const diffs = diffKinds(row, patch); // from the row as it was, before the write

    const [changed] = await t
      .update(schema.appUsers)
      .set({
        ...(role !== undefined ? { role } : {}),
        ...(tenantScopes !== undefined ? { tenantScopes } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(idpSubject !== undefined ? { idpSubject } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.appUsers.id, id))
      .returning();
    await recordAccessChange({ db: t, subject: row, actorEmail: actor.email, events: diffs });
    // A bound sign-in is no longer waiting.
    if (idpSubject !== undefined) {
      await t.delete(schema.appSigninRequests).where(eq(schema.appSigninRequests.idpSubject, idpSubject));
    }
    return { updated: changed, events: diffs };
  });

  return {
    ok: true,
    user: { id: updated.id, email: updated.email, role: updated.role, tenantScopes: updated.tenantScopes, isActive: updated.isActive },
    changed: events.map((e) => e.kind),
  };
});
