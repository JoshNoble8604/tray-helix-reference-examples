/**
 * Is RLS actually ENFORCED for this connection, or only defined?
 *
 * Policies named for tenancy read like isolation, and a reviewer will assume it
 * exists. This reports the truth so nobody has to assume. Surface it on an ops
 * or health endpoint (admin-only) and alert when `enforced` is false.
 *
 * Requires POSITIVE evidence: no bypass AND policies exist AND every tenant
 * table has RLS enabled and a policy. A database with its policies dropped
 * satisfies "no bypass" too, and must not report green.
 */
import { sql } from "drizzle-orm";
import { rowsOf, type Db } from "./db";

/** Every table that holds tenant data. A table added here without a policy fails the check. */
export const TENANT_TABLES = ["tenants", "records", "record_events"] as const;

export interface RlsStatus {
  enforced: boolean;
  /** Why not, in words an operator can act on. Empty when enforced. */
  reasons: string[];
}

/** Never throws: "could not verify" is a not-enforced answer, not an outage. */
export async function readRlsStatus(db: Db): Promise<RlsStatus> {
  try {
    // An explicit IN list: drizzle expands a JS array into a row constructor,
    // so `= ANY(${array})` would be a syntax error.
    const tables = sql.join(TENANT_TABLES.map((t) => sql`${t}`), sql`, `);
    const result = await db.execute(sql`
      SELECT
        (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS super,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
            AND NOT c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = current_user) AS owned_unforced,
        (SELECT string_agg(c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname IN (${tables})
            AND (NOT c.relrowsecurity OR NOT EXISTS (
              SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname))) AS uncovered
    `);
    const info = rowsOf<Record<string, unknown>>(result)[0];
    if (!info) return { enforced: false, reasons: ["could not read the catalogue"] };
    const reasons: string[] = [];
    if (info.super === true) reasons.push("the connection role is a superuser");
    if (info.bypass === true) reasons.push("the connection role has BYPASSRLS");
    if (Number(info.owned_unforced) > 0) reasons.push(`${info.owned_unforced} table(s) owned by this role without FORCE ROW LEVEL SECURITY`);
    if (info.uncovered) reasons.push(`tenant tables without RLS enabled or without a policy: ${info.uncovered}`);
    return { enforced: reasons.length === 0, reasons };
  } catch (err) {
    return { enforced: false, reasons: [`could not verify: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
