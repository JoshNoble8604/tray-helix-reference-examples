# Claude and Helix setup bundle

Docs to hand an AI coding agent (Claude Code, Codex, OpenCode or any other MCP
client) so it can set up and work with Tray and Helix without you walking it
through every step.

| File | Give it to the agent when |
|---|---|
| [`HELIX-SETUP.md`](HELIX-SETUP.md) | Setting up a machine: installing the Helix CLI, signing in (including Okta or IdP-only sign-in, managed laptops without admin rights, and wrapped `npm`), connecting the Tray plugin, running several workspaces as dev, UAT and prod, and troubleshooting |
| [`CLAUDE.md`](CLAUDE.md) | Starting any new project. It tells a fresh session what Tray, Tray headless and Helix are, how they connect, and when to use a Helix function versus a Tray workflow |

**How to use it:** in a new session, say *"Set up Helix using
`claude-helix-setup/HELIX-SETUP.md`"*. For ongoing work, copy `CLAUDE.md` into the
project root (or into `~/.claude/CLAUDE.md` for every project).

The agent is told to run the safe steps itself and to hand anything involving a
sign-in, token or vault back to you.

## Related examples

- [`../helix-rbac-reference/`](../helix-rbac-reference/): roles and permissions
  inside a Helix app, tied to the signed-in Tray user, with no separate login.
- [`../slack-ops-assistant/`](../slack-ops-assistant/): a starting point for
  self-healing. Failed runs are recorded and posted to Slack, and an agent
  explains them and suggests fixes.
- [**tray-playwright-kit**](https://github.com/JoshNoble8604/tray-playwright-kit):
  Playwright scripts that drive the Tray console for things with no public API,
  such as registering API operations, creating agent tools and renaming steps.
  These rely on the UI and on undocumented endpoints, which can change without
  notice, so treat them as helpers, not a supported interface.
