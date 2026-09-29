// Run: node --test tray/scripts/scripts.test.mjs
//
// Every input here is a payload captured from a real run (fixtures/, redacted),
// passed exactly as the workflow step's Variables pass it. Invented payloads are
// how this bundle's early bugs got past its tests: they encoded what we expected
// Tray and Slack to send rather than what they send. When a connector changes,
// capture a new payload from the Tray log and replace the fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const load = createRequire(import.meta.url);
const step = (name) => load(`./${name}.js`).step;
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url))).payload;

const mention = fixture("slack-events-app-mention"); // $.steps.trigger of Slack - Events
const click = fixture("slack-interactive-ack-click"); // $.steps.trigger of Slack - Button actions
const agentTrigger = fixture("agent-trigger-from-call-workflow"); // $.steps.trigger of Ops - Ask the agent
const listRows = fixture("data-tables-list-rows"); // $.steps.data-tables-1
const bedrock = fixture("bedrock-ai-generation"); // $.steps.aws-bedrock-1
const alert = fixture("alerting-trigger"); // $.steps.trigger of Ops - Record failure (schema-shaped, not captured)

const NOW = "2026-09-28T21:31:00.000Z"; // when the fixtures were captured
const actionIds = (blocks) => blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements.map((e) => e.action_id));

// Slack - Events / script-1: event = $.steps.trigger.event_data, event_type = $.steps.trigger.event_type
test("event-normalise turns a real @mention into an agent question", () => {
  const out = step("event-normalise")({ event: mention.event_data, event_type: mention.event_type });
  assert.deepEqual(out, {
    skip: false,
    question: "what are your capabilities?",
    channel: "C0CHANNEL01",
    thread_ts: "1790631085.226699",
    user: "U0USER00001",
  });
});

test("event-normalise skips the bot's own messages and edits (variants of the real event)", () => {
  const n = step("event-normalise");
  const withEvent = (patch) => ({ event: { ...mention.event_data, event: { ...mention.event_data.event, ...patch } }, event_type: "message" });
  assert.equal(n(withEvent({ type: "message", channel_type: "im", bot_id: "B0BOT000001" })).skip, true);
  assert.equal(n(withEvent({ type: "message", channel_type: "im", subtype: "message_changed" })).skip, true);
  assert.equal(n(withEvent({ type: "message", channel_type: "channel" })).skip, true, "plain channel chatter is ignored");
  assert.equal(n(withEvent({ text: "<@U0BOT000001>" })).skip, true, "a bare mention has no question");
  assert.equal(n(withEvent({ type: "message", channel_type: "im", text: "hi" })).skip, false, "DMs are answered");
});

// Slack - Button actions / script-1: payload = $.steps.trigger
test("action-normalise flattens a real Acknowledge click", () => {
  const a = step("action-normalise")({ payload: click });
  assert.equal(a.action_id, "ops_ack");
  assert.equal(a.channel, "C0CHANNEL01");
  assert.equal(a.message_ts, "1790629343.458959");
  assert.equal(a.thread_ts, "1790629343.458959", "no thread yet, so the reply threads under the message");
  assert.equal(a.user, "U0USER00001");
});

test("action-normalise routes a suffixed ops_ask button by its prefix", () => {
  const button = click.message.blocks.find((b) => b.type === "actions").elements[0]; // ops_ask.fix_first
  const a = step("action-normalise")({ payload: { ...click, actions: [{ ...click.actions[0], action_id: button.action_id, value: button.value }] } });
  assert.equal(a.action_id, "ops_ask", "branch-1 compares against the prefix");
  assert.equal(a.value, button.value, "the button's value becomes the agent's question");
});

// Slack - Button actions / script-2: action = $.steps.script-1.result
test("ack-update rewrites the real clicked message: Acknowledge gone, ask buttons kept, one stamp", () => {
  const a = step("action-normalise")({ payload: click });
  const upd = step("ack-update")({ action: a });
  assert.equal(upd.channel, "C0CHANNEL01");
  assert.equal(upd.ts, "1790629343.458959");
  assert.deepEqual(actionIds(upd.blocks), ["ops_ask.fix_first", "ops_ask.new_errors"]);
  assert.match(upd.blocks.at(-1).elements[0].text, /Acknowledged by <@U0USER00001>/);
  const again = step("ack-update")({ action: { ...a, blocks: upd.blocks } });
  assert.equal(again.blocks.filter((b) => b.block_id === "ops_ack_stamp").length, 1, "re-ack replaces the stamp");
});

// Ops - Ask the agent / script-1: elements = $.steps.data-tables-1.elements, trigger = $.steps.trigger
test("agent-context reads the real call-workflow trigger (flat inputs) and the real ledger", () => {
  const out = step("agent-context")({ elements: listRows.elements, trigger: agentTrigger, now: NOW });
  assert.equal(out.channel, "C0CHANNEL01");
  assert.deepEqual(out.placeholder, { channel: "C0CHANNEL01", thread_ts: "1790629250.516039", text: ":mag: Checking the run ledger..." });
  assert.equal(out.row_count, 5);
  const ledger = JSON.parse(out.prompt.split("<ledger>\n")[1].split("\n</ledger>")[0]);
  assert.equal(ledger[0].workflow, "[SAMPLE] Stripe - Post paid invoices to NetSuite", "newest first");
  assert.match(out.prompt, /<question>\nExplain this failure and suggest a fix\./);
});

test("agent-context also accepts inputs nested under data (a test fire from the Tray UI)", () => {
  const out = step("agent-context")({ elements: [], trigger: { data: agentTrigger }, now: NOW });
  assert.equal(out.channel, "C0CHANNEL01");
});

// Ops - Ask the agent / script-3: answer = $.steps.aws-bedrock-1.chatResponse.output.message.content
test("agent-reply turns the real Bedrock answer into valid Slack mrkdwn", () => {
  const out = step("agent-reply")({ answer: bedrock.chatResponse.output.message.content, channel: "C0CHANNEL01", ts: "1790629405.311499", row_count: 5 });
  const text = out.blocks[0].text.text;
  assert.match(text, /\*Workflow:\* \[SAMPLE\] Stripe/, "**bold** becomes *bold*");
  assert.match(text, /<https:\/\/app\.tray\.io\/\|View step log>/, "Markdown links become Slack links");
  assert.ok(out.blocks.filter((b) => b.type === "section").every((b) => b.text.text.length <= 3000));
  assert.equal(out.ts, "1790629405.311499");
});

test("agent-reply splits an answer longer than Slack's 3000-char section limit", () => {
  const long = [{ text: "para one.\n\n" + "word ".repeat(1500) }];
  const out = step("agent-reply")({ answer: long, channel: "C", ts: "1" });
  const sections = out.blocks.filter((b) => b.type === "section");
  assert.ok(sections.length >= 2 && sections.every((s) => s.text.text.length <= 3000));
});

// Ops - Ask the agent / script-5: failure = $.errors.aws-bedrock-1.message (real error text from the first run)
test("agent-reply renders the Bedrock error path", () => {
  const out = step("agent-reply")({ failure: "The model returned the following errors: `temperature` is deprecated for this model.", channel: "C", ts: "1" });
  assert.match(out.blocks[0].text.text, /couldn't reach the model/);
});

// Ops - Daily report / script-1: elements = $.steps.data-tables-1.elements
test("daily-report summarises the real ledger", () => {
  const out = step("daily-report")({ elements: listRows.elements, now: NOW });
  assert.equal(out.failures, 5);
  assert.deepEqual(out.prune_ids, []);
  assert.match(JSON.stringify(out.message.blocks), /Sync closed-won to NetSuite\* - 2 failures/);
});

test("daily-report prunes rows past retention and reports a quiet day", () => {
  const out = step("daily-report")({ elements: listRows.elements, now: "2026-10-06T09:00:00.000Z" });
  assert.equal(out.failures, 0);
  assert.equal(out.prune_ids.length, 5);
  assert.match(JSON.stringify(out.message.blocks), /No failed runs/);
});

// Ops - Record failure / script-1: origin = $.steps.trigger.origin, error = $.steps.trigger.error
test("record-failure builds a ledger row and alert from the alerting-trigger shape", () => {
  const out = step("record-failure")({ origin: alert.origin, error: alert.error });
  assert.equal(out.row.workflow_title, alert.origin.workflow_title);
  assert.equal(out.row.occurred_at, alert.error.created);
  assert.equal(out.row.step_log_url, alert.origin.step_log_url);
  assert.deepEqual(actionIds(out.message.blocks), ["ops_ask", "ops_ack", "open_log"]);
});

test("record-failure escapes error text for mrkdwn and survives an empty payload", () => {
  const out = step("record-failure")({ origin: alert.origin, error: { message: "bad <tag> & more" } });
  assert.match(JSON.stringify(out.message.blocks), /&lt;tag&gt; &amp; more/);
  assert.equal(step("record-failure")({}).row.workflow_title, "Untitled workflow");
});

// Every message the bundle posts
test("no message repeats an action_id (Slack rejects the whole message with invalid_blocks)", () => {
  const messages = [
    step("record-failure")({ origin: alert.origin, error: alert.error }).message,
    step("daily-report")({ elements: listRows.elements, now: NOW }).message,
    step("agent-reply")({ answer: bedrock.chatResponse.output.message.content, channel: "C", ts: "1" }),
    step("ack-update")({ action: step("action-normalise")({ payload: click }) }),
  ];
  for (const m of messages) {
    const ids = actionIds(m.blocks);
    assert.equal(new Set(ids).size, ids.length, `duplicate action_id: ${ids}`);
  }
});

// After every Slack call: res = $.steps.slack-app-N.body (real error bodies from today's runs)
test("slack-check fails the run on Slack's ok:false bodies", () => {
  const check = step("slack-check");
  assert.throws(() => check({ res: { ok: false, error: "channel_not_found" } }), /channel_not_found/);
  assert.throws(() => check({ res: { ok: false, error: "invalid_blocks", response_metadata: { messages: ["[ERROR] `action_id` \"ops_ask\" already exists"] } } }), /already exists/);
  assert.equal(check({ res: { ok: true, channel: "C0CHANNEL01", ts: "1790629405.311499" } }).ts, "1790629405.311499");
});
