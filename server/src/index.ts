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

  // AI adapter policy (fail closed, no fake production AI):
  //   * production: register ONLY the real inference adapters. If no inference
  //     service is configured, refuse to start rather than run without real AI
  //     (the pipeline would otherwise fail closed with INFERENCE_UNAVAILABLE).
  //   * non-production: register the explicitly-labelled DEMO adapters, plus the
  //     real adapters if a service URL happens to be configured. The demo
  //     adapter can NEVER run in production.
  if (config.env === 'production') {
    if (!config.inference.serviceUrl) {
      throw new Error(
        'Refusing to start in production without INFERENCE_SERVICE_URL. The demo ' +
          'AI adapter is disabled in production; a real inference service is required.',
      );
    }
    registerProductionAdapters();
  } else {
    registerDemoAdapters();
    if (config.inference.serviceUrl) registerProductionAdapters();
  }

  const app = createApp();
  const server = createServer(app);
  attachWebSockets(server);

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`SentriAI API listening on :${config.port} (env=${config.env})`);
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
