#!/usr/bin/env python3
"""Sample facial expressions from a talking-head video for highlight detection.

Samples frames, finds the largest face with OpenCV's Haar cascade, and classifies
its expression with the FER+ ONNX model (8 classes). Emits JSON on stdout and
never raises: failures are reported as {"error": ...} with a non-zero exit so the
selection layer can fall back to audio/visual signals.

Usage:
    python tools/emotion.py <video> --model <fer.onnx> [--samples 24] [--scale 0.5]
"""
from __future__ import annotations

import argparse
import json
import sys

LABELS = ["neutral", "happiness", "surprise", "sadness", "anger", "disgust", "fear", "contempt"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sample facial expressions for highlight detection.")
    parser.add_argument("video", help="Path to the source video.")
    parser.add_argument("--model", required=True, help="Path to the FER+ ONNX model.")
    parser.add_argument("--samples", type=int, default=24, help="Frames to sample when --every-seconds is 0.")
    parser.add_argument("--every-seconds", type=float, default=3.0, help="Sample one frame every N seconds (0 = use --samples).")
    parser.add_argument("--scale", type=float, default=1.0, help="Downscale factor before detection (default 1.0).")
    parser.add_argument("--min-neighbors", type=int, default=5, help="Cascade minNeighbors.")
    parser.add_argument("--min-size", type=int, default=20, help="Minimum face box in pixels.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        import cv2
        import numpy as np
    except Exception as error:  # pragma: no cover - environment dependent
        print(json.dumps({"error": f"opencv/numpy unavailable: {error}"}))
        return 2

    capture = cv2.VideoCapture(args.video)
    if not capture.isOpened():
        print(json.dumps({"error": f"cannot open {args.video}"}))
        return 1

    try:
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        net = cv2.dnn.readNetFromONNX(args.model)
        if cascade.empty() or net.empty():
            print(json.dumps({"error": "cascade or model failed to load"}))
            return 2

        fps = capture.get(cv2.CAP_PROP_FPS) or 0.0
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if total > 0 and fps > 0 and args.every_seconds > 0:
            step = max(1, int(round(args.every_seconds * fps)))
            indices = list(range(0, total, step))
        else:
            samples = max(1, args.samples)
            indices = [int(total * (i + 0.5) / samples) if total > 0 else i for i in range(samples)]
        out = []
        for index in indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = capture.read()
            if not ok:
                continue
            t = index / fps if fps > 0 else float(index)
            if args.scale and args.scale != 1.0:
                frame = cv2.resize(frame, None, fx=args.scale, fy=args.scale)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=args.min_neighbors, minSize=(args.min_size, args.min_size))
            if len(faces) == 0:
                out.append({"t": round(t, 3), "emotion": None, "confidence": 0.0})
                continue
            x, y, w, h = max(faces, key=lambda box: int(box[2]) * int(box[3]))
            face = cv2.resize(gray[y:y + h, x:x + w], (64, 64)).astype(np.float32)
            net.setInput(face[None, None, :, :])
            logits = net.forward()[0]
            shifted = logits - logits.max()
            probs = np.exp(shifted) / np.exp(shifted).sum()
            best = int(probs.argmax())
            out.append({"t": round(t, 3), "emotion": LABELS[best], "confidence": round(float(probs[best]), 4)})

        print(json.dumps({"samples": out, "frames": len(out)}))
        return 0
    finally:
        capture.release()


if __name__ == "__main__":
    sys.exit(main())
