import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import type { Db } from './types';
import { PgDb } from './db';

export function createPgMemDb(): Db {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();

  return new PgDb(pool as unknown as Pool);
}
