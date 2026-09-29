// Slack - Events / script-1
// @mention or DM -> the agent's input, or skip:true for anything it should not answer.
//
// Variables: event = $.steps.trigger.event_data (Slack's event_callback envelope), event_type = $.steps.trigger.event_type
// Output:    $.steps.script-1.result.skip -> boolean-condition-1; the rest -> call-workflow-1

// Optional allowlist. Empty = any channel the bot is in. Restrict when the ledger
// holds anything some Slack members should not see.
const ALLOWED_CHANNELS = [];

exports.step = function (input) {
  const envelope = input.event || {};
  const e = envelope.event || envelope; // the event itself sits inside the envelope
  const type = e.type || input.event_type;
  const skip = (reason) => ({ skip: true, reason });

  // The bot's own messages (and edits, joins, etc.) arrive as events too; answering them loops.
  if (e.bot_id || e.subtype) return skip("bot message or subtype");
  if (type !== "app_mention" && !(type === "message" && e.channel_type === "im")) return skip(`unhandled event ${type}`);
  if (ALLOWED_CHANNELS.length > 0 && !ALLOWED_CHANNELS.includes(e.channel)) return skip("channel not allowed");

  const question = String(e.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!question) return skip("empty message");

  return {
    skip: false,
    question,
    channel: e.channel,
    thread_ts: e.thread_ts || e.ts, // answer in the thread the question came from
    user: e.user,
  };
};
