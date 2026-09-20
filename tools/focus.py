#!/usr/bin/env python3
"""Estimate the horizontal focus of a talking-head video for the 9:16 reframe.

Samples frames, runs OpenCV's bundled frontal-face cascade, and prints the median
horizontal center of the largest face as a fraction of frame width. Emits JSON on
stdout and never raises: a failure is reported as {"error": ...} with a non-zero
exit so the render layer can fall back to a centered crop.

Usage:
    python tools/focus.py <video> [--samples 12] [--scale 0.5]
"""
from __future__ import annotations

import argparse
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Estimate horizontal face focus for reframing.")
    parser.add_argument("video", help="Path to the source video.")
    parser.add_argument("--samples", type=int, default=12, help="Frames to sample (default 12).")
    parser.add_argument("--scale", type=float, default=0.5, help="Downscale factor before detection.")
    parser.add_argument("--min-neighbors", type=int, default=5, help="Cascade minNeighbors.")
    return parser.parse_args()


def median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def main() -> int:
    args = parse_args()
    try:
        import cv2
    except Exception as error:  # pragma: no cover - environment dependent
        print(json.dumps({"error": f"opencv unavailable: {error}"}))
        return 2

    capture = cv2.VideoCapture(args.video)
    if not capture.isOpened():
        print(json.dumps({"error": f"cannot open {args.video}"}))
        return 1

    try:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        if cascade.empty():
            print(json.dumps({"error": f"cascade missing at {cascade_path}"}))
            return 2

        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        samples = max(1, args.samples)
        centers: list[float] = []
        frames = 0
        for index in range(samples):
            if total > 0:
                capture.set(cv2.CAP_PROP_POS_FRAMES, int(total * (index + 0.5) / samples))
            ok, frame = capture.read()
            if not ok:
                continue
            frames += 1
            if args.scale and args.scale != 1.0:
                frame = cv2.resize(frame, None, fx=args.scale, fy=args.scale)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=args.min_neighbors, minSize=(24, 24))
            if len(faces) == 0:
                continue
            x, _y, width, _height = max(faces, key=lambda box: int(box[2]) * int(box[3]))
            centers.append(min(1.0, max(0.0, (x + width / 2) / frame.shape[1])))

        focus = median(centers) if centers else None
        print(json.dumps({"focusX": focus, "faces": len(centers), "frames": frames}))
        return 0
    finally:
        capture.release()


if __name__ == "__main__":
    sys.exit(main())
