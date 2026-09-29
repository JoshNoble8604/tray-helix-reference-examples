// Ops - Ask the agent / script-1
// Builds the model prompt from the question plus recent ledger rows, and the
// "checking..." placeholder the agent later replaces with its answer.
//
// Variables: elements = $.steps.data-tables-1.elements, trigger = $.steps.trigger
// Output:    $.steps.script-1.result.prompt       -> aws-bedrock-1 user message
//            $.steps.script-1.result.placeholder  -> slack-app-1 chat.postMessage body

const MAX_ROWS = 60;      // most recent rows the model sees
const LOOKBACK_DAYS = 7;

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
  // A call-workflow step delivers its inputs flat on the trigger; a test fire from
  // the Tray UI nests them under `data`. Accept both.
  const t = (input.trigger && input.trigger.data) || input.trigger || {};
  const now = input.now ? Date.parse(input.now) : Date.now();
  const rows = readLedger(input.elements)
    .filter((r) => now - r.time <= LOOKBACK_DAYS * 86400e3)
    .slice(0, MAX_ROWS)
    .map(({ occurred_at, workflow_title, step_name, error_message, step_log_url }) => ({
      occurred_at, workflow: workflow_title, step: step_name, error: String(error_message).slice(0, 600), log: step_log_url,
    }));

  const question = String(t.question || "").trim() || "Summarise what has been failing recently.";

  // The ledger holds error text written by third-party APIs, so it is fenced as
  // data. The system prompt tells the model never to follow instructions found inside it.
  const prompt = [
    `Current time (UTC): ${new Date(now).toISOString()}`,
    `Ledger rows (${rows.length}, newest first, last ${LOOKBACK_DAYS} days):`,
    "<ledger>",
    JSON.stringify(rows),
    "</ledger>",
    "",
    `Question from <@${t.user || "unknown"}>:`,
    "<question>",
    question.slice(0, 2000),
    "</question>",
  ].join("\n");

  return {
    prompt,
    row_count: rows.length,
    channel: t.channel,
    placeholder: {
      channel: t.channel,
      thread_ts: t.thread_ts || undefined,
      text: ":mag: Checking the run ledger...",
    },
  };
};
