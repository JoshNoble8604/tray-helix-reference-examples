/**
 * PUT /records/:id: edit a record. Editor or admin, in scope.
 *
 * Role refusal is a 403 (says nothing about which ids exist); tenant refusal is
 * the masked 404. Approvers cannot edit: whoever signs off should not also
 * shape the thing being signed off.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { defineScopedFunction } from "../../_shared/scoped-function";
import { ensureDb, schema } from "../../_shared/db";
import { EDIT_ROLES, getAppUser, recordTenant, requireRole } from "../../_shared/auth";
import { httpError } from "../../_shared/http";

export const input = z.object({ id: z.string().uuid(), title: z.string().min(1).max(500) });

export default defineScopedFunction<typeof input>(async (ctx) => {
  const { id, title } = ctx.input;
  if (!(await getAppUser(ctx))) httpError(401, "sign-in required"); // before revealing existence
  const db = await ensureDb();
  const tenantId = await recordTenant(db, id);
  if (!tenantId) httpError(404, "record not found");
  const user = await requireRole(ctx, EDIT_ROLES, tenantId, { maskAsNotFound: "record not found" });

  const [updated] = await db
    .update(schema.records)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(schema.records.id, id), eq(schema.records.status, "pending")))
    .returning();
  if (!updated) httpError(409, "only a pending record can be edited");
  await db.insert(schema.recordEvents).values({ recordId: id, kind: "edited", actorEmail: user.email });
  return { record: updated };
});
