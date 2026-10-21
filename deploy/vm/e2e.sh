#!/usr/bin/env bash
# End-to-end check of a deployed AI Media Studio (real AI, spends a little free quota):
#   BASE=https://<domain> EMAIL=... PASSWORD=... bash deploy/vm/e2e.sh
# login -> image (Cloudflare FLUX) -> download via presigned URL -> Scene Director (cloud LLM + pictures) -> READY
set -euo pipefail
BASE=${BASE:?}; JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

curl -fsS -c "$JAR" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/login" | j 'v.user.email+" credits="+v.user.credits'

MODEL=$(curl -fsS "$BASE/api/generate/models" | j 'v.models[0].id')
JOB=$(curl -fsS -b "$JAR" -H 'content-type: application/json' -d "{\"prompt\":\"a cozy tea stall in the rain at dusk, cinematic\",\"model\":\"$MODEL\",\"aspectRatio\":\"1:1\"}" "$BASE/api/generate" | j 'v.job.id')
t0=$(date +%s)
for i in $(seq 1 90); do S=$(curl -fsS -b "$JAR" "$BASE/api/jobs/$JOB" | j 'v.job.status'); [ "$S" = DONE ] || [ "$S" = FAILED ] && break; sleep 2; done
echo "image job: $S in $(( $(date +%s) - t0 )) s"; [ "$S" = DONE ]
URL=$(curl -fsS -b "$JAR" "$BASE/api/jobs/$JOB" | j 'v.job.asset.url')
curl -fsS "$URL" -o /tmp/e2e-image.bin && echo "image download: $(file -b /tmp/e2e-image.bin | cut -c1-40)"

SC=$(curl -fsS -b "$JAR" -H 'content-type: application/json' -d '{"prompt":"A chai seller opens his stall on a rainy Mumbai morning. English voice-over.","targetS":12}' "$BASE/api/scenes" | j 'v.scene.id')
t0=$(date +%s)
for i in $(seq 1 120); do R=$(curl -fsS -b "$JAR" "$BASE/api/scenes/$SC"); S=$(echo "$R" | j 'v.scene.status'); [ "$S" = READY ] || [ "$S" = FAILED ] && break; sleep 3; done
echo "scene: $S in $(( $(date +%s) - t0 )) s  title=$(echo "$R" | j 'v.scene.title')  shots=$(echo "$R" | j '(v.scene.script?.shots||[]).length')  error=$(echo "$R" | j 'v.scene.error')"
[ "$S" = READY ]
