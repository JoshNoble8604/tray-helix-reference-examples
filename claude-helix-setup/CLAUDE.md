# Tray and Helix: context for the agent

Copy this file into the root of a new project (or into `~/.claude/CLAUDE.md` for
every project) so a fresh agent session knows what Tray and Helix are without
being told each time. For first-time machine setup, see `HELIX-SETUP.md`.

## What the pieces are

- **Tray** is an integration and automation platform. Work lives in **workflows**
  (a trigger plus steps that call connectors), grouped into **projects** inside a
  **workspace**. Credentials are stored as **authentications** in the workspace.
- **Tray headless** is the MCP server behind the `tray-workflows` plugin
  (`https://api.tray.io/mcp`). It gives you tools to build, edit, validate and run
  workflows, and to read execution logs step by step. Each connection is tied to
  **one workspace**, chosen when the human authorized it.
- **Helix** is Tray's platform for code: TypeScript functions (file-based routes
  under `functions/`), scheduled functions (`functions/_scheduled/`) and an
  optional React front end (`app/`), deployed with the `helix` CLI to a URL behind
  Tray SSO. Packages: `@trayai/helix-cli` (global) and `@trayai/helix-sdk` (per
  project), always on the same exact version. Never use `@trayio/helix-*`, which
  is retired.

## How they connect

- **A Helix app can call Tray workflows**, through a workflow's webhook or,
  better, an **API operation** (API Management), which has its own URL and a
  token.
- **A Tray workflow cannot call into a Helix app.** There's no inbound route from
  workflows to Helix functions. Design data flows so Helix calls Tray, or so both
  read and write a shared store.
- **Who can do what:**
  - **Tray workspace roles** (member, viewer) govern editing workflows and seeing
    the underlying plumbing. Helix inherits workspace membership from Tray.
  - **Helix app access control** decides who can open a deployed app. Someone
    added only there can use the app but can't see or edit its workflows.
  - **Anything finer** (roles inside the app, per-record permissions) is built in
    the app itself, keyed on the signed-in Tray user. See `helix-rbac-reference/`
    in this repository.

## Choosing a Helix function or a Tray workflow

Decide this before building. Moving a lot of logic from one to the other later is
slow.

| Use a **Helix function** for | Use a **Tray workflow** for |
|---|---|
| Quick request and response work behind a UI: a lookup that fills a dropdown, validation, formatting | Long-running or multi-step processes, retries, and work that has to scale out |
| Logic that belongs with the app's code | Anything a business user should be able to read and change in the Tray builder |
| | Integrations that use Tray connectors and stored authentications |

## Working rules

- **Confirm the workspace first.** Check which workspace your Tray connection is
  tied to before changing anything. Use separate workspaces as environments
  (dev, UAT, prod). Build and test in dev, and only promote to prod when the
  human asks, through a connection authorized for prod.
- **Read the logs before guessing.** When a workflow misbehaves, pull its recent
  executions and the failing step's input and output rather than theorising.
- **Validate after every workflow change,** and don't fire a workflow with real
  side effects (messages, records, emails) without the human's go-ahead.
- **Deploy freely.** `helix deploy` after a change is cheap, and the deployed app
  is the real test. Poll `helix deployment get <id>` until it's `ready`.
- **Never handle secrets.** Sign-ins, tokens and vault access belong to the human
  (see the rules in `HELIX-SETUP.md`).
- **Some console features have no public API** (for example registering an API
  Management operation). Don't invent endpoints. Say what can't be done through
  the API, and use the Playwright scripts in `tray-playwright-kit` if the human
  wants it automated.

## Useful facts

- `helix.config.ts` uses `region` (`us1`, `eu1`, `ap1`, `ap2`), not `env`.
  `"production"` isn't a valid region.
- There is no `helix build` command. Builds go through Vite.
- Shared helper code must live outside `functions/`, because every `.ts` there is
  a route.
- A Helix project ID and a Tray project ID are different things. Don't mix them in
  `helix.config.ts`.
