#!/usr/bin/env bash
# Smoke test for the full Docker stack. Used by CI (and runnable locally):
#   docker compose up -d --build && ./scripts/smoke.sh
# Exercises the real path: browser-facing nginx -> api -> postgres/redis -> worker -> minio.
set -euo pipefail

BASE=${BASE:-http://localhost:8080}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

fail() { echo "✖ $*"; docker compose ps -a; docker compose logs --tail=50 api worker web migrate || true; exit 1; }

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

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

# Image generation is only smoke-tested in the free stub mode (CI). With a real provider
# configured locally, we skip it rather than spend the daily quota on a smoke test.
MODE=$(curl -fsS "$BASE/api/generate/models" | json 'v.mode')
if [ "$MODE" != stub ]; then
  echo "▶ generate: SKIPPED (AI_PROVIDER=$MODE, not spending real quota)"
  EXPECTED=50
else
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

EXPECTED=48
fi

echo "▶ editor: upload a screenshot (presigned POST straight to storage) and verify it"
docker compose exec -T api ffmpeg -loglevel error -f lavfi -i "smptebars=size=800x450" -frames:v 1 -f image2pipe -vcodec png - > /tmp/smoke-shot.png \
  || fail "could not make a test PNG"
BYTES=$(wc -c < /tmp/smoke-shot.png | tr -d ' ')
CREATED=$(curl -fsS -b "$JAR" -H 'Content-Type: application/json' \
  -d "{\"fileName\":\"shot.png\",\"mimeType\":\"image/png\",\"bytes\":$BYTES}" "$BASE/api/uploads") || fail "create upload failed"
UP_ID=$(echo "$CREATED" | json 'v.upload.id')
POST_URL=$(echo "$CREATED" | json 'v.post.url')
FORM=()
while IFS= read -r kv; do FORM+=(-F "$kv"); done < <(echo "$CREATED" | json 'Object.entries(v.post.fields).map(([k,x])=>k+"="+x).join("\n")')
curl -fsS "${FORM[@]}" -F "file=@/tmp/smoke-shot.png;type=image/png" "$POST_URL" || fail "upload to storage failed"
READY=$(curl -fsS -b "$JAR" -X POST "$BASE/api/uploads/$UP_ID/complete" | json 'v.upload.status+" "+v.upload.width+"x"+v.upload.height')
[ "$READY" = "READY 800x450" ] || fail "upload not verified: $READY"
echo "  $READY"

echo "▶ editor: render screenshot + caption to MP4 (worker ffmpeg)"
EDIT=$(curl -fsS -b "$JAR" -H 'Content-Type: application/json' \
  -d "{\"clips\":[{\"uploadId\":\"$UP_ID\",\"durationS\":2}],\"texts\":[{\"text\":\"Smoke test: 100% ok\",\"startS\":0,\"endS\":2}]}" \
  "$BASE/api/edits" | json 'v.job.id') || fail "edit failed"
for i in $(seq 1 60); do
  STATUS=$(curl -fsS -b "$JAR" "$BASE/api/jobs/$EDIT" | json 'v.job.status')
  [ "$STATUS" = DONE ] && break
  [ "$STATUS" = FAILED ] && fail "edit FAILED: $(curl -fsS -b "$JAR" "$BASE/api/jobs/$EDIT" | json 'v.job.error')"
  [ "$i" = 60 ] && fail "edit stuck in $STATUS"
  sleep 1
done
URL=$(curl -fsS -b "$JAR" "$BASE/api/jobs/$EDIT" | json 'v.job.asset.url')
curl -fsS "$URL" -o /tmp/smoke.mp4
[ "$(head -c 8 /tmp/smoke.mp4 | tail -c 4)" = ftyp ] || fail "not an MP4"
echo "  DONE ($(wc -c < /tmp/smoke.mp4 | tr -d ' ') bytes)"
EXPECTED=$((EXPECTED - 1))

echo "▶ credits: $EXPECTED"
BAL=$(curl -fsS -b "$JAR" "$BASE/api/credits" | json 'v.balance')
[ "$BAL" = "$EXPECTED" ] || fail "expected balance $EXPECTED, got $BAL"

echo "▶ containers run as non-root"
for s in api worker web; do
  U=$(docker compose exec -T "$s" id -u)
  [ "$U" != 0 ] || fail "$s runs as root"
  echo "  $s uid=$U"
done

echo "✔ smoke test passed"
