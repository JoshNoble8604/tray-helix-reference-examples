/**
 * POST /invites/redeem {token}: "this sign-in is the person the link was for".
 *
 * The one endpoint a caller WITHOUT an account may call. Helix must have
 * authenticated them, and they must not already have an account. Everything
 * else is the token's job (users.ts).
 */
import { z } from "zod";
import { defineScopedFunction } from "../../_shared/scoped-function";
import { ensureDb } from "../../_shared/db";
import { getAppUser, recordAuthFailure } from "../../_shared/auth";
import { redeemInvite, verifyInvite } from "../../_shared/users";
import { httpError } from "../../_shared/http";

export const input = z.object({ token: z.string().min(10).max(2000) });

export default defineScopedFunction<typeof input>(async (ctx) => {
  const subject = ctx.identity?.user?.id;
  if (!subject) httpError(401, "sign in first, then open the invite link again");
  if (await getAppUser(ctx)) httpError(409, "you already have access");

  const check = verifyInvite(ctx.input.token);
  if (!check.ok) {
    await recordAuthFailure();
    httpError(check.reason === "expired" ? 410 : 403, check.reason === "expired" ? "this invite has expired" : "this invite link is not valid");
  }
  const { email } = await redeemInvite(await ensureDb(), check.userId, subject, check.issuedAt);
  return { ok: true, email };
});
