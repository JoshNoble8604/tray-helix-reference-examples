/**
 * GET /records/:id: a DETAIL endpoint. Any role, in scope; or the service token.
 *
 * The shape every detail endpoint should copy:
 *   1. require SOME caller, before revealing whether the id exists;
 *   2. learn the owning tenant WITHOUT reading the row (app_record_tenant);
 *   3. gate on that tenant, masking "not yours" as the same 404 as "no such row";
 *   4. only then read, now under the narrowed scope.
 */
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { defineScopedFunction } from "../../_shared/scoped-function";
import { ensureDb, schema } from "../../_shared/db";
import { recordTenant, requireSomeCaller, requireTenantRead } from "../../_shared/auth";
import { httpError } from "../../_shared/http";

export const input = z.object({ id: z.string().uuid() });

export default defineScopedFunction<typeof input>(async (ctx) => {
  const { id } = ctx.input;
  const db = await ensureDb();
  await requireSomeCaller(ctx);
  const tenantId = await recordTenant(db, id);
  if (!tenantId) httpError(404, "record not found");
  await requireTenantRead(ctx, tenantId, { maskAsNotFound: "record not found" });

  const [record] = await db.select().from(schema.records).where(eq(schema.records.id, id));
  if (!record) httpError(404, "record not found");
  // Child table: RLS confines it through the parent, no tenant filter needed here.
  const events = await db.select().from(schema.recordEvents).where(eq(schema.recordEvents.recordId, id)).orderBy(asc(schema.recordEvents.createdAt));
  return { record, events };
});
