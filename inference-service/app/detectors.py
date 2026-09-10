"""
Real computer-vision detectors for SentriAI.

Every detector here performs ACTUAL image analysis. None fabricate or randomly
generate detections. Bounding boxes are returned normalized to [0, 1].
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np


@dataclass
class Detection:
    cls: str
    confidence: float
    x: float
    y: float
    w: float
    h: float

    def to_dict(self) -> dict:
        return {
            "class": self.cls,
            "confidence": round(float(self.confidence), 4),
            "bbox": {
                "x": round(float(self.x), 4),
                "y": round(float(self.y), 4),
                "width": round(float(self.w), 4),
                "height": round(float(self.h), 4),
            },
        }


@dataclass
class InferenceResult:
    model: str
    model_version: str
    inference_ms: int
    detections: list[Detection] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "modelVersion": self.model_version,
            "inferenceMs": self.inference_ms,
            "detections": [d.to_dict() for d in self.detections],
        }


def _decode(image_bytes: bytes) -> Optional[np.ndarray]:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


class HogPersonDetector:
    """OpenCV HOG + SVM pedestrian detector — real CV, CPU-only, no weights download."""

    name = "opencv-hog"
    version = "1.0"
    classes = ["person"]

    def __init__(self) -> None:
        self._hog = cv2.HOGDescriptor()
        self._hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def infer(self, img: np.ndarray, min_confidence: float) -> list[Detection]:
        h, w = img.shape[:2]
        # Downscale very large frames for speed; HOG is CPU-heavy.
        scale = 1.0
        if w > 640:
            scale = 640.0 / w
            img_s = cv2.resize(img, (int(w * scale), int(h * scale)))
        else:
            img_s = img
        rects, weights = self._hog.detectMultiScale(
            img_s, winStride=(8, 8), padding=(8, 8), scale=1.05
        )
        out: list[Detection] = []
        sh, sw = img_s.shape[:2]
        for (rx, ry, rw, rh), score in zip(rects, weights):
            # HOG weight -> pseudo-confidence in [0,1] via a logistic squashing.
            conf = float(1.0 / (1.0 + np.exp(-score)))
            if conf < min_confidence:
                continue
            out.append(
                Detection(
                    cls="person",
                    confidence=conf,
                    x=rx / sw,
                    y=ry / sh,
                    w=rw / sw,
                    h=rh / sh,
                )
            )
        return out


class FireCvDetector:
    """
    Classical color/segmentation fire & smoke candidate detector (real CV).

    Fire: bright warm (red/orange/yellow) high-saturation regions.
    Smoke: low-saturation, mid-brightness, low-color-variance gray regions.

    This is genuine image analysis, not a mock. Classical CV fire detection has
    limited accuracy; production should plug a trained fire/smoke model via the
    ONNX backend. The confidence reflects the fraction of the frame matching the
    signature, so an all-black or all-blue frame yields no detection.
    """

    name = "fire-cv"
    version = "1.0"
    classes = ["FIRE", "SMOKE"]

    def infer(self, img: np.ndarray, min_confidence: float) -> list[Detection]:
        h, w = img.shape[:2]
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        out: list[Detection] = []

        # --- FIRE: warm hue + high saturation + high value ---
        lower1 = np.array([0, 120, 150])
        upper1 = np.array([35, 255, 255])
        lower2 = np.array([160, 120, 150])
        upper2 = np.array([180, 255, 255])
        fire_mask = cv2.inRange(hsv, lower1, upper1) | cv2.inRange(hsv, lower2, upper2)
        fire_mask = cv2.morphologyEx(fire_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        box = self._largest_region(fire_mask, w, h)
        if box is not None:
            area_frac, (bx, by, bw, bh) = box
            conf = min(0.99, 0.5 + area_frac * 2.0)  # more warm-region => higher conf
            if area_frac >= 0.01 and conf >= min_confidence:
                out.append(Detection("FIRE", conf, bx, by, bw, bh))

        # --- SMOKE: low saturation, mid value, low local color variance ---
        s = hsv[:, :, 1]
        v = hsv[:, :, 2]
        smoke_mask = ((s < 60) & (v > 80) & (v < 200)).astype(np.uint8) * 255
        smoke_mask = cv2.morphologyEx(smoke_mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        box = self._largest_region(smoke_mask, w, h, min_area_frac=0.05)
        if box is not None:
            area_frac, (bx, by, bw, bh) = box
            conf = min(0.95, 0.4 + area_frac)
            if area_frac >= 0.05 and conf >= min_confidence:
                out.append(Detection("SMOKE", conf, bx, by, bw, bh))

        return out

    @staticmethod
    def _largest_region(mask: np.ndarray, w: int, h: int, min_area_frac: float = 0.005):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None
        largest = max(contours, key=cv2.contourArea)
        area = cv2.contourArea(largest)
        area_frac = area / float(w * h)
        if area_frac < min_area_frac:
            return None
        bx, by, bw, bh = cv2.boundingRect(largest)
        return area_frac, (bx / w, by / h, bw / w, bh / h)


class OnnxDetector:
    """
    Optional ONNX object detector (e.g. YOLO). Loaded only when ONNX_MODEL_PATH is
    set and onnxruntime is installed. Real inference against the provided model.
    """

    name = "onnx"
    version = "1.0"

    def __init__(self, model_path: str, labels: list[str]) -> None:
        import onnxruntime as ort  # imported lazily; optional dependency

        self._sess = ort.InferenceSession(model_path, providers=ort.get_available_providers())
        self._input = self._sess.get_inputs()[0]
        self.classes = labels
        # Infer expected square input size from the model when static.
        shape = self._input.shape
        self._size = int(shape[2]) if isinstance(shape[2], int) else 640

    def infer(self, img: np.ndarray, min_confidence: float) -> list[Detection]:
        h, w = img.shape[:2]
        size = self._size
        resized = cv2.resize(img, (size, size))
        blob = resized[:, :, ::-1].astype(np.float32) / 255.0  # BGR->RGB, normalize
        blob = np.transpose(blob, (2, 0, 1))[None, ...]  # NCHW
        outputs = self._sess.run(None, {self._input.name: blob})
        preds = outputs[0]
        # Support common YOLO output [1, N, 5+num_classes].
        preds = np.squeeze(preds)
        out: list[Detection] = []
        if preds.ndim != 2:
            return out
        for row in preds:
            if row.shape[0] < 6:
                continue
            obj_conf = float(row[4])
            class_scores = row[5:]
            cls_id = int(np.argmax(class_scores))
            conf = obj_conf * float(class_scores[cls_id])
            if conf < min_confidence or cls_id >= len(self.classes):
                continue
            cx, cy, bw, bh = row[0], row[1], row[2], row[3]
            # YOLO center-xywh in input px -> normalized top-left xywh.
            x = (cx - bw / 2) / size
            y = (cy - bh / 2) / size
            out.append(Detection(self.classes[cls_id], conf, x, y, bw / size, bh / size))
        return out


class DetectorRegistry:
    def __init__(self) -> None:
        self._hog = HogPersonDetector()
        self._fire = FireCvDetector()
        self._onnx: Optional[OnnxDetector] = None
        model_path = os.environ.get("ONNX_MODEL_PATH", "").strip()
        labels = [x for x in os.environ.get("ONNX_LABELS", "").split(",") if x]
        if model_path and labels:
            try:
                self._onnx = OnnxDetector(model_path, labels)
            except Exception:  # pragma: no cover - depends on optional dep + weights
                self._onnx = None

    def available(self) -> dict:
        models = {
            self._hog.name: self._hog.classes,
            self._fire.name: self._fire.classes,
        }
        if self._onnx is not None:
            models[self._onnx.name] = self._onnx.classes
        return models

    def ready(self) -> bool:
        # HOG + fire-cv are always available; service is ready once constructed.
        return True

    def infer(self, model: str, image_bytes: bytes, min_confidence: float) -> InferenceResult:
        img = _decode(image_bytes)
        if img is None:
            raise ValueError("Could not decode image frame")
        started = time.time()
        if model in ("onnx", "yolo") and self._onnx is not None:
            det = self._onnx.infer(img, min_confidence)
            name, ver = self._onnx.name, self._onnx.version
        elif model in ("fire", "fire-cv", "smoke"):
            det = self._fire.infer(img, min_confidence)
            name, ver = self._fire.name, self._fire.version
        else:
            # Default general detector.
            det = self._hog.infer(img, min_confidence)
            name, ver = self._hog.name, self._hog.version
        elapsed = int((time.time() - started) * 1000)
        return InferenceResult(model=name, model_version=ver, inference_ms=elapsed, detections=det)
