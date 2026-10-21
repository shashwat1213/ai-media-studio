#!/usr/bin/env python3
"""
Face boxes in a picture, so on-screen titles can be placed away from faces.

    faces.py MODEL.onnx IMAGE  ->  stdout JSON: [{"x", "y", "w", "h", "score"}, ...]

Boxes are normalised to 0..1 of the picture (top-left origin), biggest first, at most 5.
OpenCV YuNet (face_detection_yunet_2023mar.onnx, 0.23 MB, MIT), CPU, ~20 ms per 512x768 picture.
Runs in its own venv (opencv-python-headless) so the gateway itself stays stdlib-only.
"""
import json
import sys

import cv2


def main():
    model, image = sys.argv[1], sys.argv[2]
    img = cv2.imread(image)
    if img is None:
        raise SystemExit("cannot read image")
    h, w = img.shape[:2]
    # YuNet works best around 320-640 px: detect on a downscaled copy, scale the boxes back.
    k = min(1.0, 640 / max(w, h))
    small = cv2.resize(img, (round(w * k), round(h * k))) if k < 1 else img
    sh, sw = small.shape[:2]
    det = cv2.FaceDetectorYN.create(model, "", (sw, sh), 0.6, 0.3, 50)
    _, faces = det.detect(small)
    out = []
    for f in faces if faces is not None else []:
        x, y, fw, fh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[-1])
        # Ignore tiny detections (background people, texture false positives).
        if fw < sw * 0.04:
            continue
        x0, y0 = max(0.0, x / sw), max(0.0, y / sh)
        x1, y1 = min(1.0, (x + fw) / sw), min(1.0, (y + fh) / sh)
        out.append({"x": round(x0, 4), "y": round(y0, 4), "w": round(x1 - x0, 4), "h": round(y1 - y0, 4), "score": round(score, 3)})
    out.sort(key=lambda b: b["w"] * b["h"], reverse=True)
    print(json.dumps(out[:5]))


if __name__ == "__main__":
    main()
