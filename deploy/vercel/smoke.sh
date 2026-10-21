#!/usr/bin/env bash
# Smoke test against a running deployment (real AI, spends a little free quota):
#   BASE=https://<app> bash deploy/vercel/smoke.sh
# register -> image job -> presigned download -> upload (presigned PUT) -> Scene Director READY
set -uo pipefail
BASE=${BASE:?}; JAR=$(mktemp); TMP=$(mktemp -d); trap 'rm -rf "$JAR" "$TMP"' EXIT
pass=0; fail=0
ok() { echo "  PASS $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }
jq_() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{v={}};const r=eval(process.argv[1]);console.log(r===undefined||r===null?"":r)})' "$1"; }

echo "== $BASE"
H=$(curl -s "$BASE/api/health"); echo "  health: $H"; [ "$(echo "$H" | jq_ 'v.db')" = up ] && ok health || bad health
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/gallery")" = 200 ] && ok "SPA deep link" || bad "SPA deep link"

EMAIL=${EMAIL:-smoke-$(date +%s)-$RANDOM@example.com}; PASSWORD=${PASSWORD:-password-123}
if [ -n "${LOGIN:-}" ]; then R=$(curl -s -c "$JAR" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/login")
else R=$(curl -s -c "$JAR" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/register"); fi
C0=$(echo "$R" | jq_ 'v.user?.credits'); [ -n "$C0" ] && ok "auth ($EMAIL, $C0 credits)" || { bad "auth: $R"; exit 1; }

MODEL=$(curl -s "$BASE/api/generate/models" | jq_ 'v.models[0].id')
JOB=$(curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"prompt\":\"a cozy tea stall in the rain at dusk, cinematic\",\"model\":\"$MODEL\",\"aspectRatio\":\"1:1\"}" "$BASE/api/generate" | jq_ 'v.job?.id')
t0=$(date +%s); S=
for i in $(seq 1 60); do S=$(curl -s -b "$JAR" "$BASE/api/jobs/$JOB" | jq_ 'v.job?.status'); [ "$S" = DONE ] || [ "$S" = FAILED ] && break; sleep 2; done
[ "$S" = DONE ] && ok "image job DONE in $(( $(date +%s) - t0 )) s" || bad "image job $S: $(curl -s -b "$JAR" "$BASE/api/jobs/$JOB" | jq_ 'v.job?.error')"
URL=$(curl -s -b "$JAR" "$BASE/api/jobs/$JOB" | jq_ 'v.job?.asset?.url')
if [ -n "$URL" ]; then curl -s -o "$TMP/img" "$URL"; file -b "$TMP/img" | grep -q -E 'JPEG|PNG' && ok "image download ($(file -b "$TMP/img" | cut -c1-30))" || bad "image download"; fi

# Upload a real PNG the way the browser does.
ffmpeg -loglevel error -f lavfi -i 'smptebars=size=900x1400' -frames:v 1 "$TMP/s.png" 2>/dev/null || cp "$TMP/img" "$TMP/s.png"
BYTES=$(stat -c %s "$TMP/s.png")
U=$(curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"fileName\":\"shot.png\",\"mimeType\":\"image/png\",\"bytes\":$BYTES}" "$BASE/api/uploads")
UID_=$(echo "$U" | jq_ 'v.upload?.id'); PURL=$(echo "$U" | jq_ 'v.post?.url'); METHOD=$(echo "$U" | jq_ 'v.post?.method || "POST"')
if [ "$METHOD" = PUT ]; then
  HDRS=$(echo "$U" | jq_ 'Object.entries(v.post.headers||{}).map(([k,x])=>"-H\n"+k+": "+x).join("\n")')
  mapfile -t HA <<< "$HDRS"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${HA[@]}" --data-binary "@$TMP/s.png" "$PURL")
else
  mapfile -t FA < <(echo "$U" | jq_ 'Object.entries(v.post.fields).map(([k,x])=>"-F\n"+k+"="+x).join("\n")')
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "${FA[@]}" -F "file=@$TMP/s.png;type=image/png" "$PURL")
fi
[[ "$CODE" =~ ^20 ]] && ok "upload to storage ($METHOD $CODE)" || bad "upload to storage ($METHOD $CODE)"
DONE=$(curl -s -b "$JAR" -X POST "$BASE/api/uploads/$UID_/complete")
[ "$(echo "$DONE" | jq_ 'v.upload?.status')" = READY ] && ok "upload READY ($(echo "$DONE" | jq_ 'v.upload.width+"x"+v.upload.height'))" || bad "upload complete: $DONE"

# Scene Director (cloud LLM + pictures + voice + captions)
SC=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"prompt":"A chai seller opens his stall on a rainy Mumbai morning. English voice-over.","targetS":12}' "$BASE/api/scenes")
SID=$(echo "$SC" | jq_ 'v.scene?.id'); [ -n "$SID" ] || bad "scene create: $SC"
t0=$(date +%s); S=
for i in $(seq 1 100); do R=$(curl -s -b "$JAR" "$BASE/api/scenes/$SID"); S=$(echo "$R" | jq_ 'v.scene?.status'); [ "$S" = READY ] || [ "$S" = FAILED ] && break; sleep 3; done
[ "$S" = READY ] && ok "scene READY in $(( $(date +%s) - t0 )) s: \"$(echo "$R" | jq_ 'v.scene.title')\", $(echo "$R" | jq_ '(v.scene.script?.shots||[]).length') shots" || bad "scene $S: $(echo "$R" | jq_ 'v.scene?.error')"

C1=$(curl -s -b "$JAR" "$BASE/api/auth/me" | jq_ 'v.user?.credits'); echo "  credits: $C0 -> $C1"
echo "== $pass passed, $fail failed"
[ "$fail" = 0 ]
