-- RBAC reference schema: access tables, tenant tables, and row-level security.
--
-- RLS MODEL
--   Every request runs in one transaction that sets, with SET LOCAL semantics:
--     app.tenant_scopes = 'tenant-a,tenant-b'   -- what this caller may see
--     app.is_service    = 'false'               -- 'true' only for the service token
--   A tenant table's policy admits a row only when its tenant is in that list
--   (or the request is the service path). A missing app-layer filter then
--   returns nothing instead of another tenant's data.
--
--   Policies are only DEFINED here. They do nothing until the app connects as a
--   role that neither owns the tables nor has BYPASSRLS: see db/enforce-rls.sql.

-- ---------------------------------------------------------- access tables ---
-- Operator surfaces. No RLS: auth reads app_users BEFORE it knows the caller's
-- scope (the transaction is still deny-all at that point). Restrict by GRANT.

CREATE TABLE IF NOT EXISTS app_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  idp_subject   text UNIQUE,
  role          text NOT NULL CHECK (role IN ('admin', 'editor', 'approver', 'viewer')),
  tenant_scopes text[] NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A sign-in with no account. Deliberately NOT an app_users row with role
-- 'viewer': a pending identity must not satisfy a role check by existing.
CREATE TABLE IF NOT EXISTS app_signin_requests (
  idp_subject text PRIMARY KEY,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  attempts    integer NOT NULL DEFAULT 1
);

-- Append-only audit of access changes. Actor and subject are stored by EMAIL as
-- well as id, because "who did this" is asked months later, after rows change.
-- enforce-rls.sql revokes UPDATE/DELETE/TRUNCATE from the app role.
CREATE TABLE IF NOT EXISTS app_user_events (
  id            serial PRIMARY KEY,
  subject_id    uuid NOT NULL REFERENCES app_users(id),
  subject_email text NOT NULL,
  actor_email   text NOT NULL,
  kind          text NOT NULL,
  before        jsonb,
  after         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_user_events_subject_idx ON app_user_events (subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_failures (
  day   date PRIMARY KEY,
  count integer NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------- tenant tables ---

CREATE TABLE IF NOT EXISTS tenants (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(id),
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  approved_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS records_tenant_idx ON records (tenant_id);

CREATE TABLE IF NOT EXISTS record_events (
  id          serial PRIMARY KEY,
  record_id   uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  actor_email text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------- row-level security ---

-- The one predicate every policy uses. Unset settings read as "nothing, not
-- privileged", so a request that never set a scope sees no tenant rows.
CREATE OR REPLACE FUNCTION app_tenant_allowed(check_tenant text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.is_service', true), '') = 'true'
      OR check_tenant = ANY (string_to_array(coalesce(current_setting('app.tenant_scopes', true), ''), ','));
$$;
-- A policy predicate must stay executable by every role that reads the table.
-- If a blanket "REVOKE EXECUTE ... FROM PUBLIC" ever sweeps this up, every query
-- fails with "permission denied for function app_tenant_allowed". It discloses
-- nothing (it only reads the caller's own settings), so PUBLIC is correct.
GRANT EXECUTE ON FUNCTION app_tenant_allowed(text) TO PUBLIC;

ALTER TABLE tenants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_events ENABLE ROW LEVEL SECURITY;

-- Parent tables: key on their own tenant column. WITH CHECK stops a caller
-- writing a row into a tenant it cannot read.
CREATE POLICY tenants_scope ON tenants
  USING (app_tenant_allowed(id)) WITH CHECK (app_tenant_allowed(id));
CREATE POLICY records_scope ON records
  USING (app_tenant_allowed(tenant_id)) WITH CHECK (app_tenant_allowed(tenant_id));

-- Child tables: inherit scope through the parent. Copy this shape for every
-- table that has no tenant column of its own.
CREATE POLICY record_events_scope ON record_events
  USING (EXISTS (SELECT 1 FROM records r WHERE r.id = record_id AND app_tenant_allowed(r.tenant_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM records r WHERE r.id = record_id AND app_tenant_allowed(r.tenant_id)));

-- --------------------------------------------------- ownership lookup ---
-- A detail endpoint gets an id and must authorise BEFORE reading the row, but
-- the transaction is still deny-all until the gate narrows it, so a plain
-- SELECT returns nothing. Narrowing first is wrong too: it reads tenant rows for
-- a caller the gate may be about to refuse.
--
-- So: return ONE column, the owning tenant, and nothing else. SECURITY DEFINER
-- runs it as the owner (past RLS). NULL means "no such row"; the caller must
-- answer that and "not yours" with the same 404, or the difference enumerates
-- other tenants' ids. Add one of these per detail-routable table.
CREATE OR REPLACE FUNCTION app_record_tenant(p_record_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.tenant_id FROM records r WHERE r.id = p_record_id
$$;
REVOKE ALL ON FUNCTION app_record_tenant(uuid) FROM PUBLIC;
-- Granted to the app role in enforce-rls.sql.
