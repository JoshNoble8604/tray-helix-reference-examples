/**
 * GET /records?tenantId=: a LIST endpoint. Any role, in scope; or the service token.
 *
 * The tenant is a parameter the caller chose, so an out-of-scope tenant is an
 * honest 403, not a masked 404 ("no such tenant" would be a lie).
 */
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { defineScopedFunction } from "../_shared/scoped-function";
import { ensureDb, schema } from "../_shared/db";
import { requireTenantRead } from "../_shared/auth";

export const input = z.object({ tenantId: z.string() });

export default defineScopedFunction<typeof input>(async (ctx) => {
  // Coerce at the point of use: don't rely on the input schema having been applied to query strings.
  const tenantId = String(ctx.input.tenantId ?? "");
  await requireTenantRead(ctx, tenantId);
  // The WHERE is the app-layer filter; RLS is the backstop if someone forgets it.
  const rows = await (await ensureDb())
    .select()
    .from(schema.records)
    .where(eq(schema.records.tenantId, tenantId))
    .orderBy(desc(schema.records.createdAt));
  return { records: rows };
});
