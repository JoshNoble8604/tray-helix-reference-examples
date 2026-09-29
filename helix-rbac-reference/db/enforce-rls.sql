-- Arm row-level security: turn the policies from decoration into enforcement.
--
-- RUN AS A SUPERUSER / the schema owner, once per environment, AFTER the
-- migrations. The application cannot do this for itself and should not be able to.
--
-- WHY. Policies in 0001_rbac.sql deny nothing while ANY of these is true:
--   1. the app connects as a role with BYPASSRLS (or a superuser);
--   2. the app connects as the table OWNER (owners skip their own policies
--      unless FORCE ROW LEVEL SECURITY is set);
--   3. FORCE ROW LEVEL SECURITY is off.
-- The schema will look like it isolates tenants and it will not.
-- functions/_shared/rls-status.ts reports which of these holds at runtime.
--
-- ORDER OF OPERATIONS (doing 4 before 1 takes the app down: every query denied):
--   1. every endpoint uses defineScopedFunction and a gate that narrows the scope
--   2. run the tests (test/role-grid.test.ts runs this very script, then the grid,
--      as the NOBYPASSRLS role)
--   3. stop migrating on boot as the app role; run migrations as the OWNER
--      (the app role has no CREATE, so DDL fails)
--   4. run this script on staging; check the verification queries at the bottom
--   5. only then production, and only then point DATABASE_URL at app_runtime

-- 1. A login role that owns nothing and bypasses nothing.
--    Refuses to run with the placeholder password.
DO $$
DECLARE
  v_password text := 'CHANGE_ME';
BEGIN
  IF v_password = 'CHANGE_ME' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Edit this script first: replace v_password with a generated secret.',
      HINT    = 'e.g. openssl rand -base64 24. Put the same value in DATABASE_URL and do not commit it. With managed/IAM auth, create the role there and delete this block.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE format('CREATE ROLE app_runtime LOGIN NOBYPASSRLS PASSWORD %L', v_password);
  END IF;
END $$;

-- 2. Use the schema and the tables, nothing more. No ownership, no CREATE.
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- Ownership lookups are SECURITY DEFINER and revoked from PUBLIC; grant by name.
GRANT EXECUTE ON FUNCTION app_record_tenant(uuid) TO app_runtime;

-- 2b. Take back what the app must never do. An audit trail the app can edit is
--     not an audit trail. Add every new append-only table here: there is no way
--     to infer "append-only" from the schema.
REVOKE UPDATE, DELETE, TRUNCATE ON app_user_events FROM app_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON record_events   FROM app_runtime;
-- (ON DELETE CASCADE from records still works: referential actions run as the
--  table owner, not as the caller.)

-- 3. Close the owner loophole on every RLS-enabled table.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 4. Verify before repointing DATABASE_URL.
--    Expect rolbypassrls = false, rolsuper = false, and every row forced = true.
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime';
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
ORDER BY c.relname;
