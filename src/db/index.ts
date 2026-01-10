import { Pool } from 'pg';
const { newDb } = require('pg-mem');
import type { Db, DexName, Order, OrderFinalRecord } from '../types';

export const createSchemaSql = `
CREATE TABLE IF NOT EXISTS order_history (
  order_id TEXT PRIMARY KEY,
  order_type TEXT NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  slippage_bps INTEGER NOT NULL,
  status TEXT NOT NULL,
  dex_chosen TEXT NULL,
  executed_price NUMERIC NULL,
  tx_hash TEXT NULL,
  failure_reason TEXT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_history_status ON order_history(status);
CREATE INDEX IF NOT EXISTS idx_order_history_created_at ON order_history(created_at_ms);
`.trim();

function mapRowToOrder(row: any): OrderFinalRecord {
  const dex =
    row.dex_chosen === 'raydium' || row.dex_chosen === 'meteora' ? (row.dex_chosen as DexName) : null;
  return {
    orderId: String(row.order_id),
    type: row.order_type,
    tokenIn: String(row.token_in),
    tokenOut: String(row.token_out),
    amount: Number(row.amount),
    slippageBps: Number(row.slippage_bps),
    status: row.status,
    dexChosen: dex,
    executedPrice: row.executed_price === null ? null : Number(row.executed_price),
    txHash: row.tx_hash ? String(row.tx_hash) : null,
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms)
  };
}

export class PgDb implements Db {
  private readonly pool: Pool;

  public constructor(pool: Pool) {
    this.pool = pool;
  }

  public async initSchema(): Promise<void> {
    await this.pool.query(createSchemaSql);
  }

  public async insertOrder(order: Order): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO order_history (
        order_id, order_type, token_in, token_out, amount, slippage_bps,
        status, dex_chosen, executed_price, tx_hash, failure_reason,
        created_at_ms, updated_at_ms
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,$8,$9)
      ON CONFLICT (order_id) DO NOTHING
      `,
      [
        order.orderId,
        order.type,
        order.tokenIn,
        order.tokenOut,
        order.amount,
        order.slippageBps,
        'pending',
        order.createdAtMs,
        order.createdAtMs
      ]
    );
  }

  public async finalizeOrder(result: {
    orderId: string;
    dex: string;
    executedPrice: number;
    txHash: string;
    updatedAtMs: number;
  }): Promise<void> {
    await this.pool.query(
      `
      UPDATE order_history
      SET status = 'confirmed',
          dex_chosen = $2,
          executed_price = $3,
          tx_hash = $4,
          failure_reason = NULL,
          updated_at_ms = $5
      WHERE order_id = $1
      `,
      [result.orderId, result.dex, result.executedPrice, result.txHash, result.updatedAtMs]
    );
  }

  public async failOrder(result: { orderId: string; failureReason: string; updatedAtMs: number }): Promise<void> {
    await this.pool.query(
      `
      UPDATE order_history
      SET status = 'failed',
          failure_reason = $2,
          updated_at_ms = $3
      WHERE order_id = $1
      `,
      [result.orderId, result.failureReason, result.updatedAtMs]
    );
  }

  public async getOrder(orderId: string): Promise<OrderFinalRecord | null> {
    const res = await this.pool.query(`SELECT * FROM order_history WHERE order_id = $1`, [orderId]);
    if (res.rows.length === 0) return null;
    return mapRowToOrder(res.rows[0]);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createRuntimePgDb(databaseUrl: string): PgDb {
  const pool = new Pool({ connectionString: databaseUrl });
  return new PgDb(pool);
}

export class PgMemDb implements Db {
  private readonly inner: PgDb;

  public constructor(inner: PgDb) {
    this.inner = inner;
  }

  public async initSchema(): Promise<void> {
    await this.inner.initSchema();
  }

  public async insertOrder(order: Order): Promise<void> {
    await this.inner.insertOrder(order);
  }

  public async finalizeOrder(result: {
    orderId: string;
    dex: string;
    executedPrice: number;
    txHash: string;
    updatedAtMs: number;
  }): Promise<void> {
    await this.inner.finalizeOrder(result);
  }

  public async failOrder(result: { orderId: string; failureReason: string; updatedAtMs: number }): Promise<void> {
    await this.inner.failOrder(result);
  }

  public async getOrder(orderId: string): Promise<OrderFinalRecord | null> {
    return await this.inner.getOrder(orderId);
  }

  public async close(): Promise<void> {
    await this.inner.close();
  }
}

export function createHermeticPgMemDb(): Db {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  return new PgMemDb(new PgDb(pool as unknown as Pool));
}

