import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { createS3Storage } from './lib/storage.js';

const pool = createPool();
const storage = createS3Storage();
const app = buildApp({ pool, storage });

async function main() {
  await migrate(pool, (msg) => app.log.info(msg));
  await storage.ensureBucket();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
