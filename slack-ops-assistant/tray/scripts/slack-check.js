// script step after every Slack API call.
// Slack answers HTTP 200 with {ok:false, error:"..."} for most failures (bad channel,
// invalid_blocks, not_in_channel), so the step "succeeds" and the message never
// appears. Throwing here turns that into a failed execution the alert workflow sees.
//
// Variables: res = $.steps.slack-app-N.body

exports.step = function (input) {
  const res = input.res || {};
  if (res.ok !== true) throw new Error(`Slack API error: ${res.error || "unknown"}${res.response_metadata ? " " + JSON.stringify(res.response_metadata) : ""}`);
  return { ok: true, ts: res.ts, channel: res.channel };
};
