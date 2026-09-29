/**
 * POST /users/:id/invite: a single-use link that binds whoever opens it
 * (signed in to Helix) to this account. The admin delivers it; nothing is sent.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { defineScopedFunction } from "../../../_shared/scoped-function";
import { ensureDb, schema } from "../../../_shared/db";
import { requireAllTenants, requireRole } from "../../../_shared/auth";
import { mintInvite } from "../../../_shared/users";
import { httpError } from "../../../_shared/http";

export const input = z.object({ id: z.string().uuid() });

export default defineScopedFunction<typeof input>(async (ctx) => {
  const actor = await requireRole(ctx, ["admin"]);
  requireAllTenants(actor, "managing people");
  const [row] = await (await ensureDb()).select().from(schema.appUsers).where(eq(schema.appUsers.id, ctx.input.id));
  if (!row) httpError(404, "user not found");
  if (row.idpSubject) httpError(409, "this account is already in use; nothing to invite");
  if (!row.isActive) httpError(409, "this account is disabled; enable it first");
  const { token, expiresAt } = mintInvite(row.id);
  return { path: `/join?invite=${token}`, expiresAt: expiresAt.toISOString() };
});
