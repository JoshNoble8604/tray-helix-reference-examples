# Set up Helix with an AI coding agent

**For the agent:** the human has pointed you at this file. Follow it to get Helix
working on this machine, then help them build. Each step is tagged:

- **[AGENT RUNS]**: safe for you to run.
- **[HUMAN RUNS]**: you must not run it. Give the human the exact command and
  wait for them to confirm.

Tested with Claude Code. It works the same way with any MCP-capable agent (Codex,
OpenCode and others); only the plugin install differs (see step 5).

## 0. Rules for the agent: read these first

1. **Never handle a secret.** Don't run anything that prints or vends one: no
   `printenv`, `env`, `echo $TOKEN`, `cat ~/.tray.config`, `cat .env`, no
   password-manager CLI (`op read`, `op run`), and never ask the human to paste a
   token into the chat.
2. **Sign-ins are the human's.** `helix login`, the Tray plugin's browser
   authorization and any SSO prompt happen in the human's browser or terminal.
3. **If you read a file and find a literal secret** (an `npm_…`, bearer token or
   API key rather than a `${VAR}` or vault reference), stop. Tell the human it's
   exposed and should be rotated, and don't repeat the value.
4. **Confirm the workspace before any change.** Your Tray and Helix actions take
   effect in whatever workspace you're signed in to, as the human.

## 1. Check prerequisites [AGENT RUNS]

```bash
node --version    # need 24.18.0 or newer
which helix       # "not found" is expected before step 3
which claude      # or your agent's CLI
```

- **Node older than 24.18, or missing:** if the human can install software,
  `brew install node` (macOS) or their usual package manager is fine.
  **On a managed laptop without admin rights**, use nvm, which installs into the
  home directory and never needs sudo:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # open a new terminal, then:
  nvm install 24 && nvm alias default 24
  node --version
  ```
  With nvm, global npm installs also go under the home directory, so no sudo.

## 2. Access the human needs [HUMAN checks]

- A **Tray account in an org with Helix enabled**, and a workspace they can build
  in. If `helix workspace select` (step 6) lists nothing, ask the Tray account
  team to enable Helix. It isn't a setup mistake.
- **Build rights in the target workspace.** A deploy to a workspace without them
  fails with `HTTP 403 Forbidden`, even with the right workspace ID.

## 3. Install the Helix CLI

The packages are public on npm (`@trayai/helix-cli`, `@trayai/helix-sdk`). No
token or private registry is needed.

```bash
npm install -g @trayai/helix-cli@latest    # [AGENT RUNS] on a normal machine
helix --version
```

**If the human's `npm` is wrapped by a password manager** (for example an `npm`
shell function that injects a token via `op run`), every npm call vends a secret.
In that case it's **[HUMAN RUNS]**: they run the npm commands themselves. Check
with `type npm`: "npm is a shell function" means it's wrapped.

Ignore any instructions that mention `@trayio/helix-*`. That scope is retired and
can't deploy.

## 4. Sign in to Helix [HUMAN RUNS]

```bash
helix login          # opens a browser sign-in (OAuth); works with Okta and other SSO
helix whoami         # [AGENT RUNS] afterwards to confirm the account and region
```

Choose the method that fits how the human signs in to Tray:

| How they sign in | What to do |
|---|---|
| Tray email and password, Google, or SSO through Tray's sign-in page | `helix login`. The browser flow handles it. |
| **Only from the identity provider's dashboard** (Okta or Entra tile; no direct Tray sign-in) | Open Tray from the IdP tile in Chrome first, then run `helix login --method chrome`. That reads the signed-in session from Chrome. |
| A region other than US | Add `--region eu1`, `ap1` or `ap2` to `helix login`. Each region is separate, with its own sign-in. |

Things that trip people up:

- **The CLI's sign-in is independent of the browser.** Switching Tray accounts in
  Chrome doesn't change what the CLI is signed in as. Run `helix login` again and
  confirm with `helix whoami` before deploying.
- **Browser sign-in tokens last about an hour.** "Not logged in" partway through a
  session just means run `helix login` again.
- **1Password or another vault:** nothing in Helix needs a vault. If the human
  keeps other tokens there, keep them as references (`op://…`), never literal
  values in dotfiles.
- **AWS SSO or other cloud credentials:** Helix doesn't use the human's local
  cloud credentials. Services such as AWS Bedrock are reached through
  **authentications stored in Tray**, attached to the Helix project. Don't wire
  local `aws sso login` credentials into the app.

## 5. Connect the agent to Tray (Tray headless plugin)

This lets the agent build and edit Tray workflows, run them, and read their
execution logs. Reading the logs is the most useful part: "why did this workflow
fail?" becomes a question the agent can answer.

**Claude Code** [HUMAN RUNS], inside Claude Code:
```
/plugin marketplace add trayio/tray-plugins
/plugin install tray-workflows@tray-plugins
/reload-plugins
```
The first Tray action opens a browser to authorize, and **the workspace chosen
there is the one the agent can act in**.

**Codex:**
```bash
codex plugin marketplace add trayio/tray-plugins
codex plugin add tray-workflows@tray-plugins
codex mcp login tray
```

**Any other MCP client:** add an HTTP MCP server at `https://api.tray.io/mcp` and
authorize it in the browser.

Docs: https://tray.ai/documentation/platform/tray-headless/headless-for-claude-code

### More than one workspace (dev, UAT, prod)

One connection is tied to one workspace. To work in several without signing out
and back in, add a separately named connection per workspace:

```bash
claude mcp add --transport http tray-dev  https://api.tray.io/mcp
claude mcp add --transport http tray-prod https://api.tray.io/mcp
```

Then in Claude Code run `/mcp`, authorize each one and pick its workspace, and
start a new session (new tools load at startup). Keep production's connection
unauthorized, or remove it, until you actually mean to promote. The agent can't
change a workspace it has no connection to.

## 6. Start a Helix project

```bash
cd <projects folder>
helix init my-app --with-app --workspace-id <WORKSPACE_UUID>   # [AGENT RUNS]
cd my-app
npm install                                                    # [AGENT RUNS] (or HUMAN if npm is wrapped)
```

- The workspace UUID is in the Tray URL: `app.tray.io/workspaces/<UUID>/…`. Or
  run `helix workspace select` inside the project to pick from a list.
- `--with-app` adds a Vite and React front end in `app/`. Leave it off for a
  project with only functions.
- Workspaces are created in the Tray web app. The CLI only points a project at
  one.

Day to day:

| Command | What it does |
|---|---|
| `helix dev` | Runs locally |
| `helix deploy` | Builds and deploys to Tray. Returns a `*.code.tray.io` URL |
| `helix deployment get <id>` | Checks a deploy's status. Poll until `ready` |
| `helix project set <id>` / `helix workspace set <id>` | Changes the target (don't hand-edit `helix.config.ts`) |
| `helix ai usage` | AI usage and cost per model for the project |

**The deployed URL is behind SSO.** A `302` or a sign-in page from `curl` means
it's healthy. Open it in a browser signed in to Tray.

**Deploying often is cheap.** It's reasonable to have the agent deploy after
every change instead of only testing locally.

## 7. Keep Helix current

The CLI is global and the SDK is per project. Keep them on **exactly the same
version**, because the CLI expects its own SDK version.

```bash
npm i -g @trayai/helix-cli@latest && helix --version
cd <project> && npm install --save-exact @trayai/helix-sdk@<same version>
npm run build && helix deploy
```

Use `--save-exact`, because a caret (`^`) lets a later install pull an SDK ahead
of the CLI, and `helix dev` then hangs. Don't delete `package-lock.json` to fix
problems; the troubleshooting below covers the one case that needs it.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Deploy failed … HTTP 403` | The CLI is signed in as an account without build rights in that workspace. Check `helix whoami`; if it's wrong, run `helix login` again as the right account |
| `HTTP 404: Project not found` on deploy | `projectId` in `helix.config.ts` is a **Tray** project ID, not a Helix one. They're separate. Remove it to provision a new project, or set the Helix ID with `helix project set` |
| `BUNDLE_FAILED` | Every `.ts` under `functions/` is a route. Move shared helper code to a top-level `lib/` |
| `unknown command 'build'` | There is no `helix build`. Point the project's `build` script at Vite (`vite build app`) |
| `helix dev` hangs after a version warning | CLI and SDK versions differ. Align them (step 7) |
| `Cannot read properties of null (reading 'matches')` on `npm install` | npm bug with `node_modules` but no lockfile: `rm -rf node_modules package-lock.json && npm install` |
| `EACCES` / `Permission denied` on a `node_modules/.bin` binary | The project sits in a cloud-synced folder that stripped execute bits. Move it out of the synced folder, or restore the bits with `chmod u+x` on the named binary |
| `helix: command not found` after install | Open a new terminal so PATH updates, then `which helix` |
| Runtime errors in a deployed app | Open the project in the Helix dashboard and read its logs. Add `ctx.log(...)` for detail |
