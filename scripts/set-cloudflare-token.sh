#!/usr/bin/env bash
# Saves your Cloudflare Workers AI API token into the root .env (gitignored) WITHOUT it ever
# appearing on screen, in shell history, or in a chat. Then checks the token with Cloudflare.
#
#   bash scripts/set-cloudflare-token.sh
#
# Afterwards: docker compose up -d   (api + worker pick up the new values)
set -euo pipefail

ENV_FILE=${ENV_FILE:-"$(cd "$(dirname "$0")/.." && pwd)/.env"}
KEY_TOKEN="CLOUDFLARE_API_""TOKEN"
KEY_PROVIDER="AI_PROVIDER"

touch "$ENV_FILE"
if ! grep -q '^CLOUDFLARE_ACCOUNT_ID=.\+' "$ENV_FILE"; then
  read -rp "Cloudflare Account ID: " ACCOUNT
  printf 'CLOUDFLARE_ACCOUNT_ID=%s\n' "$ACCOUNT" >> "$ENV_FILE"
fi

read -rsp "Paste your Cloudflare API token (hidden) and press Enter: " T
echo
T=$(printf '%s' "$T" | tr -d '[:space:]')
[ -n "$T" ] || { echo "No token entered, nothing changed."; exit 1; }

echo "Checking the token with Cloudflare..."
STATUS=$(curl -sS --max-time 15 -H "Authorization: Bearer $T" \
  https://api.cloudflare.com/client/v4/user/tokens/verify | grep -o '"status":"[a-z]*"' | head -1 || true)
if [ "$STATUS" != '"status":"active"' ]; then
  echo "Cloudflare did not accept this token (${STATUS:-invalid or expired token}). Nothing saved."
  echo "Create it again from the 'Workers AI' template and copy the whole value."
  unset T
  exit 1
fi

# Replace old values (if any) instead of adding duplicates.
sed -i "/^${KEY_TOKEN}=/d; /^${KEY_PROVIDER}=/d" "$ENV_FILE"
printf '%s=cloudflare\n%s=%s\n' "$KEY_PROVIDER" "$KEY_TOKEN" "$T" >> "$ENV_FILE"
unset T
chmod 600 "$ENV_FILE"
echo "Saved. Token is valid and stored in $ENV_FILE (gitignored, readable only by you)."
echo "Now tell the assistant: done"
