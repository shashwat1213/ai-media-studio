#!/usr/bin/env bash
# Live check of the full reel path: brief -> Scene Director -> editor draft -> ffmpeg render -> MP4.
#   BASE=https://<app> [EMAIL=.. PASSWORD=.. LOGIN=1] [PROMPT=..] OUT=/tmp/reel.mp4 bash deploy/vercel/render-check.sh
set -euo pipefail
BASE=${BASE:?}; OUT=${OUT:-/tmp/reel.mp4}; JAR=$(mktemp); T=$(mktemp -d); trap 'rm -rf "$JAR" "$T"' EXIT
PROMPT=${PROMPT:-A girl in a yellow raincoat walks through a rainy Mumbai street at night. English voice-over.}
EMAIL=${EMAIL:-render-$(date +%s)-$RANDOM@example.com}; PASSWORD=${PASSWORD:-password-123}
get() { node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));const r=eval(process.argv[1]);console.log(r??"")' "$1"; }
curl -fsS -c "$JAR" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/${LOGIN:+login}${LOGIN:-register}" >/dev/null
node -e 'process.stdout.write(JSON.stringify({prompt:process.argv[1],targetS:12}))' "$PROMPT" > "$T/brief.json"
SID=$(curl -fsS -b "$JAR" -H 'content-type: application/json' --data @"$T/brief.json" "$BASE/api/scenes" | get 'v.scene.id')
t0=$(date +%s)
for i in $(seq 1 120); do curl -fsS -b "$JAR" "$BASE/api/scenes/$SID" > "$T/s.json"; S=$(get 'v.scene.status' < "$T/s.json"); [ "$S" = READY ] || [ "$S" = FAILED ] && break; sleep 3; done
echo "scene: $S in $(( $(date +%s) - t0 )) s  ($(get 'v.scene.title' < "$T/s.json"))"; [ "$S" = READY ]
get 'JSON.stringify(v.scene.draft)' < "$T/s.json" > "$T/draft.json"
t0=$(date +%s)
JOB=$(curl -fsS -b "$JAR" -H 'content-type: application/json' -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" --data @"$T/draft.json" "$BASE/api/edits" | get 'v.job.id')
for i in $(seq 1 150); do curl -fsS -b "$JAR" "$BASE/api/jobs/$JOB" > "$T/j.json"; S=$(get 'v.job.status' < "$T/j.json"); [ "$S" = DONE ] || [ "$S" = FAILED ] && break; sleep 3; done
echo "render: $S in $(( $(date +%s) - t0 )) s  $(get 'v.job.error' < "$T/j.json")"; [ "$S" = DONE ]
curl -fsS --max-time 600 -o "$OUT" "$(get 'v.job.asset.url' < "$T/j.json")"
ffprobe -v error -show_entries stream=codec_name,width,height:format=duration -of compact "$OUT"
# Any (near) black second in the reel?
dark=$(ffmpeg -v error -i "$OUT" -vf "fps=2,scale=64:-1,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null - 2>/dev/null | grep -o 'YAVG=[0-9.]*' | cut -d= -f2 | awk '$1<20' | wc -l)
echo "dark frames (2 fps sample): $dark"
echo "saved $OUT"
