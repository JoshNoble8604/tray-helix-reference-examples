/**
 * GET /session: who the UI is talking to.
 *
 * The UI shows or hides controls from this; it is never the enforcement point.
 * Every data endpoint re-checks role and tenant, and RLS sits behind that.
 *
 * Plain `defineFunction`: it reads no tenant data. It is also the endpoint the
 * UI calls first, so it is where an unknown sign-in's knock gets recorded.
 */
import { z } from "zod";
import { defineFunction } from "@trayai/helix-sdk";
import { getAppUser } from "../_shared/auth";
import { httpError } from "../_shared/http";

export const input = z.object({});

export default defineFunction<typeof input>(async (ctx) => {
  const user = await getAppUser(ctx);
  // 401 = signed in to Helix, but no account bound here. The UI shows "no access yet".
  if (!user) httpError(401, "no account for this sign-in");
  return { user: { id: user.id, email: user.email, role: user.role, tenantScopes: user.tenantScopes } };
});
