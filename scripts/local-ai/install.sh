#!/usr/bin/env bash
# Local AI engines for AI Media Studio's Scene Director. User-space only (no sudo).
# Layout: ~/.local/share/ams-ai/{bin/<engine>, models/<kind>}
set -euo pipefail
ROOT="${AMS_AI_HOME:-$HOME/.local/share/ams-ai}"
mkdir -p "$ROOT"/bin "$ROOT"/models/{llm,sd,lora,piper,upscale,ipadapter} "$ROOT"/tmp
cd "$ROOT/tmp"

dl() { # url dest  (resumes .part files; only renames after curl reports success)
  local url="$1" dest="$2" ok=0
  if [ -s "$dest" ]; then echo "have $(basename "$dest")"; return; fi
  echo "get  $(basename "$dest")"
  for i in 1 2 3 4 5; do
    if curl -fL --http1.1 --retry 5 --retry-all-errors -C - -o "$dest.part" "$url"; then ok=1; break; fi
    echo "retry $i"; sleep 3
  done
  [ "$ok" = 1 ] || { echo "download failed: $url"; exit 1; }
  mv "$dest.part" "$dest"
}

# --- binaries -------------------------------------------------------------------------------
LLAMA_TAG=b11617
dl "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-ubuntu-x64.tar.gz" llama.tgz
[ -x "$ROOT/bin/llama/llama-server" ] || { mkdir -p "$ROOT/bin/llama"; tar -xzf llama.tgz -C "$ROOT/bin/llama" --strip-components=1 2>/dev/null || tar -xzf llama.tgz -C "$ROOT/bin/llama"; }

SD_TAG=master-964-1d0a58a
dl "https://github.com/leejet/stable-diffusion.cpp/releases/download/$SD_TAG/sd-master-1d0a58a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip" sd-vulkan.zip
[ -d "$ROOT/bin/sd" ] || { mkdir -p "$ROOT/bin/sd"; python3 -m zipfile -e sd-vulkan.zip "$ROOT/bin/sd"; chmod +x "$ROOT"/bin/sd/* 2>/dev/null || true; }

dl "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz" piper.tgz
[ -x "$ROOT/bin/piper/piper" ] || tar -xzf piper.tgz -C "$ROOT/bin"

WHISPER_TAG=b5454
dl "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_TAG/whisper-bin-ubuntu-x64.tar.gz" whisper.tgz
[ -d "$ROOT/bin/whisper" ] || { mkdir -p "$ROOT/bin/whisper"; tar -xzf whisper.tgz -C "$ROOT/bin/whisper"; }

# --- models ---------------------------------------------------------------------------------
HF=https://huggingface.co
PV=$HF/rhasspy/piper-voices/resolve/main
for v in hi/hi_IN/pratham/medium/hi_IN-pratham-medium hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium hi/hi_IN/rohan/medium/hi_IN-rohan-medium en/en_US/lessac/medium/en_US-lessac-medium en/en_US/ryan/high/en_US-ryan-high en/en_GB/alan/medium/en_GB-alan-medium; do
  n=$(basename "$v")
  dl "$PV/$v.onnx" "$ROOT/models/piper/$n.onnx"
  dl "$PV/$v.onnx.json" "$ROOT/models/piper/$n.onnx.json"
done
dl "$HF/latent-consistency/lcm-lora-sdv1-5/resolve/main/pytorch_lora_weights.safetensors" "$ROOT/models/lora/lcm-sd15.safetensors"
dl "$HF/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors" "$ROOT/models/sd/dreamshaper8.safetensors"
# HD pictures: Real-ESRGAN x4plus (BSD-3-Clause, 64 MB)
dl "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth" "$ROOT/models/upscale/RealESRGAN_x4plus.pth"
# Same face in every shot: IP-Adapter plus-face SD1.5 (Apache-2.0, 98 MB) + CLIP ViT-H image encoder (2.5 GB)
dl "$HF/h94/IP-Adapter/resolve/main/models/ip-adapter-plus-face_sd15.safetensors" "$ROOT/models/ipadapter/ip-adapter-plus-face_sd15.safetensors"
dl "$HF/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors" "$ROOT/models/ipadapter/clip-vision-vit-h.safetensors"
mkdir -p "$ROOT/models/whisper"
dl "$HF/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" "$ROOT/models/whisper/large-v3-turbo-q5_0.bin"
dl "$HF/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf" "$ROOT/models/llm/gemma3-4b-it-q4km.gguf"
dl "$HF/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" "$ROOT/models/llm/qwen3-4b-instruct-q4km.gguf"

rm -rf "$ROOT/tmp"
echo "DONE"; du -sh "$ROOT"/bin "$ROOT"/models/*
