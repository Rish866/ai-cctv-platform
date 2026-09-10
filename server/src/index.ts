import { createServer } from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { attachWebSockets } from './realtime/ws.js';
import { runMigrations } from './db/migrate.js';
import { closePools } from './db/pool.js';

async function main(): Promise<void> {
  // Ensure schema is up to date on boot.
  await runMigrations();

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
