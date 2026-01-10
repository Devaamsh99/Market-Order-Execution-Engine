import { Queue } from 'bullmq';
import type { QueueClient } from '../types';

export const ORDER_QUEUE_NAME = 'order-execution';
export const ORDER_JOB_NAME = 'execute-market-order';
export const ORDER_RATE_LIMIT_MAX = 100;
export const ORDER_RATE_LIMIT_DURATION_MS = 60_000;

/**
 * Retry/backoff is orchestrated inside the worker (so it can be unit-tested hermetically).
 * BullMQ job attempts are kept at 1 to avoid double-retry behavior.
 */
export const BULLMQ_JOB_ATTEMPTS = 1;

export function createOrderQueue(connection: unknown): Queue {
  return new Queue(ORDER_QUEUE_NAME, {
    connection: connection as any,
    defaultJobOptions: {
      attempts: BULLMQ_JOB_ATTEMPTS,
      removeOnComplete: 1000,
      removeOnFail: 1000
    }
  });
}

export class BullMqQueueClient implements QueueClient {
  private readonly queue: Queue;

  public constructor(queue: Queue) {
    this.queue = queue;
  }

  public async enqueue(order: { orderId: string }): Promise<void> {
    await this.queue.add(
      ORDER_JOB_NAME,
      { orderId: order.orderId },
      {
        jobId: order.orderId
      }
    );
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}

