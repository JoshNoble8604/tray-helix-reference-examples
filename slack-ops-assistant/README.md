# Slack Ops Assistant (Tray reference)

A two-way Slack bot, built from plain Tray workflows with **no Merlin Agent Builder**:

- **Alerts:** every failed run of a watched workflow posts a Block Kit alert with buttons.
- **Daily report:** a Block Kit health report every morning.
- **Q&A:** people @mention the bot, DM it or click a button, and it answers
  questions about recent runs. It uses Claude on AWS Bedrock, called directly
  from a workflow step.

It runs on **your own Slack app** (your bot name, icon and scopes), via Tray's
Slack App connector and Slack App Trigger.

```
 watched workflow fails
        │  (Alerting workflow setting)
        ▼
 Ops - Record failure ──► workflow_run_events (data table) ◄── Ops - Daily report (08:00)
        │                          ▲                                   │
        ▼                          │ reads recent rows                 ▼
   Block Kit alert           Ops - Ask the agent ──► Bedrock      Block Kit report
   [Explain] [Ack] [Log]           ▲    (callable, async)
        │                          │
        │ button click             │ question
        ▼                          │
 Slack - Button actions ───────────┤
 Slack - Events (@mention, DM) ────┘
```

## Why it is shaped this way

- **A run ledger, not the logs API.** Tray's execution-log endpoints are built
  for the Tray UI's own session. A bot can't depend on them. Instead, each
  watched workflow names *Ops - Record failure* as its **Alerting workflow**.
  Tray calls it with the workflow, step, error and step-log URL whenever a run
  fails, and it appends one row to a data table. The agent answers from that
  table. It is supported, needs no extra credentials, and costs one step per failure.
- **One model call per question, not a tool loop.** The recent ledger rows fit
  in the prompt, so the agent reads them and asks once. That is simpler to
  operate and debug, and it answers in about 10 seconds. Switch to tool use when
  the data no longer fits in a prompt.
- **Slack talks to Tray, never to your app directly.** The Slack App Trigger
  receives events and clicks, and verifies Slack's signature using the app's
  signing secret. If you also run a Helix app, keep it behind SSO. Helix calls
  Tray; Slack does not call Helix.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| Ops - Record failure | Alert | Writes a ledger row and posts an alert with **Explain this** (`ops_ask`), **Acknowledge** (`ops_ack`) and **Open step log** (URL) buttons |
| Ops - Daily report | Scheduled, daily 08:00 America/New_York | Posts 24h failure totals, top offenders with their latest error and log link, and ask buttons. Then deletes ledger rows older than 7 days |
| Ops - Ask the agent | Callable (async) | Posts "Checking the run ledger…" in the thread, calls Bedrock, then replaces that message with the answer and follow-up buttons. If the model call fails, it replaces it with the error instead |
| Slack - Events | Slack App Trigger, events | Handles @mentions and DMs. Ignores bot messages, edits and empty mentions, then calls the agent |
| Slack - Button actions | Slack App Trigger, interactive | Routes on `action_id`: `ops_ask` asks the button's value as a question, `ops_ack` stamps who acknowledged the message. Anything else does nothing |

Every Slack API call is followed by a check step. Slack returns HTTP 200 with
`{"ok": false}` for most errors, such as a wrong channel or invalid blocks.
Without the check, the step would succeed and the message would silently never
appear.

## Setup

### 0. Import the Tray project

Import `tray/project-export.json` into a project in your workspace. It creates
the five workflows, with the calls between them already pointing at each other.
The export has no credentials in it: the Slack App and AWS Bedrock steps show as
needing an authentication, and you attach your own in steps 1 and 2.

**Check for the `workflow_run_events` data table.** In a test import the
workflows arrived but the table did not. If it's missing, create it in the same
project with 8 text columns: occurred_at, workflow_title, workflow_id, step_name,
error_message, step_log_url, workflow_url, status. Then point the data table
steps at it and copy its column IDs into the scripts (both in step 4). The
workflows read and write columns by ID, not by name.

### 1. Slack app

1. At api.slack.com/apps, choose **Create New App → From manifest** and paste
   `slack/app-manifest.json`.
2. Install it to your workspace.
3. Create the ops channel and `/invite @Ops Assistant`. Copy the **channel ID**
   (channel name → About → bottom of the panel, starts with `C`). Post by ID:
   a name only works for public channels, and not at all for private ones.

### 2. Tray authentications

- **Slack App** auth needs three values:
  - **Bot/User Token**: the Bot User OAuth Token (`xoxb-…`), under OAuth & Permissions.
  - **App ID**: on Basic Information.
  - **Signing Secret**: on Basic Information.
- **AWS Bedrock** auth, in a region where your Claude model or inference
  profile is enabled.

### 3. Point Slack at Tray

Put the same URL in both **Event Subscriptions → Request URL** and
**Interactivity & Shortcuts → Request URL**:

```
US  https://webhooks.tray.io/production/webhooks/slack-app/1/app/{APP_ID}/target/{TRAY_AUTH_ID}
EU  https://webhooks.eu1.tray.io/production/webhooks/slack-app/1/app/{APP_ID}/target/{TRAY_AUTH_ID}
```

Or set both from the command line with the Slack App Manifest API. Generate an
App Configuration Token at api.slack.com/apps (it lasts 12 hours), then run:

```
SLACK_CONFIG_TOKEN=xoxe.xoxp-... ./slack/set-request-urls.sh <APP_ID> <TRAY_AUTH_ID> [us|eu]
```

APAC is not supported by the Slack App Trigger; use a webhook trigger there.
Enable the two *Slack -* workflows **before** saving in Slack. Slack verifies
the URL immediately, and only a live trigger can answer.

### 4. Values to set after importing

| Where | Value |
|---|---|
| `Ops - Record failure` script-1, `Ops - Daily report` script-1 | `CHANNEL`: your channel ID |
| Both of those scripts, `TIMEZONE` | Display timezone (the report's schedule is set on its trigger) |
| `Ops - Daily report` script-1 and `Ops - Ask the agent` script-1, `COLUMNS` | The ledger's column IDs. They change on import; find them in the data table's settings. Records are keyed by ID so that renaming a column doesn't break anything |
| `Ops - Record failure` data-tables-1 | The same column IDs as each property key |
| The **Data table** field on `Ops - Record failure` data-tables-1, `Ops - Daily report` data-tables-1 and data-tables-2, and `Ops - Ask the agent` data-tables-1 | Your `workflow_run_events` table. The export still references the original table's ID |
| `Ops - Ask the agent` aws-bedrock-1 | Model ID, for example `us.anthropic.claude-sonnet-5`. **Don't set Temperature**: current Claude models reject it with "temperature is deprecated for this model" |
| `Slack - Events` script-1 | Optional `ALLOWED_CHANNELS` |

### 5. Watch your workflows

On each workflow you want covered, open **Workflow settings → Alerting
workflow** and choose *Ops - Record failure*. Don't set it on *Ops - Record
failure* itself.

## Adding buttons

Buttons are plain Block Kit elements built in the script steps:

- **To ask the agent a canned question,** add a button whose `action_id` starts
  with `ops_ask.` and whose `value` is the question (up to 2000 characters):
  ```js
  { type: "button", action_id: "ops_ask.last_week", text: { type: "plain_text", text: "Last week?" },
    value: "Summarise last week's failures by workflow." }
  ```
  Slack rejects a message if two elements share an `action_id`, so each button
  gets its own suffix. The router branches on the part before the first dot.
- **For a new behaviour** (open a ticket, rerun something, page someone), pick a
  new prefix such as `ops_ticket.*`. Then add a branch with that value in
  *Slack - Button actions* and put your steps in it. In the builder that's all
  you need. If you edit the workflow structure through the API, note that
  Tray keys branch paths by position (`branch1`, `branch2`, … and
  `__default__`), not by the branch value. `script-1` there has
  already flattened the click into `action_id`, `value`, `user`, `channel`,
  `message_ts`, `thread_ts` and `blocks`.
- **To update the message that was clicked,** follow the `ops_ack` branch.
  Rebuild the blocks from `script-1.result.blocks`, then call `chat.update`
  with the channel and `message_ts`.

## Limits and when to change them

- The ledger only records **failures** that reach the Alerting workflow.
  Successful runs and step inputs and outputs are not in it, and the agent says
  so rather than guessing.
- The ledger is read with a single `list_rows` page of 200 rows. The daily
  report keeps 7 days of rows (`RETAIN_DAYS`). If you exceed a few hundred
  failures a week, move the ledger to a database and query it by time.
- The agent sees the newest 60 rows (`MAX_ROWS`) from the last 7 days.

## Security notes

- Error text in the ledger comes from third-party APIs. It is fenced as data in
  the prompt, and the system prompt tells the model never to follow
  instructions found inside it.
- The agent only reads. It has no tools and can't change anything.
- Anyone who can reach the bot can ask about any recorded failure. Restrict it
  with `ALLOWED_CHANNELS`, or keep sensitive workflows off the Alerting workflow.

## Scripts and tests

`tray/scripts/*.js` are exactly what is pasted into each script step, and each
file names its workflow and step. Run the checks with:

```
node --test tray/scripts/scripts.test.mjs
```

The tests feed each script the payloads Tray and Slack actually sent, captured
from real runs and redacted (`tray/scripts/fixtures/`). They pass them in
exactly as the step's Variables do. Two shapes surprise people:

- The Slack event is inside an envelope, at `event_data.event`.
- A callable workflow started by `call-workflow` gets its inputs **flat** on
  `$.steps.trigger`, not under `data`.

`alerting-trigger.json` is the exception: it's shaped from the connector
schema, because no real alert had fired when the bundle was built. Replace it
with a captured one from your first real failure.

**What the tests can't catch** is configuration that lives in Tray or Slack.
After import, check it once, live:

1. Post the alert with a test fire of *Ops - Record failure*. This catches a
   wrong channel ID or a bot missing from the channel (`channel_not_found`).
2. Click **Acknowledge**. The button should be replaced by the stamp. This
   catches missing Interactivity URLs and a misrouted *Slack - Button actions*
   branch.
3. Click **Explain this**, and @mention the bot. An answer should appear in the
   thread. This catches missing Events URLs, and a Bedrock model ID or
   parameter the model rejects.
