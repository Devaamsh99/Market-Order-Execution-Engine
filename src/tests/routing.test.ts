import { MockDexRouter } from '../dex/mockDexRouter';
import type { Logger, Order } from '../types';

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

function seqRandom(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i] ?? values[values.length - 1] ?? 0;
    i++;
    return v;
  };
}

describe('MockDexRouter routing logic', () => {
  test('quotes include fee rates and effectivePrice is price*(1-feeRate)', async () => {
    const router = new MockDexRouter({
      logger: noopLogger(),
      random: () => 0,
      sleepFn: async () => {}
    });

    const ray = await router.getRaydiumQuote('SOL', 'USDC', 10);
    const met = await router.getMeteoraQuote('SOL', 'USDC', 10);

    expect(ray.feeRate).toBeCloseTo(0.003);
    expect(met.feeRate).toBeCloseTo(0.002);
    expect(ray.effectivePrice).toBeCloseTo(ray.price * (1 - ray.feeRate));
    expect(met.effectivePrice).toBeCloseTo(met.price * (1 - met.feeRate));
  });

  test('route() selects the higher effectivePrice', async () => {
    // Random sequence: Raydium variance uses first random, Meteora uses second.
    // Make Raydium low and Meteora high.
    const router = new MockDexRouter({
      logger: noopLogger(),
      random: seqRandom([0, 1]),
      sleepFn: async () => {}
    });

    const decision = await router.route(makeOrder());
    expect(['raydium', 'meteora']).toContain(decision.chosen.dex);
    expect(decision.chosen.effectivePrice).toBeGreaterThanOrEqual(
      Math.min(decision.raydium.effectivePrice, decision.meteora.effectivePrice)
    );
    expect(decision.chosen.effectivePrice).toBeCloseTo(
      Math.max(decision.raydium.effectivePrice, decision.meteora.effectivePrice)
    );
  });

  test('quote variance stays within expected bounds (approx)', async () => {
    const router = new MockDexRouter({
      logger: noopLogger(),
      random: () => 1,
      sleepFn: async () => {}
    });
    const order = makeOrder({ amount: 1 });

    const ray = await router.getRaydiumQuote(order.tokenIn, order.tokenOut, order.amount);
    const met = await router.getMeteoraQuote(order.tokenIn, order.tokenOut, order.amount);

    // With random=1, raydium variance=1.02, meteora variance=1.02
    expect(ray.price).toBeGreaterThan(0);
    expect(met.price).toBeGreaterThan(0);
    expect(ray.price / met.price).toBeGreaterThan(0.9);
    expect(ray.price / met.price).toBeLessThan(1.1);
  });

  test('executeSwap returns deterministic txHash format and executedPrice > 0', async () => {
    const router = new MockDexRouter({
      logger: noopLogger(),
      random: () => 0,
      sleepFn: async () => {}
    });

    const res = await router.executeSwap('raydium', makeOrder(), 1.234);
    expect(res.dex).toBe('raydium');
    expect(res.executedPrice).toBeGreaterThan(0);
    expect(res.txHash.startsWith('mocktx_')).toBe(true);
    expect(res.txHash.length).toBeGreaterThan(10);
  });

  test('executeSwap drift stays within ~±0.5% of quotedPrice', async () => {
    const router = new MockDexRouter({
      logger: noopLogger(),
      random: () => 0, // drift = 0.995
      sleepFn: async () => {}
    });
    const quoted = 2.0;
    const res = await router.executeSwap('meteora', makeOrder(), quoted);
    expect(res.executedPrice).toBeCloseTo(quoted * 0.995);
  });

  test('higher amount produces lower (or equal) quote due to amountFactor', async () => {
    const router = new MockDexRouter({
      logger: noopLogger(),
      random: () => 0.5,
      sleepFn: async () => {}
    });
    const small = await router.getRaydiumQuote('SOL', 'USDC', 1);
    const big = await router.getRaydiumQuote('SOL', 'USDC', 50_000);
    expect(big.price).toBeLessThanOrEqual(small.price);
  });
});

