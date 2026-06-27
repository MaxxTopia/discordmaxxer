#!/usr/bin/env bash
# Discordmaxxer CI -> DM Diggy via the Maxxtopia "Maxx" bot.
# Reuses the suite alert path (see memory reference-suite-monitor-and-bot-alerts):
# the bot opens a DM channel with Diggy and posts a message. Used by the Release,
# upstream-watch, and auto-rebump workflows so a human is PINGED when something
# needs attention even if nobody is watching GitHub.
#
# Usage:  MAXX_BOT_TOKEN=<bot token> scripts/notify-maxx.sh "message text"
# Secret: GitHub repo secret MAXX_BOT_TOKEN (the Maxxtopia bot token).
#         Set once: gh secret set MAXX_BOT_TOKEN -R MaxxTopia/discordmaxxer
#
# ALWAYS exits 0 — a broken/disabled alert path must never fail a build. If the
# token isn't set, it no-ops with a log line. ASCII only (Discord curl mangles
# unicode in inline JSON; we build JSON with jq to be safe).
set -uo pipefail

MSG="${1:-${MSG:-}}"
TOKEN="${MAXX_BOT_TOKEN:-}"
USER_ID="${DIGGY_USER_ID:-426146621424664586}"
API="https://discord.com/api/v10"

if [ -z "$TOKEN" ]; then
    echo "[notify-maxx] MAXX_BOT_TOKEN not set; skipping alert (set it: gh secret set MAXX_BOT_TOKEN -R MaxxTopia/discordmaxxer)."
    exit 0
fi
if [ -z "$MSG" ]; then
    echo "[notify-maxx] no message provided; skipping."
    exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
    echo "[notify-maxx] jq not available; skipping (non-fatal)."
    exit 0
fi

# 1) Open (idempotent) the bot<->Diggy DM channel.
CH=$(curl -fsS -X POST "$API/users/@me/channels" \
    -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg r "$USER_ID" '{recipient_id:$r}')" 2>/dev/null | jq -r '.id // empty')

if [ -z "$CH" ]; then
    echo "[notify-maxx] could not open DM channel (token/perm issue?); skipping (non-fatal)."
    exit 0
fi

# 2) Send the message.
if curl -fsS -X POST "$API/channels/$CH/messages" \
    -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$MSG" '{content:$c}')" >/dev/null 2>&1; then
    echo "[notify-maxx] alert sent to Diggy."
else
    echo "[notify-maxx] alert send failed (non-fatal)."
fi
exit 0
