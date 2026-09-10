# SentriAI API + built web UI (single image). Also used for the media worker
# (different command). Includes FFmpeg for RTSP probing/ingest/HLS.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# FFmpeg + ffprobe for real RTSP connectivity, ingest and HLS transcoding.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev
# Built artifacts.
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
EXPOSE 4000
# Default: API (serves the built SPA). Override command for the media worker.
CMD ["node", "server/dist/index.js"]
