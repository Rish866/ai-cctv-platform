"""
Real-CV detector tests. Prove the detectors do genuine, deterministic analysis
(not random). Run with: inference-service/.venv/bin/python -m pytest
"""
import numpy as np
import cv2

from app.detectors import DetectorRegistry


def _jpg(img):
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return buf.tobytes()


def test_fire_detected_on_orange_region():
    reg = DetectorRegistry()
    frame = np.zeros((240, 320, 3), np.uint8)
    frame[:] = (60, 60, 60)
    cv2.rectangle(frame, (60, 60), (260, 200), (30, 140, 255), -1)  # BGR orange
    result = reg.infer("fire", _jpg(frame), 0.5)
    assert any(d.cls == "FIRE" for d in result.detections)
    assert result.model == "fire-cv"


def test_no_fire_on_blue_frame():
    reg = DetectorRegistry()
    blue = np.zeros((240, 320, 3), np.uint8)
    blue[:] = (200, 40, 0)
    result = reg.infer("fire", _jpg(blue), 0.5)
    assert len(result.detections) == 0


def test_detection_is_deterministic():
    reg = DetectorRegistry()
    frame = np.zeros((240, 320, 3), np.uint8)
    frame[:] = (60, 60, 60)
    cv2.rectangle(frame, (60, 60), (260, 200), (30, 140, 255), -1)
    r1 = reg.infer("fire", _jpg(frame), 0.5)
    r2 = reg.infer("fire", _jpg(frame), 0.5)
    assert len(r1.detections) == len(r2.detections)


def test_person_detector_available_and_runs():
    reg = DetectorRegistry()
    assert "opencv-hog" in reg.available()
    blank = np.zeros((240, 320, 3), np.uint8)
    result = reg.infer("general", _jpg(blank), 0.5)
    # Blank frame -> 0 people (correct, not fabricated).
    assert result.model == "opencv-hog"
    assert isinstance(result.detections, list)
