import { Worker, type Job } from 'bullmq';
import type { ActiveOrderStore, Db, EventBus, Logger, Order, OrderEvent, OrderStatus } from '../types';
import { MockDexRouter } from '../dex/mockDexRouter';
import { ORDER_QUEUE_NAME, ORDER_RATE_LIMIT_DURATION_MS, ORDER_RATE_LIMIT_MAX } from './orderQueue';

function nowMs(): number {
  return Date.now();
}

function lastStatus(events: OrderEvent[]): OrderStatus | null {
  if (events.length === 0) return null;
  return events[events.length - 1].status;
}

async function emitEvent(opts: {
  activeStore: ActiveOrderStore;
  eventBus: EventBus;
  ttlSeconds: number;
  event: OrderEvent;
}): Promise<void> {
  await opts.activeStore.appendEvent(opts.event.orderId, opts.event, opts.ttlSeconds);
  await opts.eventBus.publish(opts.event.orderId, opts.event);
}

function hasStatus(events: OrderEvent[], status: OrderStatus): boolean {
  return events.some((e) => e.status === status);
}

export const ORDER_WORKER_CONCURRENCY = 10;
export const ORDER_MAX_ATTEMPTS = 3;
export const ORDER_BACKOFF_BASE_MS = 1_000;

export function computeExponentialBackoffMs(attempt: number, baseMs = ORDER_BACKOFF_BASE_MS): number {
  // attempt is 1-based: attempt=1 means no previous failures; first retry waits baseMs.
  const exponent = Math.max(0, attempt - 2);
  return baseMs * Math.pow(2, exponent);
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export const realSleeper: Sleeper = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};

export interface OrderWorkerDeps {
  connection: unknown;
  activeStore: ActiveOrderStore;
  eventBus: EventBus;
  db: Db;
  router: MockDexRouter;
  logger: Logger;
  activeOrderTtlSeconds: number;
  sleeper?: Sleeper;
}

export async function processOrderOnce(deps: OrderWorkerDeps, order: Order): Promise<void> {
  const orderId = order.orderId;
  const events = await deps.activeStore.listEvents(orderId);
  const last = lastStatus(events);
  if (last === 'confirmed' || last === 'failed') return;

  if (!hasStatus(events, 'routing')) {
    await emitEvent({
      activeStore: deps.activeStore,
      eventBus: deps.eventBus,
      ttlSeconds: deps.activeOrderTtlSeconds,
      event: { orderId, status: 'routing', tsMs: nowMs() }
    });
  }

  const decision = await deps.router.route(order);

  if (!hasStatus(events, 'building')) {
    await emitEvent({
      activeStore: deps.activeStore,
      eventBus: deps.eventBus,
      ttlSeconds: deps.activeOrderTtlSeconds,
      event: { orderId, status: 'building', tsMs: nowMs() }
    });
  }

  await (deps.sleeper ?? realSleeper).sleep(150);

  if (!hasStatus(events, 'submitted')) {
    await emitEvent({
      activeStore: deps.activeStore,
      eventBus: deps.eventBus,
      ttlSeconds: deps.activeOrderTtlSeconds,
      event: { orderId, status: 'submitted', tsMs: nowMs() }
    });
  }

  const exec = await deps.router.executeSwap(decision.chosen.dex, order, decision.chosen.price);

  const updatedAtMs = nowMs();
  await deps.db.finalizeOrder({
    orderId,
    dex: exec.dex,
    executedPrice: exec.executedPrice,
    txHash: exec.txHash,
    updatedAtMs
  });

  const afterEvents = await deps.activeStore.listEvents(orderId);
  if (!hasStatus(afterEvents, 'confirmed')) {
    await emitEvent({
      activeStore: deps.activeStore,
      eventBus: deps.eventBus,
      ttlSeconds: deps.activeOrderTtlSeconds,
      event: {
        orderId,
        status: 'confirmed',
        tsMs: updatedAtMs,
        dex: exec.dex,
        executedPrice: exec.executedPrice,
        txHash: exec.txHash
      }
    });
  }
}

export async function runWithRetries(opts: {
  maxAttempts: number;
  baseBackoffMs: number;
  sleeper: Sleeper;
  logger: Logger;
  run: (attempt: number) => Promise<void>;
}): Promise<void> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      await opts.run(attempt);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isFinal = attempt >= opts.maxAttempts;
      if (isFinal) throw err;
      const waitMs = computeExponentialBackoffMs(attempt + 1, opts.baseBackoffMs);
      opts.logger.warn('retry.scheduled', { attempt, nextAttempt: attempt + 1, waitMs, error: msg });
      await opts.sleeper.sleep(waitMs);
    }
  }
}

export async function executeOrderJob(deps: OrderWorkerDeps, orderId: string): Promise<void> {
  const sleeper = deps.sleeper ?? realSleeper;
  const order = await deps.activeStore.getActiveOrder(orderId);
  if (!order) throw new Error(`Active order not found: ${orderId}`);

  try {
    await runWithRetries({
      maxAttempts: ORDER_MAX_ATTEMPTS,
      baseBackoffMs: ORDER_BACKOFF_BASE_MS,
      sleeper,
      logger: deps.logger,
      run: async () => {
        await processOrderOnce({ ...deps, sleeper }, order);
      }
    });
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    const updatedAtMs = nowMs();
    await deps.db.failOrder({ orderId, failureReason, updatedAtMs });

    const events = await deps.activeStore.listEvents(orderId);
    if (!hasStatus(events, 'failed')) {
      await emitEvent({
        activeStore: deps.activeStore,
        eventBus: deps.eventBus,
        ttlSeconds: deps.activeOrderTtlSeconds,
        event: { orderId, status: 'failed', tsMs: updatedAtMs, error: failureReason }
      });
    }
    throw err;
  }
}

export function createOrderWorker(deps: OrderWorkerDeps): Worker {
  const worker = new Worker(
    ORDER_QUEUE_NAME,
    async (job: Job<{ orderId: string }>) => {
      await executeOrderJob(deps, job.data.orderId);
    },
    {
      connection: deps.connection as any,
      concurrency: ORDER_WORKER_CONCURRENCY,
      limiter: { max: ORDER_RATE_LIMIT_MAX, duration: ORDER_RATE_LIMIT_DURATION_MS }
    } as any
  );

  worker.on('completed', (job) => {
    deps.logger.info('job.completed', { orderId: job.data.orderId });
  });

  worker.on('error', (err) => {
    deps.logger.error('worker.error', { err: err?.message ?? String(err) });
  });

  return worker;
}

