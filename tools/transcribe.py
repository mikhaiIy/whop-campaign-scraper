#!/usr/bin/env python3
"""Local faster-whisper transcription with word-level timestamps.

Emits JSON: {segments:[{start,end,text,words:[{start,end,word,probability}]}]}

Isolation / CUDA note:
  ctranslate2 4.x (CUDA 12 build) needs libcublas.so.12 + libcudnn.so.9.
  Those are installed as pip wheels under site-packages/nvidia/*/lib.
  ld.so does not pick up os.environ changes after start, so this script
  re-execs itself once with LD_LIBRARY_PATH set. Nothing to configure.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _ensure_cuda_libs() -> None:
    """Re-exec with the venv's bundled CUDA 12 libs on LD_LIBRARY_PATH."""
    nvidia = Path(sys.prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages" / "nvidia"
    libs = [nvidia / "cublas" / "lib", nvidia / "cudnn" / "lib"]
    present = [str(p) for p in libs if p.is_dir()]
    if not present:
        return
    existing = os.environ.get("LD_LIBRARY_PATH", "")
    if all(p in existing.split(":") for p in present):
        return
    os.environ["LD_LIBRARY_PATH"] = ":".join(present + ([existing] if existing else []))
    os.execv(sys.executable, [sys.executable, *sys.argv])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("media", help="path to audio or video file")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    ap.add_argument("--compute-type", default="int8_float16")
    ap.add_argument("--language", default="en", help="ISO code, or 'auto'")
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--no-vad", action="store_true", help="disable voice activity detection")
    ap.add_argument("--output", "-o", default="-", help="output json path, or '-' for stdout")
    args = ap.parse_args()

    _ensure_cuda_libs()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(
        args.media,
        language=None if args.language == "auto" else args.language,
        beam_size=args.beam_size,
        word_timestamps=True,
        vad_filter=not args.no_vad,
    )

    out = {
        "file": args.media,
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segments": [],
    }
    for seg in segments:
        out["segments"].append(
            {
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip(),
                "words": [
                    {"start": w.start, "end": w.end, "word": w.word, "probability": w.probability}
                    for w in (seg.words or [])
                ],
            }
        )

    payload = json.dumps(out, ensure_ascii=False)
    if args.output == "-":
        print(payload)
    else:
        Path(args.output).write_text(payload, encoding="utf-8")
        print(f"wrote {args.output} ({len(out['segments'])} segments)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
