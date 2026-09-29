/**
 * Who can call what: every routable endpoint, as every kind of caller.
 *
 * Each endpoint's real default export (scoped wrapper included) is invoked as
 * each caller against PGlite, with RLS ARMED by the real db/enforce-rls.sql and
 * the connection switched to the NOBYPASSRLS app role. So a gate that forgets
 * to narrow, or a detail endpoint that reads before authorising, fails here.
 *
 * It tests the DECISION, not the work: "allow" means the call got past the
 * gate (a later 400/409 is not this file's business); "deny" means 401, 403,
 * or the masked 404 a detail endpoint answers for another tenant's row.
 * A new endpoint fails the suite until someone writes down who may call it.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { runWithContext } from "@trayai/helix-sdk/testing";

// defineFunction returns an HTTP handler; hand back the inner function so the
// default export is callable with a ctx. The scoped wrapper still runs.
vi.mock("@trayai/helix-sdk", async (orig) => ({
  ...(await orig<typeof import("@trayai/helix-sdk")>()),
  defineFunction: (handler: unknown) => handler,
}));

import * as schema from "../db/schema";
import { setDb, type Db } from "../functions/_shared/db";
import { DENY_ALL, withRequestScope } from "../functions/_shared/request-scope";
import { readRlsStatus } from "../functions/_shared/rls-status";

const ROOT = join(__dirname, "..");
const API = join(ROOT, "functions/api");
const TENANT = "tenant-a";
const OTHER = "tenant-b";
const SERVICE_TOKEN = "grid-service-token";

/** The callers. Each signed-in one is a real, bound app_users row. */
const CALLERS = {
  admin: { role: "admin", tenantScopes: ["*"], isActive: true },
  adminOther: { role: "admin", tenantScopes: [OTHER], isActive: true },
  editor: { role: "editor", tenantScopes: [TENANT], isActive: true },
  approver: { role: "approver", tenantScopes: [TENANT], isActive: true },
  viewer: { role: "viewer", tenantScopes: [TENANT], isActive: true },
  viewerOther: { role: "viewer", tenantScopes: [OTHER], isActive: true },
  disabled: { role: "admin", tenantScopes: ["*"], isActive: false },
  anon: null,
  service: "service",
} as const;
type Caller = keyof typeof CALLERS;
const CALLER_NAMES = Object.keys(CALLERS) as Caller[];

/** THE POLICY: who gets past each gate. Change a row only with a reason. */
const GRID: Record<string, string> = {
  "invites/redeem.post.ts": "admin adminOther editor approver viewer viewerOther", // account holders reach 409 "already have access"; everyone else needs a valid link
  "records.get.ts": "admin editor approver viewer service",
  "records.post.ts": "service",
  "records/[id].get.ts": "admin editor approver viewer service",
  "records/[id].put.ts": "admin editor",
  "records/[id]/approve.post.ts": "admin approver", // people only: the service token cannot approve
  "session.get.ts": "admin adminOther editor approver viewer viewerOther",
  "users.get.ts": "admin", // admin with ALL tenants: granting access is not one tenant's call
  "users.post.ts": "admin",
  "users/[id].delete.ts": "admin",
  "users/[id].put.ts": "admin",
  "users/[id]/invite.post.ts": "admin",
  "users/waiting/[subject].delete.ts": "admin",
};

/** 404s that are refusals (another tenant's row, masked). */
const MASKS = new Set(["record not found"]);

let client: PGlite;
let db: Db;
let recordId = "";
let spareUserId = "";

function listEndpoints(dir = API): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listEndpoints(full);
    return /\.(get|post|put|delete)\.ts$/.test(name) ? [relative(API, full).split("\\").join("/")] : [];
  });
}

/** One raw input for every endpoint; each module's own schema keeps what it wants. */
function rawInput(endpoint: string): Record<string, unknown> {
  const id = endpoint.startsWith("users/") ? spareUserId : recordId;
  return {
    id,
    tenantId: TENANT,
    subject: "grid-waiting",
    title: "edited by the grid",
    email: `grid-${randomUUID()}@example.test`,
    role: "viewer",
    tenantScopes: [],
    token: "grid.not-a-real-invite",
  };
}

function ctxFor(caller: Caller | "stranger", input: unknown) {
  const who = caller === "stranger" ? "stranger" : CALLERS[caller];
  const subject = who && who !== "service" ? `grid-${caller}` : null;
  return {
    input,
    method: "POST",
    path: "/api/grid",
    headers: who === "service" ? { "x-service-token": SERVICE_TOKEN } : {},
    status: vi.fn(),
    error: (code: number, message: string): never => {
      throw Object.assign(new Error(message), { status: code });
    },
    identity: subject ? { user: { id: subject } } : null,
    userId: subject,
    config: { SERVICE_TOKEN, INVITE_SIGNING_SECRET: "grid-invite-secret" },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {},
    executionId: randomUUID(),
    deploymentId: "role-grid",
    traceId: randomUUID(),
  };
}

async function outcome(endpoint: string, caller: Caller | "stranger"): Promise<"allow" | "deny"> {
  const mod = await import(/* @vite-ignore */ join(API, endpoint));
  const raw = rawInput(endpoint);
  const parsed = mod.input.safeParse(raw);
  const ctx = ctxFor(caller, parsed.success ? parsed.data : raw);
  try {
    await runWithContext(ctx as never, () => mod.default(ctx));
  } catch (e) {
    const err = e as { status?: number; statusCode?: number; message?: string };
    const status = err.status ?? err.statusCode;
    if (status === 401 || status === 403) return "deny";
    if (status === 404 && MASKS.has(String(err.message))) return "deny";
    if (status === undefined) throw e; // a crash is not a policy outcome
    return "allow";
  }
  return "allow";
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec(readFileSync(join(ROOT, "db/migrations/0001_rbac.sql"), "utf8"));

  // Seed as the owner, before RLS applies to us.
  await client.query(`INSERT INTO tenants (id, name) VALUES ($1, 'A'), ($2, 'B')`, [TENANT, OTHER]);
  for (const c of CALLER_NAMES) {
    const who = CALLERS[c];
    if (!who || who === "service") continue;
    await client.query(
      `INSERT INTO app_users (email, idp_subject, role, tenant_scopes, is_active) VALUES ($1, $2, $3, $4, $5)`,
      [`grid-${c}@example.test`, `grid-${c}`, who.role, who.tenantScopes, who.isActive],
    );
  }
  const spare = await client.query<{ id: string }>(
    `INSERT INTO app_users (email, role) VALUES ('grid-spare@example.test', 'viewer') RETURNING id`,
  );
  spareUserId = spare.rows[0].id;
  const rec = await client.query<{ id: string }>(`INSERT INTO records (tenant_id, title) VALUES ($1, 'Grid record') RETURNING id`, [TENANT]);
  recordId = rec.rows[0].id;
  await client.query(`INSERT INTO record_events (record_id, kind, actor_email) VALUES ($1, 'created', 'seed')`, [recordId]);
  await client.query(`INSERT INTO records (tenant_id, title) VALUES ($1, 'Other tenant record')`, [OTHER]);

  // Arm RLS with the real script, then become the app role for the rest of the suite.
  const arm = readFileSync(join(ROOT, "db/enforce-rls.sql"), "utf8").replace(
    "v_password text := 'CHANGE_ME';",
    "v_password text := 'test-only-password';",
  );
  await client.exec(arm);
  await client.exec("SET ROLE app_runtime");

  db = drizzle(client, { schema }) as unknown as Db;
  setDb(db);
  process.env.SERVICE_TOKEN = SERVICE_TOKEN;
  delete process.env.BOOTSTRAP_ADMIN_EMAIL;
}, 120_000);

afterAll(async () => {
  setDb(null);
  await client?.close();
});

describe("RLS is armed for this suite", () => {
  it("reports enforced for the app role", async () => {
    expect(await readRlsStatus(db)).toEqual({ enforced: true, reasons: [] });
  });

  it("confines parent and child tables to the scope, and deny-all sees nothing", async () => {
    const count = (scope: Parameters<typeof withRequestScope>[1]) =>
      withRequestScope(db, scope, async (tx) => ({
        records: (await tx.select().from(schema.records)).length,
        events: (await tx.select().from(schema.recordEvents)).length,
      }));
    expect(await count(DENY_ALL)).toEqual({ records: 0, events: 0 });
    expect(await count({ tenantScopes: [TENANT] })).toEqual({ records: 1, events: 1 });
    expect(await count({ tenantScopes: [OTHER] })).toEqual({ records: 1, events: 0 });
    expect(await count({ tenantScopes: [], isService: true })).toEqual({ records: 2, events: 1 });
  });

  it("refuses to write a row into a tenant outside the scope (WITH CHECK)", async () => {
    await expect(
      withRequestScope(db, { tenantScopes: [OTHER] }, (tx) => tx.insert(schema.records).values({ tenantId: TENANT, title: "x" })),
    ).rejects.toThrow();
  });

  it("does not let the app role rewrite the audit trail", async () => {
    const err = await db.delete(schema.appUserEvents).then(() => null, (e: Error) => e);
    // drizzle wraps the driver error; the Postgres message is on `cause`.
    expect(String((err as { cause?: Error } | null)?.cause?.message)).toMatch(/permission denied/);
  });
});

describe("role grid", () => {
  it("lists every routable endpoint, and nothing that no longer exists", () => {
    expect(Object.keys(GRID).sort()).toEqual(listEndpoints().sort());
  });

  it.each(Object.keys(GRID).sort())("%s admits exactly its row", async (endpoint) => {
    const admitted: string[] = [];
    for (const c of CALLER_NAMES) if ((await outcome(endpoint, c)) === "allow") admitted.push(c);
    expect(admitted, `${endpoint}: who got past the gate`).toEqual(GRID[endpoint].split(" ").filter(Boolean));
  }, 60_000);
});

describe("refusal bookkeeping survives the refusal's rollback", () => {
  it("records the knock and the auth failure for an unknown sign-in", async () => {
    expect(await outcome("records.get.ts", "stranger")).toBe("deny");
    const knock = await db.select().from(schema.appSigninRequests).where(eq(schema.appSigninRequests.idpSubject, "grid-stranger"));
    expect(knock).toHaveLength(1);
    const failures = await db.select().from(schema.authFailures);
    expect(failures[0]?.count ?? 0).toBeGreaterThan(0);
  });
});
