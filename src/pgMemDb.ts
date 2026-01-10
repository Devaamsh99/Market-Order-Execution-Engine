import { newDb } from 'pg-mem';
import type { Db } from '../types';

export function createPgMemDb(): Db {
  const mem = newDb();
  // test-only implementation
  return {
    /* ... */
  };
}
