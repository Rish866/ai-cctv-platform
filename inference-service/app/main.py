"""
GarudAI Inference Service — FastAPI wrapper around the real CV detectors.

Security posture:
  * This service performs REAL image analysis; it never fabricates detections.
  * It holds NO tenant data and NO credentials. It only receives an opaque frame
    and returns object classes + boxes. Tenant scoping/authorization is enforced
    by the GarudAI API and media worker, not here.
  * Runs on a private network; not exposed publicly. Health endpoints reveal no
    sensitive information.
"""
from __future__ import annotations

import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from .detectors import DetectorRegistry

app = FastAPI(title="GarudAI Inference Service", version="1.0.0")
registry = DetectorRegistry()

# Optional shared secret so only the media worker / API can call /infer.
INFERENCE_TOKEN = os.environ.get("INFERENCE_SERVICE_TOKEN", "").strip()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "garudai-inference"}


@app.get("/ready")
def ready() -> JSONResponse:
    ok = registry.ready()
    return JSONResponse({"ready": ok}, status_code=200 if ok else 503)


@app.get("/models")
def models() -> dict:
    return {"models": registry.available()}


@app.post("/infer")
async def infer(
    frame: UploadFile = File(...),
    model: str = Form("general"),
    min_confidence: float = Form(0.5),
    x_inference_token: str | None = Form(default=None),
) -> dict:
    if INFERENCE_TOKEN and x_inference_token != INFERENCE_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")
    data = await frame.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty frame")
    try:
        result = registry.infer(model=model, image_bytes=data, min_confidence=float(min_confidence))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result.to_dict()
