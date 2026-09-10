# SentriAI Inference Service (FastAPI + OpenCV, optional ONNX Runtime).
FROM python:3.11-slim
WORKDIR /app
# OpenCV headless needs a few system libs.
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
