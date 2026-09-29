/**
 * POST /records: create a record. SERVICE TOKEN ONLY (a workflow or backend job).
 *
 * The service path sees every tenant by design, so it is logged on every call
 * and should be granted to machines, never to people.
 */
import { z } from "zod";
import { defineScopedFunction } from "../_shared/scoped-function";
import { ensureDb, schema } from "../_shared/db";
import { requireServiceScope } from "../_shared/auth";

export const input = z.object({ tenantId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), title: z.string().min(1).max(500) });

export default defineScopedFunction<typeof input>(async (ctx) => {
  await requireServiceScope(ctx);
  const [created] = await (await ensureDb())
    .insert(schema.records)
    .values({ tenantId: ctx.input.tenantId, title: ctx.input.title })
    .returning();
  return { record: created };
});
