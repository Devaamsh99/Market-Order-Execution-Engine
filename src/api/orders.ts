import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type {
  ActiveOrderStore,
  Db,
  EventBus,
  ExecuteOrderRequest,
  ExecuteOrderResponse,
  Logger,
  Order,
  OrderEvent,
  QueueClient
} from '../types';

export interface OrdersApiDeps {
  logger: Logger;
  db: Db;
  queue: QueueClient;
  activeStore: ActiveOrderStore;
  eventBus: EventBus;
  activeOrderTtlSeconds: number;
}

function nowMs(): number {
  return Date.now();
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateExecuteOrder(body: unknown): { ok: true; value: ExecuteOrderRequest } | { ok: false; error: string } {
  const b = body as Partial<ExecuteOrderRequest> | null;
  if (!b || typeof b !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  if (!isNonEmptyString(b.tokenIn)) return { ok: false, error: 'tokenIn is required' };
  if (!isNonEmptyString(b.tokenOut)) return { ok: false, error: 'tokenOut is required' };
  if (!isFiniteNumber(b.amount) || b.amount <= 0) return { ok: false, error: 'amount must be a positive number' };
  if (!isFiniteNumber(b.slippageBps) || b.slippageBps < 0 || b.slippageBps > 10_000) {
    return { ok: false, error: 'slippageBps must be between 0 and 10000' };
  }
  return { ok: true, value: { tokenIn: b.tokenIn, tokenOut: b.tokenOut, amount: b.amount, slippageBps: b.slippageBps } };
}

async function emitPending(deps: OrdersApiDeps, orderId: string): Promise<void> {
  const event: OrderEvent = { orderId, status: 'pending', tsMs: nowMs() };
  await deps.activeStore.appendEvent(orderId, event, deps.activeOrderTtlSeconds);
  await deps.eventBus.publish(orderId, event);
}

function computeWsUrl(req: FastifyRequest, orderId: string): string {
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  return `${wsProto}://${host}/api/orders/execute?orderId=${encodeURIComponent(orderId)}`;
}

export function createOrdersApi(deps: OrdersApiDeps): FastifyPluginCallback {
  return (fastify: FastifyInstance, _opts, done) => {
    fastify.post<{ Body: ExecuteOrderRequest; Reply: ExecuteOrderResponse | { error: string } }>(
      '/api/orders/execute',
      async (req, reply) => {
        const validation = validateExecuteOrder(req.body);
        if (!validation.ok) {
          return reply.status(400).send({ error: validation.error });
        }

        const orderId = uuidv4();
        const createdAtMs = nowMs();
        const order: Order = {
          orderId,
          type: 'market',
          tokenIn: validation.value.tokenIn,
          tokenOut: validation.value.tokenOut,
          amount: validation.value.amount,
          slippageBps: validation.value.slippageBps,
          createdAtMs
        };

        await deps.activeStore.putActiveOrder(order, deps.activeOrderTtlSeconds);
        await deps.db.insertOrder(order);
        await deps.queue.enqueue({ orderId });

        // IMPORTANT: per requirements, `pending` is emitted from the API immediately after enqueue.
        await emitPending(deps, orderId);

        const wsUrl = computeWsUrl(req, orderId);
        deps.logger.info('order.submitted', { orderId, wsUrl });
        return reply.status(200).send({ orderId, wsUrl });
      }
    );

    done();
  };
}

