// Slack - Button actions / script-1
// Flattens a block_actions payload so the router branches on one value.
// Slack needs every action_id in a message to be unique, so buttons that share a
// behaviour are suffixed (ops_ask.today, ops_ask.fix_first). The router branches
// on the part before the first dot.
//
// Variables: payload = $.steps.trigger
// Output:    $.steps.script-1.result.action_id -> branch-1; the rest -> the chosen branch

exports.step = function (input) {
  const p = input.payload || {};
  const action = (p.actions || [])[0] || {};
  const container = p.container || {};
  const message = p.message || {};
  return {
    action_id: String(action.action_id || "").split(".")[0],
    value: action.value || "",
    user: (p.user || {}).id || "",
    channel: container.channel_id || (p.channel || {}).id || "",
    message_ts: container.message_ts || message.ts || "",
    // Reply in the message's thread, or start one under the message itself.
    thread_ts: container.thread_ts || message.thread_ts || message.ts || "",
    blocks: message.blocks || [],
  };
};
