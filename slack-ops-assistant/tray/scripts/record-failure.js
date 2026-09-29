// Ops - Record failure / script-1
// Turns an Alert-trigger payload into (a) one ledger row and (b) a Block Kit alert.
//
// Variables: origin = $.steps.trigger.origin, error = $.steps.trigger.error
// Output:    $.steps.script-1.result.row.<column>   -> data-tables-1 create_row
//            $.steps.script-1.result.message        -> slack-app-1 chat.postMessage body

const CHANNEL = "CHANGE_ME_CHANNEL_ID"; // your channel ID (channel name > About, starts with C), not the name; invite the bot first
const TIMEZONE = "America/New_York";

const esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const clamp = (s, n) => {
  const v = String(s ?? "").trim();
  return v.length <= n ? v : v.slice(0, n - 1) + "…";
};

exports.step = function (input) {
  const origin = input.origin || {};
  const error = input.error || {};
  const occurredAt = error.created || new Date().toISOString();
  const title = origin.workflow_title || "Untitled workflow";
  const step = origin.step_name || "unknown step";
  const message = error.message || "No error message was provided.";
  const when = new Date(occurredAt).toLocaleString("en-US", { timeZone: TIMEZONE, dateStyle: "medium", timeStyle: "short" });

  const row = {
    occurred_at: occurredAt,
    workflow_title: clamp(title, 500),
    workflow_id: origin.workflow_uuid || "",
    step_name: step,
    error_message: clamp(message, 4000),
    step_log_url: origin.step_log_url || "",
    workflow_url: origin.workflow_url || "",
    status: "failed",
  };

  // Button values reach the agent as the question text; Slack caps a value at 2000 chars.
  const question = clamp(
    `Explain this failure and suggest a fix. Workflow "${title}", step "${step}", at ${occurredAt}. Error: ${message}`,
    1900,
  );

  const actions = [
    { type: "button", action_id: "ops_ask", text: { type: "plain_text", text: "Explain this" }, style: "primary", value: question },
    { type: "button", action_id: "ops_ack", text: { type: "plain_text", text: "Acknowledge" }, value: "ack" },
  ];
  // A URL button opens in the browser; Slack still sends a block_action for it, which the router ignores.
  if (row.step_log_url) actions.push({ type: "button", action_id: "open_log", text: { type: "plain_text", text: "Open step log" }, url: row.step_log_url });

  const blocks = [
    { type: "header", text: { type: "plain_text", text: clamp(`:x: ${title}`, 150), emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Step*\n\`${esc(step)}\`` },
        { type: "mrkdwn", text: `*When*\n${esc(when)}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: "```" + clamp(esc(message), 2900) + "```" } },
    { type: "actions", block_id: "ops_alert_actions", elements: actions },
    { type: "context", elements: [{ type: "mrkdwn", text: "Mention me in the thread to ask anything about this or other runs." }] },
  ];

  return {
    row,
    message: { channel: CHANNEL, text: `Workflow failed: ${title} at ${step}`, blocks, unfurl_links: false },
  };
};
