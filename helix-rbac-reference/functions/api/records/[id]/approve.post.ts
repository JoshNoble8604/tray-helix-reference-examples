/**
 * POST /records/:id/approve: the irreversible decision. Approver or admin, in
 * scope. Signed-in users only: the service token is not a person and cannot approve.
 *
 * The actor is the AUTHENTICATED user, never a field in the request body: a
 * client must not be able to name who decided.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { defineScopedFunction } from "../../../_shared/scoped-function";
import { ensureDb, schema } from "../../../_shared/db";
import { getAppUser, recordTenant, requireApprover } from "../../../_shared/auth";
import { onAfterCommit } from "../../../_shared/request-scope";
import { httpError } from "../../../_shared/http";

export const input = z.object({ id: z.string().uuid() });

export default defineScopedFunction<typeof input>(async (ctx) => {
  const { id } = ctx.input;
  // A session BEFORE any lookup, so an anonymous caller cannot probe which ids exist.
  if (!(await getAppUser(ctx))) httpError(401, "sign-in required");
  const db = await ensureDb();
  const tenantId = await recordTenant(db, id);
  if (!tenantId) httpError(404, "record not found");
  const user = await requireApprover(ctx, tenantId, { maskAsNotFound: "record not found" });

  // Atomic transition: only one of two concurrent approvals can win.
  const [approved] = await db
    .update(schema.records)
    .set({ status: "approved", approvedBy: user.email, updatedAt: new Date() })
    .where(and(eq(schema.records.id, id), eq(schema.records.status, "pending")))
    .returning();
  if (!approved) return { accepted: false, reason: "already decided" };
  await db.insert(schema.recordEvents).values({ recordId: id, kind: "approved", actorEmail: user.email });

  // Notify downstream only once the approval is durable.
  onAfterCommit(async () => {
    ctx.log.info("record approved", { id, tenantId, by: user.email });
  });
  return { accepted: true, record: approved };
});
