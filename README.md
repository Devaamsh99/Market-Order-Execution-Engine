# Order Execution Engine (Market Orders, Mock DEX Routing)

## System overview
This service implements a **Market Order** execution engine that:
- Accepts market orders via `POST /api/orders/execute`
- Routes between **Raydium vs Meteora** using a **mock DEX router** (parallel quote fetch + fee-aware best price selection)
- Executes orders asynchronously via **BullMQ** (Redis-backed queue) with **max 10 concurrent executions** and **100 orders/minute** rate limiting
- Streams live order lifecycle updates over **WebSocket**
- Persists order history/final outcome to **PostgreSQL** and tracks active orders + event backlog in **Redis**

## Intentional standards-compliant “submit → stream” protocol
The assignment text describes “submit over HTTP then upgrade the same connection to WebSocket”. A literal POST→Upgrade handshake would violate RFC 6455 (WebSocket handshakes are HTTP GET requests).

This implementation uses a **protocol-compliant async handoff**:
- `POST /api/orders/execute` validates and enqueues the order, then returns `{ orderId, wsUrl }`.
- The client opens a **separate WebSocket connection** via:
  - `GET /api/orders/execute?orderId=...` with `Upgrade: websocket`
- The server upgrades that GET request and streams lifecycle events for the order.

## Architecture

```mermaid
graph TD
  Client -->|POST_execute| Api
  Api -->|writeActiveOrder+events| Redis
  Api -->|enqueueJob| BullMQ
  Client -->|"WS_connect(orderId)"| Ws
  Ws -->|subscribe(orderId)| EventBus
  Worker -->|processJob| BullMQ
  Worker -->|publishLifecycle| EventBus
  Worker -->|persistFinal| Postgres
  Ws -->|streamEvents| Client
```

### Core components
- **API**: `src/api/orders.ts`
- **WebSocket**: `src/ws/orderSocket.ts`
- **Mock DEX Router**: `src/dex/mockDexRouter.ts`
- **Queue/Worker**: `src/queue/orderQueue.ts`, `src/queue/orderWorker.ts`
- **Persistence**:
  - Postgres adapter: `src/db/index.ts` + `schema.sql`
  - Redis active orders + event backlog + socket mapping metadata: `src/services/orderService.ts`

## Why Market Orders
Market orders are the simplest order type to validate and execute in a single asynchronous pipeline: **execute immediately at best available price**. This keeps the engine focused on architecture (routing + status streaming + queueing + persistence) without adding price-trigger state machines.

### Extending to other order types
- **Limit orders**: persist a target price and implement a price watcher (polling/streaming quotes) that enqueues execution only when the limit condition is satisfied. Same execution worker can be reused once triggered.
- **Sniper orders**: add a trigger source (token launch/migration detection), then enqueue execution at trigger time; reuse the same market execution pipeline and WebSocket lifecycle.

## Order lifecycle states (WebSocket)
Events are emitted in order:
1. `pending` (emitted by the API immediately after enqueue)
2. `routing`
3. `building`
4. `submitted`
5. `confirmed` (includes `txHash`, `dex`, `executedPrice`)

On final failure (after retries):
- `failed` (includes `error`)

## Tests: hermetic and dependency-free
`npm test` runs with **zero external dependencies**:
- Uses **`pg-mem`** for Postgres behavior
- Uses in-memory adapters/mocks for Redis-like behavior and WebSocket streaming
- Does **not** run Redis-backed BullMQ job execution in tests
- Still tests:
  - DEX routing logic (price/fee comparison)
  - Queue/worker configuration values (concurrency, rate limit)
  - Exponential backoff retry orchestration logic via injected runner
  - WebSocket lifecycle ordering & failure propagation

## Runtime: real Redis + PostgreSQL via Docker
Runtime uses real infrastructure:
- Redis for BullMQ + active orders + event backlog + socket mapping metadata
- PostgreSQL for order history

Start Redis/Postgres locally:

```bash
docker compose up -d
```

## Setup & run
### Requirements
- Node.js 20+ (Node 22 recommended)
- Docker (runtime only)

### Environment variables
Copy and fill:
- `env.example` → set in your shell (or your process manager)

Variables:
- `PORT` (default 3000)
- `REDIS_URL` (e.g. `redis://localhost:6379`)
- `DATABASE_URL` (e.g. `postgres://postgres:postgres@localhost:5432/tdbits`)
- `ACTIVE_ORDER_TTL_SECONDS` (default 3600)

### Install, build, start

```bash
npm install
npm run build
npm start
```

Or dev mode:

```bash
npm run dev
```

## API usage
### Execute a market order
- **POST** `/api/orders/execute`

Example:

```bash
curl -s -X POST 'http://localhost:3000/api/orders/execute' \
  -H 'content-type: application/json' \
  -d '{"tokenIn":"SOL","tokenOut":"USDC","amount":10,"slippageBps":50}'
```

Response:

```json
{ "orderId": "...", "wsUrl": "ws://localhost:3000/api/orders/execute?orderId=..." }
```

### Connect WebSocket for lifecycle
Connect to `wsUrl` (or equivalent):
- **GET** `/api/orders/execute?orderId=...` with WebSocket Upgrade

WebSocket message payloads are JSON `OrderEvent` objects.

## Client simulator (recommended for validation)
This repo includes a small client that submits multiple orders and streams each order’s WebSocket lifecycle.

1) Start runtime dependencies:

```bash
docker compose up -d
```

2) Start the server (in another terminal):

```bash
npm run dev
```

3) Run the simulator (3–5 simultaneous orders):

```bash
npm run simulate -- --baseUrl http://localhost:3000 --count 5
```

## Deployment (free-tier friendly)
### Railway
1. Create a new Railway project.
2. Add a **PostgreSQL** plugin and a **Redis** plugin.
3. Set service variables:
   - `DATABASE_URL` (from Railway Postgres)
   - `REDIS_URL` (from Railway Redis)
   - `PORT` (Railway usually injects; if not, set `PORT=3000`)
   - `ACTIVE_ORDER_TTL_SECONDS=3600`
4. Deploy the Node service.
5. Ensure the service exposes the port configured by Railway.

### Render
1. Create a **Web Service** for the Node app.
2. Provision **Render Postgres** and **Render Redis** (free tier where available).
3. Configure environment variables as above.
4. Set build command: `npm install && npm run build`
5. Set start command: `npm start`

### Fly.io
1. Create a Fly app (Node).
2. Provision a managed Postgres (or external Postgres) and Redis (Upstash/other).
3. Set secrets:
   - `fly secrets set DATABASE_URL=... REDIS_URL=... ACTIVE_ORDER_TTL_SECONDS=3600`
4. Deploy.

### Public URL placeholder
- Deployment URL: `__PUT_PUBLIC_URL_HERE__`

## Demo video guide (1–2 minutes)
Record a short screen capture showing:
1. Start the service (logs visible).
2. Submit **3–5 orders simultaneously** (use Postman Runner or multiple terminals).
3. For each returned `wsUrl`, open a WebSocket client (Postman WS, `wscat`, or a small script) and show statuses streaming:
   - `pending → routing → building → submitted → confirmed`
4. Highlight routing logs showing Raydium vs Meteora comparison and chosen venue.
5. Mention queue behavior:
   - concurrency cap of 10
   - 100 orders/minute limiter
   - retry orchestration (max 3 attempts with exponential backoff)

YouTube demo URL placeholder:
- `__PUT_YOUTUBE_LINK_HERE__`

## Postman collection
Import `postman_collection.json`.

