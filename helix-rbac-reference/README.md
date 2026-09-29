# Helix RBAC reference

A small, working reference for role-based access control with tenant isolation
in a Helix app (`@trayai/helix-sdk` 1.2.0, drizzle-orm, Postgres, zod, React).
Copy the design, not necessarily the files. The `records` table and endpoints
are stand-ins for your own tenant data.

```
db/schema.ts                     drizzle schema (access tables + example tenant tables)
db/migrations/0001_rbac.sql      tables, app_tenant_allowed(), RLS policies, ownership lookup
db/enforce-rls.sql               arms RLS: app role, grants, FORCE RLS, append-only revokes
functions/_shared/db.ts          ensureDb() that returns the request's transaction
functions/_shared/request-scope.ts  per-request SET LOCAL scope, DENY_ALL, onAfterCommit
functions/_shared/scoped-function.ts  defineScopedFunction
functions/_shared/auth.ts        identity lookup, bootstrap, every gate
functions/_shared/users.ts       role rules, last-admin guard, audit, removal, invites
functions/_shared/rls-status.ts  "is RLS actually enforced?" check
functions/_shared/http.ts        httpError (typed never), setting()
functions/api/...                session, people management, invite redemption, example tenant endpoints
app/src/session.tsx              React provider, no-access state, can*() affordance helpers
test/role-grid.test.ts           endpoint x caller policy grid, run with RLS armed (PGlite)
```

## Roles and scope

Access is **role AND tenant scope**. A role says what someone may do. Their
scope (`tenant_scopes`, a list of tenant ids, or `["*"]` for every tenant) says
where they may do it.

| Role       | Reads | Edits tenant data | Approves (irreversible) | Manages people        |
|------------|:-----:|:-----------------:|:-----------------------:|:---------------------:|
| `admin`    | yes   | yes               | yes                     | only with `*` scope   |
| `editor`   | yes   | yes               | no                      | no                    |
| `approver` | yes   | no                | yes                     | no                    |
| `viewer`   | yes   | no                | no                      | no                    |
| service token | all tenants | via service endpoints only | **no** (not a person) | no |

Editing and approving are split on purpose. Approving is the act you can't
undo, and the person who shapes a thing shouldn't automatically get to sign it
off. `viewer` is read-only by exclusion, so no gate ever names it.

Controls whose effect reaches beyond one tenant (managing people above all)
also require `*` via `requireAllTenants`. Without that, a one-tenant admin
could grant anyone, including a second account of their own, every tenant.

### Capability matrix (the example endpoints)

The source of truth is `GRID` in `test/role-grid.test.ts`. The test fails
whenever an endpoint is added without an entry there.

| Endpoint                         | admin `*` | admin (other tenant) | editor | approver | viewer | viewer (other) | service |
|----------------------------------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `GET /session`                   | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |
| `GET /records?tenantId=`         | ✓ |   | ✓ | ✓ | ✓ |   | ✓ |
| `POST /records`                  |   |   |   |   |   |   | ✓ |
| `GET /records/:id`               | ✓ |   | ✓ | ✓ | ✓ |   | ✓ |
| `PUT /records/:id`               | ✓ |   | ✓ |   |   |   |   |
| `POST /records/:id/approve`      | ✓ |   |   | ✓ |   |   |   |
| `GET/POST /users`, `PUT/DELETE /users/:id`, `POST /users/:id/invite`, `DELETE /users/waiting/:subject` | ✓ |   |   |   |   |   |   |
| `POST /invites/redeem`           | callers with no account, holding a valid link | | | | | | |

## Three layers

```
  UI affordance         app/src/session.tsx: canEdit / canDecide / canManagePeople
  (hides buttons)       Convenience only. Never the enforcement point.
        |
        v
  Endpoint gate         functions/_shared/auth.ts: requireRole / requireApprover /
  (the real decision)   requireTenantRead / requireServiceScope / requireAllTenants
        |               Fails closed. Narrows the DB scope after the last refusal.
        v
  Postgres RLS          app_tenant_allowed() over app.tenant_scopes / app.is_service
  (the backstop)        A forgotten WHERE returns nothing instead of another tenant's rows.
```

Each layer assumes the one above it is wrong. Someone editing session state in
devtools gets refusals, and a handler that forgets its tenant filter gets
empty results.

## Request lifecycle

```
 HTTP request
   |
   v
 defineScopedFunction ── BEGIN; set_config('app.tenant_scopes','',true);
   |                            set_config('app.is_service','false',true)   <- DENY_ALL
   |                     (ensureDb() now returns this transaction, everywhere)
   v
 gate (auth.ts)
   |  getAppUser: app_users WHERE idp_subject = ctx.identity.user.id
   |              (app_users has no RLS, so it is readable at deny-all)
   |  refuse: 401 no caller / 403 wrong role / 403 or masked 404 out-of-scope tenant
   |  narrowScopeTo(user):  scopes include "*"  -> is_service = true
   |                        otherwise           -> tenant_scopes = 'a,b'
   v
 handler reads/writes; RLS admits only in-scope rows
   |
   v
 COMMIT ── onAfterCommit callbacks (webhooks, emails: only once durable)
   |
   └───── onRequestEnd callbacks, commit OR rollback
          (auth-failure counter, sign-in knock: they must survive the refusal)
```

Rules the code follows, and why:

- **Fail closed.** No `SERVICE_TOKEN` configured means no service access. An unscoped transaction sees nothing. An unset role check refuses.
- **`SET LOCAL`, never `SET`.** The scope has to end with the transaction. A session-level setting stays on the pooled connection and gives the next request someone else's tenants. `set_config(name, value, true)` is the parameterised form. `SET LOCAL` can't take bind parameters, so it would mean string-building the one statement that confines the request.
- **Narrow only after every refusal.** If you narrow first, the handler can read tenant rows for a caller the gate is about to reject.
- **`*` goes down the service path, never into the RLS setting.** The policy checks list membership, so a literal `*` would match only a tenant named `*`. A wildcard that quietly denies everything is worse than one that's refused.
- **Mask 404 for scope, never for role.** On a detail endpoint, "not yours" and "no such row" must return the same 404. Otherwise the difference lets someone enumerate other tenants' ids. "You are not an approver" stays a 403, because it reveals nothing about which ids exist. List endpoints don't mask: the caller chose the tenant.
- **Authorise before reading.** A detail endpoint gets an id and has to learn the owning tenant without reading the row, since the transaction is still deny-all. `app_record_tenant(id)` is a `SECURITY DEFINER` function that returns the tenant id and nothing else. Add one for each detail-routable table.
- **Some caller before any lookup.** `requireSomeCaller` or `getAppUser` runs before the ownership lookup. Otherwise an anonymous caller gets 404 for a missing id and 401 for a real one, which is the same leak.
- **The actor comes from the session, never from the body.** A client must not be able to name who approved something.
- **Sync service gate.** `requireServiceAuth` is synchronous. If an async gate's call site forgets `await`, it throws into a floating promise and the request goes through anyway.

## Identity, bootstrap, and onboarding

Helix Identity gives the function an **opaque subject** (`ctx.identity.user.id`)
and no email. That drives the whole onboarding design:

- **Lookup is by subject only.** Never fall back to matching on email or any other value, because that's a second way in around binding.
- **The first admin is pre-bound.** "The first sign-in while no admin exists becomes admin" is a race that any identity your SSO admits can win. Instead:
  1. Set `BOOTSTRAP_ADMIN_EMAIL`, deploy, and sign in. You're refused, and your subject is recorded in `app_signin_requests` and logged.
  2. Set `BOOTSTRAP_ADMIN_SUBJECT` to that subject, redeploy, and sign in again. You're now an admin with `*`.
  3. Unset both. The bootstrap also closes itself once an active admin with a bound identity exists.
- **Unknown sign-ins knock.** A signed-in identity with no account gets a row in `app_signin_requests` (no role, no scope) so an admin can see who's waiting. It grants nothing. `GET /session` returns 401, and the UI shows "You don't have access yet".

### Invite and binding

```
admin: POST /users {email, role, tenantScopes}     -> app_users row, idp_subject NULL (grants nothing)
admin: POST /users/:id/invite                      -> /join?invite=<token>, 7 days, HMAC(INVITE_SIGNING_SECRET)
admin sends the link out of band
person (signed in to Helix) opens it -> UI POSTs /invites/redeem {token}
   -> sets idp_subject WHERE it is still NULL (single use without a nonce table)
   -> deletes their knock, appends a `claimed` audit event
alternative: admin binds a waiting sign-in directly, PUT /users/:id {idpSubject}
```

Binding is **one-way**. An identity can be bound to an account that has none,
and is never moved or overwritten. Repointing an existing user's identity
would be a silent account takeover. Removing a user cancels every invite link
already sent to them.

## People management rules (`functions/_shared/users.ts`)

- **Never remove the last admin.** Demoting, deactivating, or removing the last *claimed* admin (active, identity bound) is refused. An invited admin nobody has signed in as doesn't count.
- **Use an advisory lock, not row locks.** Every change that could shrink the admin set takes `pg_advisory_xact_lock(hashtext('app:admin_set'))` before any row lock. With row locks alone, two admins demoting each other lock A-then-B and B-then-A, and Postgres aborts one of them. A lock order would fix that until someone adds a query that ignores it. A single named lock can't be taken in the wrong order.
- **No one edits their own access.** This isn't a privilege ceiling. It stops the likeliest way to lock yourself out by accident.
- **One transaction per change.** Read, validate, write, audit, and clean up happen together. Split up, a change can commit without its audit row.
- **The audit log is append-only.** `app_user_events` stores actor and subject by email as well as id. `enforce-rls.sql` revokes UPDATE, DELETE, and TRUNCATE from the app role, which turns the convention into a permission.
- **Removal is soft.** The audit trail references the user row, so removal takes away role, scopes, and identity, then appends `removed`. Adding the same email again restores the account as a fresh, unbound invite.

## Arming RLS

The policies in the migration **do nothing** while the app connects as a
superuser, a `BYPASSRLS` role, or the table owner. `db/enforce-rls.sql` creates
`app_runtime` (NOBYPASSRLS, owns nothing), grants table access, revokes writes
on append-only tables, and sets `FORCE ROW LEVEL SECURITY`. Order matters:

1. Every endpoint uses `defineScopedFunction` and a gate that narrows. If you arm RLS before this, every query is denied.
2. Run the tests. The grid runs this exact script and then runs every endpoint as `app_runtime`.
3. Run migrations as the **owner**, out of band. `app_runtime` has no CREATE.
4. Run the script on staging and check its verification queries. Then run it in production, and only then point `DATABASE_URL` at `app_runtime`.

Expose `readRlsStatus()` (`rls-status.ts`) on an admin-only health endpoint
and alert when `enforced` is false. It requires positive evidence: policies
exist, and every tenant table is enabled and covered.

## Integrating into your app

1. Add the four access tables and `app_tenant_allowed()` from `0001_rbac.sql`. Keep the tenant id format `[a-z0-9-]`, because `encodeTenantScopes` refuses anything else. A comma would widen the scope.
2. For each tenant table: `ENABLE ROW LEVEL SECURITY` and a policy. Parent tables use `app_tenant_allowed(tenant_id)`. Child tables use `EXISTS (... parent ... app_tenant_allowed(p.tenant_id))`. Always include `WITH CHECK`. Add each table to `TENANT_TABLES` in `rls-status.ts`.
3. For each detail-routable table, add an `app_<table>_tenant(id)` ownership function (SECURITY DEFINER, revoked from PUBLIC, granted to the app role).
4. Wrap every tenant-data endpoint in `defineScopedFunction`, and always reach the database through `ensureDb()`. Never hold on to a `Db` handle across the request.
5. Pick one gate per endpoint:
   - list: `requireTenantRead(ctx, tenantId)`
   - detail: `requireSomeCaller`, then the ownership lookup, then `requireTenantRead(..., { maskAsNotFound })`
   - edit: `requireRole(ctx, EDIT_ROLES, tenant, { maskAsNotFound })`
   - decide: `requireApprover(ctx, tenant, { maskAsNotFound })`
   - machine: `requireServiceScope`
   - cross-tenant admin: `requireRole(ctx, ["admin"])` plus `requireAllTenants`
   - If a gate is a disjunction none of these express, check inline, then call `narrowScopeTo` / `narrowScopeToService` **after** the last refusal.
6. Put side effects that must only follow a durable change in `onAfterCommit`.
7. Settings: `SERVICE_TOKEN`, `INVITE_SIGNING_SECRET`, `DATABASE_URL`, and, for first deploy only, `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_SUBJECT`. Keep secrets in your secret store, not in the repo.
8. In the Helix project's Access Control, grant who may open the app at all. This RBAC decides what they can do once inside. People need both.
9. UI: wrap the app in `<SessionProvider><AccessGate>`. Use the `can*()` helpers only to hide controls. On the people page, disable "demote" for the last signed-in admin as a courtesy. The server enforces it either way.

## What to test

`test/role-grid.test.ts` shows the pattern. It runs against PGlite with the real
migration and arming script, as the NOBYPASSRLS role:

- **The grid:** every endpoint, as every caller (each role, in-scope and out-of-scope, a disabled account, anonymous, the service token), must admit exactly the listed callers. It also fails if an endpoint exists without a row.
- **RLS directly:** deny-all sees nothing, a scoped transaction sees only its tenant (child tables included), the service path sees everything, `WITH CHECK` refuses cross-tenant writes, and the app role can't delete audit rows.
- **Refusal bookkeeping** (the knock and the auth-failure count) survives the refusal's rollback.

Note that the grid tests *decisions*. A gate that skips narrowing shows up on
detail endpoints (masked 404), but on a list endpoint it looks like an empty,
successful result. Add data assertions for your important list endpoints.
Worth adding for your app: concurrent demotion of two admins (expect one 409,
no deadlock), invite reuse and expiry, and self-edit refusal.

Run: `npm install && npm run typecheck && npm test`.

## Deliberate omissions

- **No org allow/deny list.** If your users belong to organisations and some must never hold an account, enforce it inside `getAppUser` (deny by value, so a row written directly to the table is still refused), not only in the invite form.
- **No automatic "match invite by email".** Identity currently sends no email claim. If yours does, you can connect an unbound, non-admin account whose email matches, but never an admin account.
- **No dev-session fallback in the UI.** If `/session` can't be reached, the UI says so. It never renders a fake session.
