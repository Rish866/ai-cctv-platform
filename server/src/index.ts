import { createServer } from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { attachWebSockets } from './realtime/ws.js';
import { runMigrations } from './db/migrate.js';
import { closePools } from './db/pool.js';
import { registerDemoAdapters } from './ai/model.js';
import { registerProductionAdapters } from './ai/production-adapter.js';

async function main(): Promise<void> {
  // Ensure schema is up to date on boot.
  await runMigrations();

  // AI adapter policy (never any fake production AI):
  //   * production + REQUIRE_INFERENCE=true: register ONLY real inference
  //     adapters, and REFUSE to start without INFERENCE_SERVICE_URL (full
  //     fail-closed CCTV deployment).
  //   * production + REQUIRE_INFERENCE not set: register the real adapter IF a
  //     service URL is configured; otherwise boot with NO AI adapter and report
  //     "Inference Offline" (lets the SaaS run on a free API host while the
  //     camera/AI pipeline runs elsewhere). The demo adapter is NEVER used in
  //     production.
  //   * non-production: register the DEMO adapters (+ real if a URL is set).
  if (config.env === 'production') {
    if (config.inference.require && !config.inference.serviceUrl) {
      throw new Error(
        'REQUIRE_INFERENCE=true but INFERENCE_SERVICE_URL is not set. A real ' +
          'inference service is required for full CCTV mode. Unset REQUIRE_INFERENCE ' +
          'to run the SaaS without live AI (status will show Inference Offline).',
      );
    }
    if (config.inference.serviceUrl) registerProductionAdapters();
    // No serviceUrl + not required => no adapters registered; pipeline reports
    // INFERENCE_UNAVAILABLE if invoked. Demo adapter stays disabled in prod.
  } else {
    registerDemoAdapters();
    if (config.inference.serviceUrl) registerProductionAdapters();
  }

  const app = createApp();
  const server = createServer(app);
  attachWebSockets(server);

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`GarudAI API listening on :${config.port} (env=${config.env})`);
  });

  const shutdown = async () => {
    server.close();
    await closePools();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', err);
  process.exit(1);
});
