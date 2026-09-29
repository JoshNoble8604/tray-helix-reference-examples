/**
 * GET /users: every account, plus sign-ins waiting for access.
 *
 * Admin with all tenants only. The list says who can approve what, which is
 * nothing a viewer or a one-tenant admin needs.
 */
import { z } from "zod";
import { asc } from "drizzle-orm";
import { defineScopedFunction } from "../_shared/scoped-function";
import { ensureDb, schema } from "../_shared/db";
import { requireAllTenants, requireRole } from "../_shared/auth";
import { removedUserIds } from "../_shared/users";

export const input = z.object({});

export default defineScopedFunction<typeof input>(async (ctx) => {
  const actor = await requireRole(ctx, ["admin"]);
  requireAllTenants(actor, "managing people");
  const db = await ensureDb();

  const users = await db.select().from(schema.appUsers).orderBy(asc(schema.appUsers.email));
  // Listed beside the accounts: Identity gives no email, so an admin is the
  // only one who can decide which waiting sign-in is which invited person.
  const waiting = await db.select().from(schema.appSigninRequests).orderBy(asc(schema.appSigninRequests.firstSeen));
  const removed = await removedUserIds(db);

  return {
    users: users
      .filter((u) => !removed.has(u.id))
      .map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        tenantScopes: u.tenantScopes,
        isActive: u.isActive,
        // "Invited" vs "has signed in": the last-admin guard counts only the latter.
        hasSignedIn: u.idpSubject !== null,
      })),
    waiting,
  };
});
