import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { ActiveOrderStore, EventBus, Logger, OrderEvent, OrderStatus, SocketMappingStore } from '../types';

export interface OrderSocketDeps {
  logger: Logger;
  activeStore: ActiveOrderStore;
  socketMapping: SocketMappingStore;
  eventBus: EventBus;
  activeOrderTtlSeconds: number;
}

const statusRank: Record<OrderStatus, number> = {
  pending: 1,
  routing: 2,
  building: 3,
  submitted: 4,
  confirmed: 5,
  failed: 6
};

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sortByLifecycle(a: OrderEvent, b: OrderEvent): number {
  return statusRank[a.status] - statusRank[b.status];
}

export function createOrderSocket(deps: OrderSocketDeps): FastifyPluginCallback {
  return (fastify: FastifyInstance, _opts, done) => {
    fastify.get(
      '/api/orders/execute',
      { websocket: true },
      async (socket: WebSocket, req) => {
        const orderId = typeof (req.query as any)?.orderId === 'string' ? String((req.query as any).orderId) : '';
        if (!orderId) {
          socket.close(1008, 'orderId is required');
          return;
        }

        const connectionId = uuidv4();
        await deps.socketMapping.add(orderId, connectionId, deps.activeOrderTtlSeconds);
        deps.logger.info('ws.connected', { orderId, connectionId });

        const sent = new Set<OrderStatus>();
        let backlogFlushed = false;
        const buffer: OrderEvent[] = [];

        const unsubscribe = await deps.eventBus.subscribe(orderId, (event) => {
          if (sent.has(event.status)) return;
          if (!backlogFlushed) {
            buffer.push(event);
            return;
          }
          sent.add(event.status);
          safeSend(socket, event);
        });

        // Send backlog from Redis/in-memory store so late subscribers still receive full lifecycle.
        const backlog = await deps.activeStore.listEvents(orderId);
        backlog.sort(sortByLifecycle);
        for (const ev of backlog) {
          if (sent.has(ev.status)) continue;
          sent.add(ev.status);
          safeSend(socket, ev);
        }

        backlogFlushed = true;
        buffer.sort(sortByLifecycle);
        for (const ev of buffer) {
          if (sent.has(ev.status)) continue;
          sent.add(ev.status);
          safeSend(socket, ev);
        }

        socket.on('close', async () => {
          try {
            await unsubscribe();
          } catch {
            // ignore
          }
          try {
            await deps.socketMapping.remove(orderId, connectionId);
          } catch {
            // ignore
          }
          deps.logger.info('ws.closed', { orderId, connectionId });
        });
      }
    );

    done();
  };
}

