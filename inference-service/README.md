# SentriAI Inference Service

A standalone **real computer-vision** inference microservice (FastAPI + OpenCV,
optional ONNX Runtime). It receives a frame (JPEG/PNG bytes or base64) and
returns detections using the stable detection contract the SentriAI API expects.

This service performs **actual image analysis** — it never fabricates or randomly
generates detections. If a requested model/backend is not loaded, the relevant
endpoint reports that clearly rather than inventing results.

## Detectors

| Backend | Classes | Notes |
|---------|---------|-------|
| `opencv-hog` (built-in, always available) | `person` | OpenCV HOG + SVM pedestrian detector — real CV, CPU-only, good for dev/testing without downloading weights. |
| `onnx` (optional) | depends on the loaded model (e.g. YOLO: person, car, truck, bus, motorcycle, bicycle) | Enabled when `ONNX_MODEL_PATH` points at a valid ONNX detection model + `ONNX_LABELS` is set. Requires `onnxruntime`. |
| `fire-cv` (built-in heuristic) | `FIRE`, `SMOKE` | Real color/segmentation-based fire & smoke candidate analysis (HSV thresholds + region growth). This is a *classical CV* detector, not a deep model; for production-grade accuracy plug a trained fire/smoke ONNX model via the `onnx` backend and set `FIRE_MODEL=onnx`. Clearly reported as `fire-cv` in `model`. |

> Fire/smoke via `fire-cv` is a genuine visual analysis (not fake), but classical
> CV fire detection has limited accuracy. For deployment, supply a trained
> fire/smoke model. The API's `ProductionInferenceAdapter` consumes whatever this
> service returns; it does not assume a specific model.

## Endpoints

- `GET /health` — liveness.
- `GET /ready` — readiness (models loaded).
- `GET /models` — which backends/classes are available.
- `POST /infer` — multipart `frame` (image) + form fields `model`, `min_confidence`; returns the detection contract.

## Run (dev)

```bash
cd inference-service
uv venv && source .venv/bin/activate      # or python -m venv
uv pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8100
```

## Detection contract (response)

```json
{
  "model": "opencv-hog",
  "modelVersion": "1.0",
  "inferenceMs": 38,
  "detections": [
    { "class": "person", "confidence": 0.94, "bbox": { "x": 0.10, "y": 0.18, "width": 0.22, "height": 0.61 } }
  ]
}
```

Coordinates are normalized to `[0,1]`. No credentials, no PII, no biometric
identity — only object classes + boxes.
