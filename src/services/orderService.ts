import type {
  ActiveOrderStore,
  EventBus,
  Logger,
  Order,
  OrderEvent,
  SocketMappingStore
} from '../types';

export class InMemoryActiveOrderStore implements ActiveOrderStore {
  private readonly orders = new Map<string, Order>();
  private readonly events = new Map<string, OrderEvent[]>();

  public async putActiveOrder(order: Order, _ttlSeconds: number): Promise<void> {
    this.orders.set(order.orderId, order);
    if (!this.events.has(order.orderId)) this.events.set(order.orderId, []);
  }

  public async getActiveOrder(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  public async appendEvent(orderId: string, event: OrderEvent, _ttlSeconds: number): Promise<void> {
    const list = this.events.get(orderId) ?? [];
    list.push(event);
    this.events.set(orderId, list);
  }

  public async listEvents(orderId: string): Promise<OrderEvent[]> {
    return [...(this.events.get(orderId) ?? [])];
  }

  public async clear(orderId: string): Promise<void> {
    this.orders.delete(orderId);
    this.events.delete(orderId);
  }
}

export class InMemorySocketMappingStore implements SocketMappingStore {
  private readonly m = new Map<string, Set<string>>();

  public async add(orderId: string, connectionId: string, _ttlSeconds: number): Promise<void> {
    const set = this.m.get(orderId) ?? new Set<string>();
    set.add(connectionId);
    this.m.set(orderId, set);
  }

  public async remove(orderId: string, connectionId: string): Promise<void> {
    const set = this.m.get(orderId);
    if (!set) return;
    set.delete(connectionId);
  }

  public async list(orderId: string): Promise<string[]> {
    return [...(this.m.get(orderId) ?? new Set<string>())];
  }
}

export function createConsoleLogger(): Logger {
  return {
    info: (msg: string, meta?: Record<string, unknown>) =>
      meta ? console.log(msg, meta) : console.log(msg),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      meta ? console.warn(msg, meta) : console.warn(msg),
    error: (msg: string, meta?: Record<string, unknown>) =>
      meta ? console.error(msg, meta) : console.error(msg)
  };
}

export function orderActiveKey(orderId: string): string {
  return `active:order:${orderId}`;
}
export function orderEventsKey(orderId: string): string {
  return `active:order:${orderId}:events`;
}
export function orderSocketsKey(orderId: string): string {
  return `active:order:${orderId}:sockets`;
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<'OK' | null>;
  expire(key: string, seconds: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  quit(): Promise<void>;
  disconnect(): void;
  duplicate(): RedisLike;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<number>;
  unsubscribe(channel: string): Promise<number>;
  on(event: 'message', listener: (channel: string, message: string) => void): this;
}

export class RedisActiveOrderStore implements ActiveOrderStore {
  private readonly redis: RedisLike;

  public constructor(redis: RedisLike) {
    this.redis = redis;
  }

  public async putActiveOrder(order: Order, ttlSeconds: number): Promise<void> {
    const key = orderActiveKey(order.orderId);
    await this.redis.set(key, JSON.stringify(order));
    await this.redis.expire(key, ttlSeconds);
    // Events list will be created on first append. We only ensure it expires once it exists.
  }

  public async getActiveOrder(orderId: string): Promise<Order | null> {
    const raw = await this.redis.get(orderActiveKey(orderId));
    if (!raw) return null;
    return JSON.parse(raw) as Order;
  }

  public async appendEvent(orderId: string, event: OrderEvent, ttlSeconds: number): Promise<void> {
    const key = orderEventsKey(orderId);
    await this.redis.rpush(key, JSON.stringify(event));
    await this.redis.expire(key, ttlSeconds);
  }

  public async listEvents(orderId: string): Promise<OrderEvent[]> {
    const items = await this.redis.lrange(orderEventsKey(orderId), 0, -1);
    return items.map((s) => JSON.parse(s) as OrderEvent);
  }

  public async clear(orderId: string): Promise<void> {
    await this.redis.del(orderActiveKey(orderId), orderEventsKey(orderId), orderSocketsKey(orderId));
  }
}

export class RedisSocketMappingStore implements SocketMappingStore {
  private readonly redis: RedisLike;

  public constructor(redis: RedisLike) {
    this.redis = redis;
  }

  public async add(orderId: string, connectionId: string, ttlSeconds: number): Promise<void> {
    const key = orderSocketsKey(orderId);
    await this.redis.sadd(key, connectionId);
    await this.redis.expire(key, ttlSeconds);
  }

  public async remove(orderId: string, connectionId: string): Promise<void> {
    await this.redis.srem(orderSocketsKey(orderId), connectionId);
  }

  public async list(orderId: string): Promise<string[]> {
    return await this.redis.smembers(orderSocketsKey(orderId));
  }
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<(ev: OrderEvent) => void>>();

  public async publish(orderId: string, event: OrderEvent): Promise<void> {
    const set = this.handlers.get(orderId);
    if (!set) return;
    for (const h of set) h(event);
  }

  public async subscribe(orderId: string, onEvent: (event: OrderEvent) => void): Promise<() => Promise<void>> {
    const set = this.handlers.get(orderId) ?? new Set<(ev: OrderEvent) => void>();
    set.add(onEvent);
    this.handlers.set(orderId, set);
    return async () => {
      const cur = this.handlers.get(orderId);
      if (!cur) return;
      cur.delete(onEvent);
    };
  }

  public async close(): Promise<void> {
    this.handlers.clear();
  }
}

export class RedisPubSubEventBus implements EventBus {
  private readonly pub: RedisLike;
  private readonly sub: RedisLike;
  private readonly handlers = new Map<string, Set<(ev: OrderEvent) => void>>();

  public constructor(redis: RedisLike) {
    this.pub = redis;
    this.sub = redis.duplicate();
    this.sub.on('message', (channel, message) => {
      const orderId = channel.replace(/^order-events:/, '');
      const ev = JSON.parse(message) as OrderEvent;
      const set = this.handlers.get(orderId);
      if (!set) return;
      for (const h of set) h(ev);
    });
  }

  private channel(orderId: string): string {
    return `order-events:${orderId}`;
  }

  public async publish(orderId: string, event: OrderEvent): Promise<void> {
    await this.pub.publish(this.channel(orderId), JSON.stringify(event));
  }

  public async subscribe(orderId: string, onEvent: (event: OrderEvent) => void): Promise<() => Promise<void>> {
    const key = orderId;
    const set = this.handlers.get(key) ?? new Set<(ev: OrderEvent) => void>();
    const wasEmpty = set.size === 0;
    set.add(onEvent);
    this.handlers.set(key, set);
    if (wasEmpty) {
      await this.sub.subscribe(this.channel(orderId));
    }

    return async () => {
      const cur = this.handlers.get(key);
      if (!cur) return;
      cur.delete(onEvent);
      if (cur.size === 0) {
        await this.sub.unsubscribe(this.channel(orderId));
      }
    };
  }

  public async close(): Promise<void> {
    this.handlers.clear();
    try {
      await this.sub.quit();
    } catch {
      // ignore
    }
    try {
      await this.pub.quit();
    } catch {
      // ignore
    }
  }
}

