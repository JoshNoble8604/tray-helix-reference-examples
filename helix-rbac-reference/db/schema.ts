/**
 * Drizzle schema for the RBAC reference. Mirrors db/migrations/0001_rbac.sql.
 *
 * Two kinds of table:
 *  - access tables (app_users, app_signin_requests, app_user_events,
 *    auth_failures): operator surfaces, NOT tenant-scoped. Restricted by GRANT,
 *    not RLS, because auth must read them before it knows the caller's scope.
 *  - tenant tables (tenants, records, record_events): every row belongs to one
 *    tenant and is covered by an RLS policy on `app.tenant_scopes`.
 */
import { sql } from "drizzle-orm";
import { boolean, date, integer, jsonb, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";

/* ---------------------------------------------------------------- access --- */

export const appUsers = pgTable("app_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  /** The Helix Identity subject. NULL = invited, not yet bound to a sign-in. */
  idpSubject: text("idp_subject").unique(),
  role: text("role").notNull(), // admin | editor | approver | viewer
  /** Tenant ids, or ["*"] for every tenant. */
  tenantScopes: text("tenant_scopes").array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An authenticated identity with no account (the "knock"). Carries no role and
 * no scope on purpose: a row here can never satisfy a role check.
 */
export const appSigninRequests = pgTable("app_signin_requests", {
  idpSubject: text("idp_subject").primaryKey(),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(1),
});

/** Append-only record of every access change. The app role cannot UPDATE/DELETE it. */
export const appUserEvents = pgTable("app_user_events", {
  id: serial("id").primaryKey(),
  subjectId: uuid("subject_id").notNull(),
  subjectEmail: text("subject_email").notNull(),
  actorEmail: text("actor_email").notNull(),
  /** created | role_changed | scopes_changed | activated | deactivated | claimed | removed | restored */
  kind: text("kind").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Refused authentications per day: a number you can alert on, not a log line. */
export const authFailures = pgTable("auth_failures", {
  day: date("day").primaryKey(),
  count: integer("count").notNull().default(0),
});

/* ---------------------------------------------------------------- tenant --- */

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(), // slug: [a-z0-9-]
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Example parent table: carries tenant_id directly. */
export const records = pgTable("records", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  title: text("title").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved
  approvedBy: text("approved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Example child table: reaches its tenant through its parent (RLS via EXISTS). */
export const recordEvents = pgTable("record_events", {
  id: serial("id").primaryKey(),
  recordId: uuid("record_id").notNull().references(() => records.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  actorEmail: text("actor_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
