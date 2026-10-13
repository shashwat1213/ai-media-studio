#!/usr/bin/env bash
# Smoke test for the full Docker stack. Used by CI (and runnable locally):
#   docker compose up -d --build && ./scripts/smoke.sh
# Exercises the real path: browser-facing nginx -> api -> postgres/redis -> worker -> minio.
#
# Also used against the live AWS deployment by the Deploy workflow:
#   BASE=https://<id>.cloudfront.net REMOTE=1 ./scripts/smoke.sh
# REMOTE=1 skips the docker-only checks. If the deployment runs the PAID provider (openrouter),
# the generate step is skipped so a deploy never spends money.
set -euo pipefail

BASE=${BASE:-http://localhost:8080}
REMOTE=${REMOTE:-0}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

fail() {
  echo "✖ $*"
  if [ "$REMOTE" != 1 ]; then docker compose ps -a; docker compose logs --tail=50 api worker web migrate || true; fi
  exit 1
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v[k];console.log(v)})' "$1"; }

echo "▶ waiting for the stack (web -> api health)"
for i in $(seq 1 60); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "stack never became healthy"
  sleep 2
done
curl -fsS "$BASE/api/health"; echo

echo "▶ SPA deep link served by nginx"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/gallery")" = 200 ] || fail "SPA fallback broken"

echo "▶ register"
EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
curl -fsS -c "$JAR" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-123\"}" "$BASE/api/auth/register" >/dev/null || fail "register failed"

MODE=$(curl -fsS -b "$JAR" "$BASE/api/generate/models" | json mode) || fail "models endpoint failed"
if [ "$MODE" != stub ]; then
  echo "▶ provider is '$MODE' (paid): skipping the generate step"
  echo "✔ smoke test passed (auth + API; generation skipped)"
  exit 0
fi

echo "▶ generate"
JOB=$(curl -fsS -b "$JAR" -H 'Content-Type: application/json' \
  -d '{"prompt":"smoke test sunrise","model":"recraft/recraft-v4.1-flash","aspectRatio":"1:1"}' \
  "$BASE/api/generate" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).job.id))') || fail "generate failed"
echo "  job $JOB"

echo "▶ wait for the worker"
for i in $(seq 1 60); do
  STATUS=$(curl -fsS -b "$JAR" "$BASE/api/jobs/$JOB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).job.status))')
  [ "$STATUS" = DONE ] && break
  [ "$STATUS" = FAILED ] && fail "job FAILED"
  [ "$i" = 60 ] && fail "job stuck in $STATUS"
  sleep 1
done
echo "  DONE"

echo "▶ download the image through its presigned URL"
URL=$(curl -fsS -b "$JAR" "$BASE/api/jobs/$JOB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).job.asset.url))')
curl -fsS "$URL" -o /tmp/smoke.png
head -c 8 /tmp/smoke.png | od -An -tx1 | tr -d ' \n' | grep -q '^89504e470d0a1a0a' || fail "not a PNG"

echo "▶ credits: 50 - 2 = 48"
BAL=$(curl -fsS -b "$JAR" "$BASE/api/credits" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).balance))')
[ "$BAL" = 48 ] || fail "expected balance 48, got $BAL"

if [ "$REMOTE" = 1 ]; then echo "✔ smoke test passed"; exit 0; fi

echo "▶ containers run as non-root"
for s in api worker web; do
  U=$(docker compose exec -T "$s" id -u)
  [ "$U" != 0 ] || fail "$s runs as root"
  echo "  $s uid=$U"
done

echo "✔ smoke test passed"
