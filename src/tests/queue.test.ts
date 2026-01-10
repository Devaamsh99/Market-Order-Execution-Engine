import type { Logger, Order } from '../types';
import { InMemoryActiveOrderStore, InMemoryEventBus } from '../services/orderService';
import { createHermeticPgMemDb } from '../db';
import {
  computeExponentialBackoffMs,
  executeOrderJob,
  ORDER_BACKOFF_BASE_MS,
  ORDER_MAX_ATTEMPTS,
  ORDER_WORKER_CONCURRENCY,
  runWithRetries
} from '../queue/orderWorker';
import { BULLMQ_JOB_ATTEMPTS, ORDER_RATE_LIMIT_DURATION_MS, ORDER_RATE_LIMIT_MAX } from '../queue/orderQueue';
import { MockDexRouter } from '../dex/mockDexRouter';

function noopLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: overrides.orderId ?? 'order-1',
    type: 'market',
    tokenIn: overrides.tokenIn ?? 'SOL',
    tokenOut: overrides.tokenOut ?? 'USDC',
    amount: overrides.amount ?? 100,
    slippageBps: overrides.slippageBps ?? 50,
    createdAtMs: overrides.createdAtMs ?? 1
  };
}

describe('Queue/worker configuration and retry orchestration (hermetic)', () => {
  test('rate limiter is 100 orders/min (constants)', () => {
    expect(ORDER_RATE_LIMIT_MAX).toBe(100);
    expect(ORDER_RATE_LIMIT_DURATION_MS).toBe(60_000);
  });

  test('worker concurrency is 10 (constant)', () => {
    expect(ORDER_WORKER_CONCURRENCY).toBe(10);
  });

  test('BullMQ attempts is 1 because retries are orchestrated in worker', () => {
    expect(BULLMQ_JOB_ATTEMPTS).toBe(1);
    expect(ORDER_MAX_ATTEMPTS).toBe(3);
    expect(ORDER_BACKOFF_BASE_MS).toBe(1000);
  });

  test('computeExponentialBackoffMs grows exponentially (1000, 2000, 4000...)', () => {
    expect(computeExponentialBackoffMs(2, 1000)).toBe(1000);
    expect(computeExponentialBackoffMs(3, 1000)).toBe(2000);
    expect(computeExponentialBackoffMs(4, 1000)).toBe(4000);
  });

  test('runWithRetries sleeps 1000ms then 2000ms for a success on 3rd attempt', async () => {
    const waits: number[] = [];
    const sleeper = {
      sleep: async (ms: number) => {
        waits.push(ms);
      }
    };
    let calls = 0;

    await runWithRetries({
      maxAttempts: 3,
      baseBackoffMs: 1000,
      sleeper,
      logger: noopLogger(),
      run: async () => {
        calls++;
        if (calls < 3) throw new Error('boom');
      }
    });

    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  test('runWithRetries throws after max attempts and sleeps for each scheduled retry', async () => {
    const waits: number[] = [];
    const sleeper = {
      sleep: async (ms: number) => {
        waits.push(ms);
      }
    };

    await expect(
      runWithRetries({
        maxAttempts: 3,
        baseBackoffMs: 1000,
        sleeper,
        logger: noopLogger(),
        run: async () => {
          throw new Error('nope');
        }
      })
    ).rejects.toThrow('nope');

    // two waits: before attempt 2 and attempt 3
    expect(waits).toEqual([1000, 2000]);
  });

  test('executeOrderJob persists confirmed on success', async () => {
    const db = createHermeticPgMemDb();
    await db.initSchema();

    const activeStore = new InMemoryActiveOrderStore();
    const eventBus = new InMemoryEventBus();
    const logger = noopLogger();
    const order = makeOrder({ orderId: 'order-ok' });
    await activeStore.putActiveOrder(order, 3600);
    await db.insertOrder(order);

    const router = new MockDexRouter({ logger, random: () => 0.5, sleepFn: async () => {} });

    await executeOrderJob(
      {
        connection: {},
        activeStore,
        eventBus,
        db,
        router,
        logger,
        activeOrderTtlSeconds: 3600,
        sleeper: { sleep: async () => {} }
      },
      order.orderId
    );

    const stored = await db.getOrder(order.orderId);
    expect(stored?.status).toBe('confirmed');
    expect(stored?.txHash).toBeTruthy();
    expect(stored?.executedPrice).toBeTruthy();
    expect(stored?.dexChosen).toBeTruthy();
  });

  test('executeOrderJob persists final failure and emits failed after max attempts', async () => {
    const db = createHermeticPgMemDb();
    await db.initSchema();

    const activeStore = new InMemoryActiveOrderStore();
    const eventBus = new InMemoryEventBus();
    const logger = noopLogger();
    const order = makeOrder({ orderId: 'order-fail' });
    await activeStore.putActiveOrder(order, 3600);
    await db.insertOrder(order);

    // Router that always fails.
    const router = {
      route: async () => {
        throw new Error('routing failed');
      },
      executeSwap: async () => {
        throw new Error('swap failed');
      }
    } as unknown as MockDexRouter;

    const events: string[] = [];
    await eventBus.subscribe(order.orderId, (ev) => events.push(ev.status));

    await expect(
      executeOrderJob({
        connection: {},
        activeStore,
        eventBus,
        db,
        router,
        logger,
        activeOrderTtlSeconds: 3600,
        sleeper: { sleep: async () => {} }
      }, order.orderId)
    ).rejects.toThrow(/routing failed/);

    const stored = await db.getOrder(order.orderId);
    expect(stored?.status).toBe('failed');
    expect(stored?.failureReason).toBe('routing failed');
    expect(events).toContain('failed');
  });
});

