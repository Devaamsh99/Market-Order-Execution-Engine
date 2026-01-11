import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import IORedis from 'ioredis';

import type { ActiveOrderStore, Db, EventBus, Logger, QueueClient, SocketMappingStore } from './types';
import { createOrdersApi } from './api/orders';
import { createOrderSocket } from './ws/orderSocket';
import { createRuntimePgDb } from './db';
import {
  createConsoleLogger,
  RedisActiveOrderStore,
  RedisPubSubEventBus,
  RedisSocketMappingStore
} from './services/orderService';
import { MockDexRouter } from './dex/mockDexRouter';
import { BullMqQueueClient, createOrderQueue } from './queue/orderQueue';
import { createOrderWorker } from './queue/orderWorker';

export interface ServerDeps {
  logger: Logger;
  db: Db;
  queue: QueueClient;
  activeStore: ActiveOrderStore;
  socketMapping: SocketMappingStore;
  eventBus: EventBus;
  activeOrderTtlSeconds: number;
  startWorker: boolean;
  connectionForBullMq: unknown;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
    
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  await deps.db.initSchema();

  await app.register(createOrdersApi(deps), {});
  await app.register(
    createOrderSocket({
      logger: deps.logger,
      activeStore: deps.activeStore,
      socketMapping: deps.socketMapping,
      eventBus: deps.eventBus,
      activeOrderTtlSeconds: deps.activeOrderTtlSeconds
    }),
    {}
  );

  if (deps.startWorker) {
    const router = new MockDexRouter({ logger: deps.logger });
    const worker = createOrderWorker({
      connection: deps.connectionForBullMq,
      activeStore: deps.activeStore,
      eventBus: deps.eventBus,
      db: deps.db,
      router,
      logger: deps.logger,
      activeOrderTtlSeconds: deps.activeOrderTtlSeconds
    });

    app.addHook('onClose', async () => {
      await worker.close();
    });
  }

  app.addHook('onClose', async () => {
    await deps.queue.close();
    await deps.eventBus.close();
    await deps.db.close();
  });

  return app;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) throw new Error(`Missing env var: ${name}`);
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function start(): Promise<void> {
  const logger = createConsoleLogger();
  const port = optionalInt('PORT', 3000);
  const redisUrl = requireEnv('REDIS_URL');
  const databaseUrl = requireEnv('DATABASE_URL');
  const ttlSeconds = optionalInt('ACTIVE_ORDER_TTL_SECONDS', 3600);

  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const db = createRuntimePgDb(databaseUrl);
  const activeStore = new RedisActiveOrderStore(redis as any);
  const socketMapping = new RedisSocketMappingStore(redis as any);
  const eventBus = new RedisPubSubEventBus(redis as any);

  const queue = createOrderQueue(redis as any);
  const queueClient = new BullMqQueueClient(queue);

  const app = await buildServer({
    logger,
    db,
    queue: queueClient,
    activeStore,
    socketMapping,
    eventBus,
    activeOrderTtlSeconds: ttlSeconds,
    startWorker: true,
    connectionForBullMq: redis as any
  });

  try {
    await app.listen({ port, host: '0.0.0.0' });
    logger.info('server.started', { port });
  } catch (err) {
    logger.error('server.failed_to_start', { err: String(err) });
    await app.close();
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void start();
}

