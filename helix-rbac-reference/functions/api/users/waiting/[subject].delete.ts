/**
 * DELETE /users/waiting/:subject: dismiss a sign-in nobody will claim.
 * Waiting rows grant nothing; if the person signs in again, the row comes back.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { defineScopedFunction } from "../../../_shared/scoped-function";
import { ensureDb, schema } from "../../../_shared/db";
import { requireAllTenants, requireRole } from "../../../_shared/auth";

export const input = z.object({ subject: z.string().min(1).max(200) });

export default defineScopedFunction<typeof input>(async (ctx) => {
  const actor = await requireRole(ctx, ["admin"]);
  requireAllTenants(actor, "managing people");
  const rows = await (await ensureDb())
    .delete(schema.appSigninRequests)
    .where(eq(schema.appSigninRequests.idpSubject, ctx.input.subject))
    .returning();
  return { ok: true, dismissed: rows.length };
});
