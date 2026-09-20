#!/usr/bin/env bash
# Reproducible setup of the isolated local Whisper (GPU) env for the clipping pipeline.
# System python is 3.14 (too new for ctranslate2/torch wheels); this pins 3.12.
# Run from the repo root:  bash tools/setup-whisper.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Shared model cache so weights are not duplicated per checkout.
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
mkdir -p "$HF_HOME"

if [ ! -d .venv ]; then
  uv venv --python 3.12 .venv
fi

uv pip install --python .venv/bin/python -r tools/requirements-whisper.txt
# Render layer: auto-editor performs the dead-air tighten stage. Without it the
# render stage logs a warning and keeps the untightened cut.
uv pip install --python .venv/bin/python -r tools/requirements-clipping.txt

echo
echo "Done. Smoke test:"
.venv/bin/python tools/transcribe.py --help >/dev/null && echo "  transcribe.py OK"
echo "Usage:  .venv/bin/python tools/transcribe.py <media> -o out.json"
