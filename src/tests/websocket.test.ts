import WebSocket from 'ws';
import { buildServer } from '../server';
import { createHermeticPgMemDb } from '../db';
import {
  InMemoryActiveOrderStore,
  InMemoryEventBus,
  InMemorySocketMappingStore
} from '../services/orderService';
import type { ExecuteOrderResponse, Logger, OrderEvent, QueueClient } from '../types';
import { MockDexRouter } from '../dex/mockDexRouter';
import { executeOrderJob } from '../queue/orderWorker';

function noopLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

class FakeQueueClient implements QueueClient {
  public readonly enqueued: string[] = [];
  public async enqueue(payload: { orderId: string }): Promise<void> {
    this.enqueued.push(payload.orderId);
  }
  public async close(): Promise<void> {}
}

async function startHermeticServer() {
  const logger = noopLogger();
  const db = createHermeticPgMemDb();
  const activeStore = new InMemoryActiveOrderStore();
  const socketMapping = new InMemorySocketMappingStore();
  const eventBus = new InMemoryEventBus();
  const queue = new FakeQueueClient();

  const app = await buildServer({
    logger,
    db,
    queue,
    activeStore,
    socketMapping,
    eventBus,
    activeOrderTtlSeconds: 3600,
    startWorker: false,
    connectionForBullMq: {}
  });

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const url = new URL(address);
  const port = Number(url.port);

  return { app, port, deps: { logger, db, activeStore, socketMapping, eventBus, queue } };
}

function wsCollectStatuses(ws: WebSocket, out: string[]): void {
  ws.on('message', (data) => {
    const ev = JSON.parse(String(data)) as OrderEvent;
    out.push(ev.status);
  });
}

async function waitForStatus(out: string[], status: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (out.includes(status)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for status=${status}. Seen=${out.join(',')}`);
}

describe('WebSocket lifecycle streaming (hermetic)', () => {
  test('streams pending→routing→building→submitted→confirmed in order', async () => {
    const { app, port, deps } = await startHermeticServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/orders/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenIn: 'SOL', tokenOut: 'USDC', amount: 10, slippageBps: 50 })
      });
      const body = (await res.json()) as ExecuteOrderResponse;
      const statuses: string[] = [];

      const ws = new WebSocket(body.wsUrl);
      wsCollectStatuses(ws, statuses);

      await waitForStatus(statuses, 'pending');

      const router = new MockDexRouter({ logger: deps.logger, random: () => 0.5, sleepFn: async () => {} });
      await executeOrderJob(
        {
          connection: {},
          activeStore: deps.activeStore,
          eventBus: deps.eventBus,
          db: deps.db,
          router,
          logger: deps.logger,
          activeOrderTtlSeconds: 3600,
          sleeper: { sleep: async () => {} }
        },
        body.orderId
      );

      await waitForStatus(statuses, 'confirmed');
      expect(statuses).toEqual(['pending', 'routing', 'building', 'submitted', 'confirmed']);
      ws.close();
    } finally {
      await app.close();
    }
  });

  test('supports 3 simultaneous orders with isolated streams', async () => {
    const { app, port, deps } = await startHermeticServer();
    try {
      const created = await Promise.all(
        ['A', 'B', 'C'].map(async (suffix) => {
          const res = await fetch(`http://127.0.0.1:${port}/api/orders/execute`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              tokenIn: `SOL${suffix}`,
              tokenOut: `USDC${suffix}`,
              amount: 10,
              slippageBps: 50
            })
          });
          return (await res.json()) as ExecuteOrderResponse;
        })
      );

      const streams = created.map((o) => ({ orderId: o.orderId, wsUrl: o.wsUrl, statuses: [] as string[] }));
      const sockets = streams.map((s) => new WebSocket(s.wsUrl));
      sockets.forEach((ws, idx) => wsCollectStatuses(ws, streams[idx].statuses));

      await Promise.all(streams.map((s) => waitForStatus(s.statuses, 'pending')));

      const router = new MockDexRouter({ logger: deps.logger, random: () => 0.5, sleepFn: async () => {} });
      await Promise.all(
        streams.map((s) =>
          executeOrderJob(
            {
              connection: {},
              activeStore: deps.activeStore,
              eventBus: deps.eventBus,
              db: deps.db,
              router,
              logger: deps.logger,
              activeOrderTtlSeconds: 3600,
              sleeper: { sleep: async () => {} }
            },
            s.orderId
          )
        )
      );

      await Promise.all(streams.map((s) => waitForStatus(s.statuses, 'confirmed')));
      for (const s of streams) {
        expect(s.statuses).toEqual(['pending', 'routing', 'building', 'submitted', 'confirmed']);
      }

      sockets.forEach((ws) => ws.close());
    } finally {
      await app.close();
    }
  });

  test('failure propagates as pending→routing→failed and is persisted', async () => {
    const { app, port, deps } = await startHermeticServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/orders/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenIn: 'SOL', tokenOut: 'USDC', amount: 10, slippageBps: 50 })
      });
      const body = (await res.json()) as ExecuteOrderResponse;
      const statuses: string[] = [];

      const ws = new WebSocket(body.wsUrl);
      wsCollectStatuses(ws, statuses);
      await waitForStatus(statuses, 'pending');

      const failingRouter = {
        route: async () => {
          throw new Error('router boom');
        },
        executeSwap: async () => {
          throw new Error('swap boom');
        }
      } as unknown as MockDexRouter;

      await expect(
        executeOrderJob(
          {
            connection: {},
            activeStore: deps.activeStore,
            eventBus: deps.eventBus,
            db: deps.db,
            router: failingRouter,
            logger: deps.logger,
            activeOrderTtlSeconds: 3600,
            sleeper: { sleep: async () => {} }
          },
          body.orderId
        )
      ).rejects.toThrow(/router boom/);

      await waitForStatus(statuses, 'failed');
      expect(statuses).toEqual(['pending', 'routing', 'failed']);

      const rec = await deps.db.getOrder(body.orderId);
      expect(rec?.status).toBe('failed');
      expect(rec?.failureReason).toBe('router boom');

      ws.close();
    } finally {
      await app.close();
    }
  });

  test('WebSocket connect without orderId is rejected (1008)', async () => {
    const { app, port } = await startHermeticServer();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/orders/execute`);
      const close = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on('error', reject);
      });
      expect(close.code).toBe(1008);
    } finally {
      await app.close();
    }
  });
});

