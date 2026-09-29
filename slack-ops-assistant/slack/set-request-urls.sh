#!/usr/bin/env bash
# Point the Slack app's Event Subscriptions and Interactivity at the Tray Slack App Trigger.
#
#   SLACK_CONFIG_TOKEN=xoxe.xoxp-... ./set-request-urls.sh <APP_ID> <TRAY_AUTH_ID> [us|eu]
#
# SLACK_CONFIG_TOKEN: api.slack.com/apps -> "Your App Configuration Tokens" -> Generate (lasts 12h).
# APP_ID:             Basic Information in the Slack app (starts with A).
# TRAY_AUTH_ID:       the Slack App authentication's ID in Tray.
# Enable the two "Slack -" workflows first: Slack verifies the events URL on save.
set -euo pipefail
APP_ID=${1:?app id}; AUTH_ID=${2:?tray auth id}; REGION=${3:-us}
: "${SLACK_CONFIG_TOKEN:?set SLACK_CONFIG_TOKEN}"
case $REGION in
  us) HOST=webhooks.tray.io ;;
  eu) HOST=webhooks.eu1.tray.io ;;
  *) echo "region must be us or eu (APAC is not supported by the Slack App Trigger)" >&2; exit 1 ;;
esac
URL="https://$HOST/production/webhooks/slack-app/1/app/$APP_ID/target/$AUTH_ID"
api() { curl -sS -X POST "https://slack.com/api/$1" -H "Authorization: Bearer $SLACK_CONFIG_TOKEN" "${@:2}"; }

MANIFEST=$(api apps.manifest.export -d app_id="$APP_ID" | python3 -c '
import json, sys
r = json.load(sys.stdin)
if not r.get("ok"): sys.exit("export failed: %s" % r.get("error"))
m = r["manifest"]; s = m.setdefault("settings", {})
s.setdefault("event_subscriptions", {"bot_events": ["app_mention", "message.im"]})["request_url"] = sys.argv[1]
s["interactivity"] = {"is_enabled": True, "request_url": sys.argv[1]}
print(json.dumps(m))' "$URL")

api apps.manifest.update --data-urlencode app_id="$APP_ID" --data-urlencode manifest="$MANIFEST" | python3 -c '
import json, sys
r = json.load(sys.stdin)
print("updated" if r.get("ok") else "update failed: %s %s" % (r.get("error"), r.get("errors", "")))
sys.exit(0 if r.get("ok") else 1)'
echo "Both request URLs -> $URL"
