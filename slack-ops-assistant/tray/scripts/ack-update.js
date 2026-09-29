// Slack - Button actions / script-2 (ops_ack branch)
// Replaces the Acknowledge button with a "who acknowledged" line, keeping the other buttons.
//
// Variables: action = $.steps.script-1.result
// Output:    $.steps.script-2.result -> slack-app-1 chat.update body

exports.step = function (input) {
  const a = input.action || {};
  const stamp = `:white_check_mark: Acknowledged by <@${a.user}> <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|just now>`;

  const blocks = [];
  for (const b of a.blocks || []) {
    if (b.type === "context" && b.block_id === "ops_ack_stamp") continue; // re-ack replaces the old stamp
    if (b.type === "actions") {
      const kept = (b.elements || []).filter((el) => el.action_id.split(".")[0] !== "ops_ack");
      if (kept.length > 0) blocks.push({ ...b, elements: kept });
      continue;
    }
    blocks.push(b);
  }
  blocks.push({ type: "context", block_id: "ops_ack_stamp", elements: [{ type: "mrkdwn", text: stamp }] });

  return { channel: a.channel, ts: a.message_ts, text: "Acknowledged", blocks };
};
