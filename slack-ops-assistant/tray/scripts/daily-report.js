// Ops - Daily report / script-1
// Summarises the last 24h of the ledger as Block Kit, and lists rows old enough to prune.
//
// Variables: elements = $.steps.data-tables-1.elements, now = (optional ISO, for tests)
// Output:    $.steps.script-1.result.message    -> slack-app-1 chat.postMessage body
//            $.steps.script-1.result.prune_ids  -> loop-1 -> data-tables-2 delete_row

const CHANNEL = "CHANGE_ME_CHANNEL_ID"; // your channel ID (channel name > About, starts with C), not the name; invite the bot first
const TIMEZONE = "America/New_York";
const WINDOW_HOURS = 24;
const RETAIN_DAYS = 7; // Limit: the ledger is read with one list_rows page, so it is kept small. Move it to a database if you exceed a few hundred failures a week.

const esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const clamp = (s, n) => {
  const v = String(s ?? "").trim();
  return v.length <= n ? v : v.slice(0, n - 1) + "…";
};

// Column IDs of the workflow_run_events data table. IDs, not names, so renaming a
// column in the Tray UI does not break the workflows. They change when the project
// is imported into another workspace; copy the new ones from the table's settings.
const COLUMNS = {
  occurred_at: "YNKY8L-VX285X",
  workflow_title: "NGR4XN-5VJJA6",
  workflow_id: "OK8RBE-QG5P3W",
  step_name: "WWKENW-GDR63P",
  error_message: "W8LNWK-GXAR2B",
  step_log_url: "OEXK3L-GJRP5P",
  workflow_url: "KRN2AB-QKA4Z5",
  status: "PO4OZE-2WEQGL",
};
const COLUMN_NAMES = ["Column 1", "Column 2", "Column 3", "Column 4", "Column 5", "Column 6", "Column 7", "Column 8"];

/** list_rows elements -> [{id, occurred_at, ...}], newest first, unparseable dates dropped. */
function readLedger(elements) {
  const fields = Object.keys(COLUMNS);
  return (elements || [])
    .map((el) => {
      const p = el.properties || {};
      const row = { id: String(el.id) };
      // Keyed by column ID when list_rows has key_response_by_id; fall back to the default names.
      fields.forEach((f, i) => { row[f] = p[COLUMNS[f]] ?? p[f] ?? p[COLUMN_NAMES[i]] ?? ""; });
      row.time = Date.parse(row.occurred_at);
      return row;
    })
    .filter((r) => !Number.isNaN(r.time))
    .sort((a, b) => b.time - a.time);
}

exports.step = function (input) {
  const now = input.now ? Date.parse(input.now) : Date.now();
  const rows = readLedger(input.elements);
  const recent = rows.filter((r) => now - r.time <= WINDOW_HOURS * 3600e3);
  const pruneIds = rows.filter((r) => now - r.time > RETAIN_DAYS * 86400e3).map((r) => r.id);

  const byWorkflow = new Map();
  for (const r of recent) {
    const key = r.workflow_title || r.workflow_id;
    const agg = byWorkflow.get(key) || { title: key, count: 0, latest: r };
    agg.count += 1;
    byWorkflow.set(key, agg);
  }
  const top = [...byWorkflow.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  const day = new Date(now).toLocaleDateString("en-US", { timeZone: TIMEZONE, weekday: "long", month: "short", day: "numeric" });

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `Workflow health - ${day}`, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Failures (last ${WINDOW_HOURS}h)*\n${recent.length}` },
        { type: "mrkdwn", text: `*Workflows affected*\n${byWorkflow.size}` },
      ],
    },
  ];

  if (top.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: ":white_check_mark: No failed runs recorded. Quiet day." } });
  } else {
    blocks.push({ type: "divider" });
    for (const w of top) {
      const link = w.latest.step_log_url ? ` <${w.latest.step_log_url}|latest log>` : "";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${esc(clamp(w.title, 200))}* - ${w.count} failure${w.count === 1 ? "" : "s"}${link}\n>${esc(clamp(w.latest.error_message, 280))}`,
        },
      });
    }
  }

  blocks.push({
    type: "actions",
    block_id: "ops_report_actions",
    elements: [
      { type: "button", action_id: "ops_ask.fix_first", style: "primary", text: { type: "plain_text", text: "What should we fix first?" }, value: `Looking at the last ${WINDOW_HOURS} hours of failures, what should we fix first and why?` },
      { type: "button", action_id: "ops_ask.new_errors", text: { type: "plain_text", text: "Any new errors?" }, value: `Which errors in the last ${WINDOW_HOURS} hours are new compared with the rest of the week?` },
      { type: "button", action_id: "ops_ack", text: { type: "plain_text", text: "Acknowledge" }, value: "ack" },
    ],
  });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Mention me in the thread to ask a question about these runs." }] });

  return {
    message: { channel: CHANNEL, text: `Workflow health: ${recent.length} failure(s) in the last ${WINDOW_HOURS}h`, blocks, unfurl_links: false },
    prune_ids: pruneIds,
    failures: recent.length,
  };
};
