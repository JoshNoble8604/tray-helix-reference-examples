/**
 * POST /users: invite someone by email.
 *
 * Grants nothing by itself. Until a sign-in is bound to the row (an invite
 * link, or an admin binding a waiting sign-in), nobody can authenticate into it.
 * "Authenticated to the Helix project" is not the same as "may see this tenant".
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { defineScopedFunction } from "../_shared/scoped-function";
import { ensureDb, schema } from "../_shared/db";
import { requireAllTenants, requireRole } from "../_shared/auth";
import { ROLES, recordAccessChange, removedUserIds, restoreRemoved } from "../_shared/users";
import { httpError } from "../_shared/http";

export const input = z.object({
  email: z.string().email().max(320),
  role: z.enum(ROLES),
  tenantScopes: z.array(z.string().regex(/^(\*|[a-z0-9][a-z0-9-]*)$/)).max(100).default([]),
});

export default defineScopedFunction<typeof input>(async (ctx) => {
  const { role, tenantScopes } = ctx.input;
  const actor = await requireRole(ctx, ["admin"]);
  requireAllTenants(actor, "managing people");
  const db = await ensureDb();
  const email = ctx.input.email.trim().toLowerCase();

  const [existing] = await db.select().from(schema.appUsers).where(eq(schema.appUsers.email, email));
  if (existing) {
    if (!(await removedUserIds(db)).has(existing.id)) httpError(409, "that email already has an account; edit it instead");
    const restored = await restoreRemoved(db, existing, { role, tenantScopes }, actor.email);
    return { ok: true, user: { id: restored.id, email, role, tenantScopes, isActive: true, hasSignedIn: false } };
  }

  const [created] = await db.insert(schema.appUsers).values({ email, role, tenantScopes }).returning();
  await recordAccessChange({
    db,
    subject: created,
    actorEmail: actor.email,
    events: [{ kind: "created", before: null, after: { role, tenantScopes } }],
  });
  return { ok: true, user: { id: created.id, email, role, tenantScopes, isActive: true, hasSignedIn: false } };
});
