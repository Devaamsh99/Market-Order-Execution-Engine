import { v4 as uuidv4 } from 'uuid';
import type { DexName, DexQuote, Logger, Order, RoutingDecision, SwapExecutionResult } from '../types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function stableBasePrice(tokenIn: string, tokenOut: string): number {
  const seed = `${tokenIn}→${tokenOut}`;
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum = (sum + seed.charCodeAt(i) * (i + 1)) % 10_000;
  // 0.75 .. 1.25
  return 0.75 + (sum / 10_000) * 0.5;
}

export class MockDexRouter {
  private readonly logger: Logger;
  private readonly rand: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  public constructor(opts: { logger: Logger; random?: () => number; sleepFn?: (ms: number) => Promise<void> }) {
    this.logger = opts.logger;
    this.rand = opts.random ?? Math.random;
    this.sleepFn = opts.sleepFn ?? sleep;
  }

  private async getQuote(dex: DexName, tokenIn: string, tokenOut: string, amount: number): Promise<DexQuote> {
    await this.sleepFn(200);
    const base = stableBasePrice(tokenIn, tokenOut);
    // Amount impacts slippage-like behavior slightly in a stable way.
    const amountFactor = clamp(1 - amount * 0.00001, 0.9, 1);

    if (dex === 'raydium') {
      const variance = 0.98 + this.rand() * 0.04; // ~ +/-2%
      const price = base * variance * amountFactor;
      const feeRate = 0.003;
      return { dex, price, feeRate, effectivePrice: price * (1 - feeRate) };
    }

    const variance = 0.97 + this.rand() * 0.05; // ~ -3%..+2% (often different from Raydium)
    const price = base * variance * amountFactor;
    const feeRate = 0.002;
    return { dex, price, feeRate, effectivePrice: price * (1 - feeRate) };
  }

  public async getRaydiumQuote(tokenIn: string, tokenOut: string, amount: number): Promise<DexQuote> {
    return await this.getQuote('raydium', tokenIn, tokenOut, amount);
  }

  public async getMeteoraQuote(tokenIn: string, tokenOut: string, amount: number): Promise<DexQuote> {
    return await this.getQuote('meteora', tokenIn, tokenOut, amount);
  }

  public async route(order: Order): Promise<RoutingDecision> {
    const [raydium, meteora] = await Promise.all([
      this.getRaydiumQuote(order.tokenIn, order.tokenOut, order.amount),
      this.getMeteoraQuote(order.tokenIn, order.tokenOut, order.amount)
    ]);

    const chosen = raydium.effectivePrice >= meteora.effectivePrice ? raydium : meteora;
    this.logger.info('routing.decision', {
      orderId: order.orderId,
      raydium: { price: raydium.price, feeRate: raydium.feeRate, effectivePrice: raydium.effectivePrice },
      meteora: { price: meteora.price, feeRate: meteora.feeRate, effectivePrice: meteora.effectivePrice },
      chosen: { dex: chosen.dex, effectivePrice: chosen.effectivePrice }
    });

    return { raydium, meteora, chosen };
  }

  public async executeSwap(dex: DexName, order: Order, quotedPrice: number): Promise<SwapExecutionResult> {
    // Simulate 2–3 seconds execution time.
    await this.sleepFn(2000 + Math.floor(this.rand() * 1000));

    // Simulate mild execution price drift relative to quoted price.
    const drift = 0.995 + this.rand() * 0.01; // -0.5%..+0.5%
    const executedPrice = quotedPrice * drift;

    return {
      dex,
      executedPrice,
      txHash: `mocktx_${uuidv4().replace(/-/g, '')}`
    };
  }
}

