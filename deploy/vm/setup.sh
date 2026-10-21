#!/usr/bin/env bash
# One-command deploy of AI Media Studio on a fresh Ubuntu VM (Oracle Cloud Always Free works).
#
#   git clone https://github.com/shashwat1213/ai-media-studio.git && cd ai-media-studio
#   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bash deploy/vm/setup.sh
#
# Re-running is safe: secrets in .env.prod are created once and kept; the stack is rebuilt/updated.
set -euo pipefail
cd "$(dirname "$0")/../.."

log() { printf '\n== %s\n' "$*"; }

# 1. Docker
if ! command -v docker >/dev/null; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# 2. Open 80/443 in the VM's own firewall (Oracle Ubuntu images ship iptables rules that block them).
if sudo iptables -L INPUT -n 2>/dev/null | grep -q REJECT; then
  log "Opening ports 80/443 in iptables"
  for p in 80 443; do
    sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport $p -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save || true
fi

# 3. Secrets (.env.prod, created once, chmod 600, never committed)
ENVF=.env.prod
rand() { openssl rand -hex "$1"; }
if [ ! -f "$ENVF" ]; then
  log "Creating $ENVF"
  IP=$(curl -fsS https://api.ipify.org)
  : "${CLOUDFLARE_ACCOUNT_ID:?export CLOUDFLARE_ACCOUNT_ID first}"
  : "${CLOUDFLARE_API_TOKEN:?export CLOUDFLARE_API_TOKEN first}"
  umask 077
  cat > "$ENVF" <<EOF
SITE_DOMAIN=${SITE_DOMAIN:-$(echo "$IP" | tr . -).sslip.io}
POSTGRES_USER=studio
POSTGRES_DB=ai_media_studio
POSTGRES_PASSWORD=$(rand 24)
MINIO_ROOT_USER=studio$(rand 4)
MINIO_ROOT_PASSWORD=$(rand 24)
S3_BUCKET=ai-media-assets
JWT_SECRET=$(rand 32)
METRICS_TOKEN=$(rand 24)
AI_PROVIDER=cloudflare
DIRECTOR_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN
SIGNUP_BONUS_CREDITS=30
DEMO_EMAIL=${DEMO_EMAIL:-recruiter@demo.dev}
DEMO_PASSWORD=${DEMO_PASSWORD:-TryTheStudio2026}
DEMO_DAILY_CREDITS=100
EOF
fi
chmod 600 "$ENVF"

COMPOSE="$DOCKER compose -f docker-compose.yml -f deploy/vm/docker-compose.prod.yml --env-file $ENVF"

# 4. Build + start (first build on a small VM takes a few minutes)
log "Building and starting the stack"
$COMPOSE up -d --build --wait --wait-timeout 600

# 5. Demo account now + every day at 00:05 UTC (tops credits back up to the daily cap)
log "Demo account"
$COMPOSE exec -T api node dist/demo-account.js
CRON="5 0 * * * cd $(pwd) && $COMPOSE exec -T api node dist/demo-account.js >> /tmp/ams-demo.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'dist/demo-account.js' ; echo "$CRON" ) | crontab -

DOMAIN=$(grep ^SITE_DOMAIN= "$ENVF" | cut -d= -f2)
log "Done: https://$DOMAIN"
grep -E '^DEMO_(EMAIL|PASSWORD)=' "$ENVF"
