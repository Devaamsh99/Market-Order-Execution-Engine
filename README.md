# Market Order Execution Engine

A robust **Market Order Execution Engine** implemented in **TypeScript** using **Fastify**, **BullMQ**, **Redis**, and **PostgreSQL**.  
This project simulates order routing between two mock DEX venues (Raydium and Meteora) with real-time lifecycle events streamed over WebSockets.

LINK TO PUBLIC DEPLOYMENT: https://market-order-execution-engine.onrender.com/

[Note: This is an API-first service. The root / endpoint returns basic service metadata.
Use POST /api/orders/execute to submit orders and WebSocket for lifecycle updates.]
---

## Table of Contents

- Overview  
- Architecture  
- Features  
- Getting Started  
- Usage  
- Testing  
- Deployment  
- Demo  
- Extending the Engine  
- Project Structure  
- SQL Schema  

---

## Overview

This engine provides a backend service to accept market order requests and route them to the best-priced venue among two simulated decentralized exchanges. It processes orders asynchronously via a reliable job queue and streams lifecycle event updates to clients in real time.

The project emphasizes **clean architecture**, **strong typing**, and **production-grade backend patterns** such as asynchronous execution, queue-based concurrency control, and real-time WebSocket updates.

---

## Architecture

- **Fastify API**
  - `POST /api/orders/execute` — Submit an order and receive `orderId` and `wsUrl`
  - `GET /api/orders/execute?orderId=...` — WebSocket upgrade for lifecycle event streaming

- **BullMQ Worker**
  - Concurrency: 10
  - Rate limiter: 100 orders/minute
  - Retries: 3 attempts with exponential backoff

- **Mock DEX Router**
  - Parallel quote fetching from Raydium and Meteora
  - Simulated latency and 2–5% price variance
  - Fee-adjusted effective price comparison

- **Persistence**
  - Redis: active orders, socket metadata, lifecycle event buffering
  - PostgreSQL: immutable order history and final execution state

---

## Features

- Standards-compliant HTTP → WebSocket async handoff
- Deterministic order lifecycle streaming
- Concurrent job processing with rate limiting
- Hermetic test suite with no external dependencies
- Clear separation of runtime and test infrastructure

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- Docker & Docker Compose (for runtime only)

---

### Installation

```bash
git clone https://github.com/Devaamsh99/Market-Order-Execution-Engine.git
cd Market-Order-Execution-Engine
npm install
```

Create environment variables:

```bash
cp .env.example .env
```

---

### Running Locally

Start Redis and PostgreSQL:

```bash
docker-compose up -d
```

Run the API and worker:

```bash
npm run dev
```

---

## Usage

### Submit Order

```bash
curl -X POST http://localhost:3000/api/orders/execute   -H "Content-Type: application/json"   -d '{
    "tokenIn": "SOL",
    "tokenOut": "USDC",
    "amountIn": 100
  }'
```

Response:

```json
{
  "orderId": "uuid",
  "wsUrl": "ws://localhost:3000/api/orders/execute?orderId=uuid"
}
```

---

### WebSocket Lifecycle Streaming

Connect to the provided `wsUrl` to receive real-time lifecycle updates:

```text
pending → routing → building → submitted → confirmed | failed
```

Each event includes structured metadata such as timestamps, selected DEX, execution price, and transaction hash.

---

## Testing

The test suite is **fully hermetic** and requires no running services.

```bash
npm test
```

Tests validate:
- Routing logic and price selection
- Queue configuration and retry behavior
- WebSocket lifecycle ordering
- Failure propagation

---

## Deployment

This service has been deployed on **Render**

General steps:
1. Provision Redis and PostgreSQL
2. Configure environment variables
3. Run `npm install`
4. Start with `npm start`



---

## Demo

LINK TO DEMO VIDEO: 

---

## Extending the Engine

- **Limit Orders**: Execute only when a target price is reached by periodically re-quoting.
- **Sniper Orders**: Trigger execution on predefined on-chain events such as token launches.

---

## Project Structure

```
src/
├─ api/
│   └─ orders.ts
├─ ws/
│   └─ orderSocket.ts
├─ dex/
│   └─ mockDexRouter.ts
├─ queue/
│   ├─ orderQueue.ts
│   └─ orderWorker.ts
├─ services/
│   └─ orderService.ts
├─ db/
│   └─ index.ts
├─ tests/
│   ├─ routing.test.ts
│   ├─ queue.test.ts
│   └─ websocket.test.ts
├─ server.ts
├─ types.ts
├─ schema.sql
├─ docker-compose.yml
├─ .env.example
└─ postman_collection.json
```

---

## SQL Schema

```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL,
  dex TEXT,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in NUMERIC NOT NULL,
  executed_price NUMERIC,
  tx_hash TEXT,
  failure_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---
