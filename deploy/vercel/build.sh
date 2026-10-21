#!/usr/bin/env bash
# Build AI Media Studio for Vercel (Build Output API v3) and print the output dir.
#
#   bash deploy/vercel/build.sh        # -> .vercel/output (then: vercel deploy --prebuilt --prod)
#   KEEP_NATIVE_ENGINE=1 bash deploy/vercel/build.sh   # also keep this machine's Prisma engine (local test)
#
# Layout of the deployment:
#   /            static SPA (web/dist), SPA fallback to index.html
#   /api/*       ONE Node function = the Express API + in-process job runner (api/dist/serverless.js)
#                bundled with ONLY production deps, the Prisma engine for Vercel's runtime,
#                the fonts, and a static ffmpeg/ffprobe (checksum-verified).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/.vercel/output"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FN="$OUT/functions/api/index.func"

# Pinned static ffmpeg 7.0.2 (johnvansickle.com) + UPX 5.0.2, both verified by SHA-256.
# UPX packs the two binaries 153 MB -> 49 MB so the function fits Vercel's 250 MB limit.
FFMPEG_URL=${FFMPEG_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz}
FFMPEG_SHA256=${FFMPEG_SHA256:-abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67}
UPX_URL=https://github.com/upx/upx/releases/download/v5.0.2/upx-5.0.2-amd64_linux.tar.xz
UPX_SHA256=ddc2654063fe4dc80d95b420788494e4db078ebb01a650692d623b5a9906e61e
FF_CACHE=${FF_CACHE:-$HOME/.cache/ams-ffmpeg}

echo "== web"
(cd "$ROOT/web" && npm ci --silent && VITE_API_URL=/api npm run build --silent)

echo "== api (compile)"
(cd "$ROOT/api" && npm ci --silent && npm run build --silent)

echo "== api (production deps for Vercel's runtime)"
cp "$ROOT/api/package.json" "$ROOT/api/package-lock.json" "$WORK/"
cp -r "$ROOT/api/prisma" "$WORK/prisma"
# Vercel's Node runtime is Amazon Linux 2023 (glibc, OpenSSL 3).
sed -i 's/binaryTargets *= *\[[^]]*\]/binaryTargets = ["native", "rhel-openssl-3.0.x"]/' "$WORK/prisma/schema.prisma"
(cd "$WORK" && npm ci --omit=dev --ignore-scripts --silent && ./node_modules/.bin/prisma generate >/dev/null)
# Same trimming as the Docker image (see api/Dockerfile), plus engines we don't run on.
(cd "$WORK/node_modules" && rm -rf prisma @prisma/engines @prisma/config @prisma/fetch-engine @prisma/get-platform effect typescript fast-check .bin \
  && rm -f @prisma/client/runtime/*.wasm-base64.* @prisma/client/runtime/query_engine_bg.* @prisma/client/runtime/query_compiler_bg.* \
  && { [ -n "${KEEP_NATIVE_ENGINE:-}" ] || find .prisma/client -name 'libquery_engine-*' ! -name '*rhel-openssl-3.0.x*' -delete; } \
  && rm -f .prisma/client/query_engine_bg.* \
  && find . -name '*.map' -type f -delete)

echo "== ffmpeg"
mkdir -p "$FF_CACHE"
if [ ! -x "$FF_CACHE/ffmpeg" ] || [ ! -x "$FF_CACHE/ffprobe" ]; then
  curl -fsSL "$FFMPEG_URL" -o "$WORK/ff.tar.xz"
  echo "$FFMPEG_SHA256  $WORK/ff.tar.xz" | sha256sum -c - >/dev/null
  tar -xf "$WORK/ff.tar.xz" -C "$WORK" --wildcards '*/ffmpeg' '*/ffprobe'
  cp "$WORK"/ffmpeg-*-amd64-static/ffmpeg "$WORK"/ffmpeg-*-amd64-static/ffprobe "$FF_CACHE/"
fi
if [ ! -f "$FF_CACHE/.packed" ]; then
  curl -fsSL "$UPX_URL" -o "$WORK/upx.tar.xz"
  echo "$UPX_SHA256  $WORK/upx.tar.xz" | sha256sum -c - >/dev/null
  tar -xf "$WORK/upx.tar.xz" -C "$WORK"
  "$WORK"/upx-*-amd64_linux/upx -q --best "$FF_CACHE/ffmpeg" "$FF_CACHE/ffprobe" >/dev/null
  touch "$FF_CACHE/.packed"
fi
"$FF_CACHE/ffmpeg" -hide_banner -filters | grep -q ' xfade ' # sanity: the packed binary runs

echo "== assemble $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/static" "$FN/api" "$FN/bin"
cp -r "$ROOT/web/dist/." "$OUT/static/"
cp -r "$ROOT/api/dist" "$FN/api/dist"
cp -r "$ROOT/api/assets" "$FN/api/assets"
cp "$ROOT/api/package.json" "$FN/api/package.json"
mv "$WORK/node_modules" "$FN/api/node_modules"
cp "$FF_CACHE/ffmpeg" "$FF_CACHE/ffprobe" "$FN/bin/"
cp "$ROOT/deploy/vercel/handler.mjs" "$FN/index.mjs"

cat > "$FN/.vc-config.json" <<'EOF'
{
  "runtime": "nodejs22.x",
  "handler": "index.mjs",
  "launcherType": "Nodejs",
  "shouldAddHelpers": false,
  "supportsResponseStreaming": true,
  "maxDuration": 300,
  "memory": 2048
}
EOF

cat > "$OUT/config.json" <<'EOF'
{
  "version": 3,
  "crons": [
    { "path": "/api/internal/cron/demo-topup", "schedule": "5 0 * * *" }
  ],
  "routes": [
    { "src": "^/api(?:/(.*))?$", "dest": "/api" },
    { "src": "^/assets/(.*)$", "headers": { "Cache-Control": "public, max-age=31536000, immutable" }, "continue": true },
    { "handle": "filesystem" },
    { "src": "^/(.*)$", "dest": "/index.html", "headers": { "Cache-Control": "no-cache" } }
  ]
}
EOF

du -sh "$FN" "$OUT/static"
echo "$OUT"
