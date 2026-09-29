/**
 * DELETE /users/:id: remove access for good. A soft removal (the audit trail
 * references the row); see users.ts. Refuses self-removal and the last admin.
 */
import { z } from "zod";
import { defineScopedFunction } from "../../_shared/scoped-function";
import { ensureDb } from "../../_shared/db";
import { requireAllTenants, requireRole } from "../../_shared/auth";
import { removeUser } from "../../_shared/users";

export const input = z.object({ id: z.string().uuid() });

export default defineScopedFunction<typeof input>(async (ctx) => {
  const actor = await requireRole(ctx, ["admin"]);
  requireAllTenants(actor, "managing people");
  const removed = await removeUser(await ensureDb(), ctx.input.id, actor);
  return { ok: true, id: removed.id, email: removed.email };
});
