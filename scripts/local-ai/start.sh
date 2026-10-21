#!/usr/bin/env bash
# Start / stop the local AI engines for AI Media Studio.
#   scripts/local-ai/start.sh          # start LLM (llama-server :8081) + picture/voice gateway (:8082)
#   scripts/local-ai/start.sh stop     # stop both
#   scripts/local-ai/start.sh status
# Everything runs as your user from ~/.local/share/ams-ai (see install.sh). Docker containers reach
# them at http://host.docker.internal:8081 / :8082 (compose maps host-gateway).
set -euo pipefail
ROOT="${AMS_AI_HOME:-$HOME/.local/share/ams-ai}"
RUN="$ROOT/run"; mkdir -p "$RUN"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Listen on all interfaces so containers can reach us; both servers require the shared token
# (LOCAL_AI_TOKEN in .env).
BIND="${LOCAL_AI_BIND:-0.0.0.0}"
TOKEN="${LOCAL_AI_TOKEN:-$(grep -E '^LOCAL_AI_TOKEN=' "$HERE/../../.env" 2>/dev/null | cut -d= -f2-)}"
[ -n "$TOKEN" ] || { echo "Set LOCAL_AI_TOKEN in .env first (any long random string)"; exit 1; }
# Physical cores, not threads: llama.cpp generation is memory-bound and SMT threads slow it down.
CORES="$(lscpu -p=core 2>/dev/null | grep -v '^#' | sort -u | wc -l)"; [ "$CORES" -gt 0 ] || CORES="$(nproc)"

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
status() { for n in llm scribe gateway; do if alive "$n"; then echo "$n: running (pid $(cat "$RUN/$n.pid"))"; else echo "$n: stopped"; fi; done; }
stop() {
  for n in llm scribe gateway; do
    if alive "$n"; then kill "$(cat "$RUN/$n.pid")" 2>/dev/null || true; fi
    rm -f "$RUN/$n.pid"
  done
  echo stopped
}

case "${1:-start}" in
  stop) stop; exit 0 ;;
  status) status; exit 0 ;;
  restart) stop; sleep 1 ;;
esac

if ! alive llm; then
  # Qwen3-4B-Instruct (Q4_K_M) on the CPU. One slot (one director run at a time) with 8k context.
  LD_LIBRARY_PATH="$ROOT/bin/llama" nohup "$ROOT/bin/llama/llama-server" \
    -m "$ROOT/models/llm/qwen3-4b-instruct-q4km.gguf" \
    --host "$BIND" --port 8081 --api-key "$TOKEN" \
    -c 8192 -np 1 -t "$CORES" --jinja --no-webui \
    > "$RUN/llm.log" 2>&1 &
  echo $! > "$RUN/llm.pid"
fi

# Hinglish -> Devanagari (Gemma-3-4B writes the cleanest Devanagari; measured). Optional.
SCRIBE_MODEL="$ROOT/models/llm/gemma3-4b-it-q4km.gguf"
if [ -f "$SCRIBE_MODEL" ] && ! alive scribe; then
  LD_LIBRARY_PATH="$ROOT/bin/llama" nohup "$ROOT/bin/llama/llama-server" \
    -m "$SCRIBE_MODEL" --host "$BIND" --port 8083 --api-key "$TOKEN" \
    -c 4096 -np 1 -t "$CORES" --jinja --no-webui \
    > "$RUN/scribe.log" 2>&1 &
  echo $! > "$RUN/scribe.pid"
fi

if ! alive gateway; then
  AMS_AI_HOME="$ROOT" LOCAL_AI_TOKEN="$TOKEN" LOCAL_AI_BIND="$BIND" nohup python3 "$HERE/gateway.py" > "$RUN/gateway.log" 2>&1 &
  echo $! > "$RUN/gateway.pid"
fi

for i in $(seq 1 90); do
  a=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/health || true)
  b=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8082/health || true)
  c=200; [ -f "$SCRIBE_MODEL" ] && c=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8083/health || true)
  if [ "$a" = 200 ] && [ "$b" = 200 ] && [ "$c" = 200 ]; then status; echo "ready"; exit 0; fi
  sleep 1
done
echo "not ready after 90 s; logs: $RUN/llm.log $RUN/gateway.log"; status; exit 1
