import pg from 'pg';
import { migrate } from '../src/migrate.js';

// Integration tests run against the Postgres and MinIO from docker compose:
//   docker compose up -d postgres minio && npm test
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://bakers:bakers@localhost:5432/bakers_math_test';

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  await migrate(pool, () => {});
  await pool.end();
}
