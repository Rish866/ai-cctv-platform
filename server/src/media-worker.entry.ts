import { MediaWorker } from './media/worker.js';
import { closePools } from './db/pool.js';
import { config } from './config.js';

/**
 * Media worker process entrypoint. Run SEPARATELY from the API:
 *   node dist/media-worker.entry.js   (or: tsx src/media-worker.entry.ts)
 *
 * It polls for enabled cameras and manages one FFmpeg pipeline per camera,
 * sending sampled frames to the inference service and detections to the API's
 * internal endpoint. It never serves HTTP and never exposes credentials.
 */
async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      worker: 'media',
      msg: 'starting',
      apiBaseUrl: config.media.apiBaseUrl,
      inferenceConfigured: Boolean(config.inference.serviceUrl),
      maxStreams: config.media.maxConcurrentStreams,
    }),
  );

  const worker = new MediaWorker();
  worker.start();

  const shutdown = async () => {
    worker.stop();
    await closePools();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ worker: 'media', fatal: String((err as Error).message) }));
  process.exit(1);
});
