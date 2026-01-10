export type OrderType = 'market';

export type DexName = 'raydium' | 'meteora';

export type OrderStatus =
  | 'pending'
  | 'routing'
  | 'building'
  | 'submitted'
  | 'confirmed'
  | 'failed';

export interface ExecuteOrderRequest {
  tokenIn: string;
  tokenOut: string;
  amount: number;
  /**
   * Basis points. Example: 50 = 0.50%
   */
  slippageBps: number;
}

export interface ExecuteOrderResponse {
  orderId: string;
  wsUrl: string;
}

export interface Order {
  orderId: string;
  type: OrderType;
  tokenIn: string;
  tokenOut: string;
  amount: number;
  slippageBps: number;
  createdAtMs: number;
}

export interface DexQuote {
  dex: DexName;
  /**
   * Unit price (tokenOut per tokenIn). For mock purposes this is arbitrary but consistent.
   */
  price: number;
  /**
   * Fee rate (e.g. 0.003 for 0.3%)
   */
  feeRate: number;
  /**
   * Effective price after fees, used for routing decision.
   */
  effectivePrice: number;
}

export interface RoutingDecision {
  raydium: DexQuote;
  meteora: DexQuote;
  chosen: DexQuote;
}

export interface SwapExecutionResult {
  dex: DexName;
  executedPrice: number;
  txHash: string;
}

export interface OrderEventBase {
  orderId: string;
  status: OrderStatus;
  tsMs: number;
}

export type OrderEvent =
  | (OrderEventBase & { status: 'pending' })
  | (OrderEventBase & { status: 'routing' })
  | (OrderEventBase & { status: 'building' })
  | (OrderEventBase & { status: 'submitted' })
  | (OrderEventBase & { status: 'confirmed'; txHash: string; dex: DexName; executedPrice: number })
  | (OrderEventBase & { status: 'failed'; error: string });

export interface OrderFinalRecord {
  orderId: string;
  type: OrderType;
  tokenIn: string;
  tokenOut: string;
  amount: number;
  slippageBps: number;
  status: OrderStatus;
  dexChosen: DexName | null;
  executedPrice: number | null;
  txHash: string | null;
  failureReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface EventBus {
  publish(orderId: string, event: OrderEvent): Promise<void>;
  subscribe(orderId: string, onEvent: (event: OrderEvent) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface ActiveOrderStore {
  putActiveOrder(order: Order, ttlSeconds: number): Promise<void>;
  getActiveOrder(orderId: string): Promise<Order | null>;
  appendEvent(orderId: string, event: OrderEvent, ttlSeconds: number): Promise<void>;
  listEvents(orderId: string): Promise<OrderEvent[]>;
  clear(orderId: string): Promise<void>;
}

export interface SocketMappingStore {
  /**
   * Persists metadata mapping from orderId to a connectionId for audit/visibility purposes.
   * Actual WebSocket objects are tracked in-process and are not storable in Redis.
   */
  add(orderId: string, connectionId: string, ttlSeconds: number): Promise<void>;
  remove(orderId: string, connectionId: string): Promise<void>;
  list(orderId: string): Promise<string[]>;
}

export interface Db {
  initSchema(): Promise<void>;
  insertOrder(order: Order): Promise<void>;
  finalizeOrder(result: {
    orderId: string;
    dex: DexName;
    executedPrice: number;
    txHash: string;
    updatedAtMs: number;
  }): Promise<void>;
  failOrder(result: { orderId: string; failureReason: string; updatedAtMs: number }): Promise<void>;
  getOrder(orderId: string): Promise<OrderFinalRecord | null>;
  close(): Promise<void>;
}

export interface QueueClient {
  enqueue(payload: { orderId: string }): Promise<void>;
  close(): Promise<void>;
}

