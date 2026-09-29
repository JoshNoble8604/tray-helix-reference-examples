# Tray and Helix reference examples

Two standalone references. Each folder has its own README with setup steps.

| Folder | What it is |
|---|---|
| [`slack-ops-assistant/`](slack-ops-assistant/) | A two-way Slack bot built from Tray workflows, without Agent Builder. It posts Block Kit alerts when watched workflows fail and a daily health report, and answers questions about recent runs (Claude on AWS Bedrock). Buttons and @mentions route to the agent. Includes an importable Tray project, the Slack app manifest, the step scripts and their tests. |
| [`helix-rbac-reference/`](helix-rbac-reference/) | Role-based access control with tenant isolation for a Helix app: four roles plus tenant scopes, endpoint gates, Postgres row-level security, first-admin setup, invites and an audit log. Copy the design into your own app; the `records` endpoints stand in for your own data. |

Both are reference implementations. Review and adapt them before using them in
production. Neither contains credentials: bring your own Slack app, AWS Bedrock
access and database.

## Running the tests

```
# Slack step scripts (Node 20+, no dependencies)
node --test slack-ops-assistant/tray/scripts/scripts.test.mjs

# Helix RBAC (installs its dev dependencies first)
cd helix-rbac-reference && npm install && npx tsc --noEmit && npx vitest run
```
