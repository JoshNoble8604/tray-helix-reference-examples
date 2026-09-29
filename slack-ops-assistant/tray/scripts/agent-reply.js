// Ops - Ask the agent / script-3 (success path) and script-5 (Bedrock error path)
// Replaces the placeholder with the answer (or the error) as Block Kit.
//
// Variables: answer = $.steps.aws-bedrock-1.chatResponse.output.message.content (script-3)
//            failure = $.errors.aws-bedrock-1.message (script-5)
//            channel = $.steps.script-1.result.channel, ts = $.steps.script-2.result.ts, row_count = $.steps.script-1.result.row_count
// Output:    $.steps.script-N.result -> slack-app-N chat.update body

const clamp = (s, n) => {
  const v = String(s ?? "").trim();
  return v.length <= n ? v : v.slice(0, n - 1) + "…";
};

/** Claude writes Markdown; Slack mrkdwn differs for bold, headings and links. */
function toMrkdwn(md) {
  return String(md)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>");
}

/** Slack caps a section at 3000 chars; split on paragraph breaks where possible. */
function sections(text) {
  const out = [];
  let rest = text;
  while (rest.length > 0 && out.length < 45) {
    let cut = rest.length <= 2900 ? rest.length : rest.lastIndexOf("\n\n", 2900);
    if (cut <= 0) cut = 2900;
    out.push({ type: "section", text: { type: "mrkdwn", text: rest.slice(0, cut) } });
    rest = rest.slice(cut).trimStart();
  }
  return out;
}

exports.step = function (input) {
  const failed = input.failure !== undefined && input.failure !== null;
  const parts = Array.isArray(input.answer) ? input.answer : [];
  const answer = parts.map((p) => p && p.text).filter(Boolean).join("\n").trim();

  const body = failed
    ? `:warning: I couldn't reach the model to answer that.\n\`${clamp(input.failure, 500)}\``
    : toMrkdwn(answer || "I didn't get an answer back. Try rephrasing the question.");

  const blocks = [
    ...sections(body),
    {
      type: "actions",
      block_id: "ops_answer_actions",
      elements: [
        { type: "button", action_id: "ops_ask.today", text: { type: "plain_text", text: "What failed today?" }, value: "Which workflows failed in the last 24 hours, and what went wrong in each?" },
        { type: "button", action_id: "ops_ask.unreliable", text: { type: "plain_text", text: "Most unreliable workflow?" }, value: "Which workflow has failed most often this week, and is there a common cause?" },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: failed ? "Model call failed" : `Answered from ${input.row_count ?? 0} ledger row(s). Check important details in the step log.` }] },
  ];

  return { channel: input.channel, ts: input.ts, text: clamp(failed ? "Couldn't answer" : answer || "No answer", 300), blocks };
};
