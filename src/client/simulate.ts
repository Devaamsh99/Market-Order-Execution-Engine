import WebSocket from 'ws';

type ExecuteOrderResponse = { orderId: string; wsUrl: string };
type OrderEvent =
  | { orderId: string; status: 'pending' | 'routing' | 'building' | 'submitted'; tsMs: number }
  | { orderId: string; status: 'confirmed'; tsMs: number; txHash: string; dex: 'raydium' | 'meteora'; executedPrice: number }
  | { orderId: string; status: 'failed'; tsMs: number; error: string };

type OrderRunResult = {
  label: string;
  orderId: string;
  final: 'confirmed' | 'failed';
  statuses: string[];
  durationMs: number;
  dex?: 'raydium' | 'meteora';
  executedPrice?: number;
  txHash?: string;
  error?: string;
};

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m'
} as const;

function canColor(): boolean {
  if (process.argv.includes('--noColor')) return false;
  return Boolean(process.stdout.isTTY);
}

function c(s: string, color: keyof typeof ANSI, enabled: boolean): string {
  if (!enabled) return s;
  return `${ANSI[color]}${s}${ANSI.reset}`;
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  if (s.length >= n) return s;
  return ' '.repeat(n - s.length) + s;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  const remMs = ms % 1000;
  if (s < 60) return `${s}.${String(remMs).padStart(3, '0')}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${m}m${String(remS).padStart(2, '0')}s`;
}

function shortId(orderId: string): string {
  return orderId.slice(0, 8);
}

function usage(): string {
  return [
    'Usage:',
    '  npm run simulate -- --baseUrl http://localhost:3000 --count 5',
    '',
    'Options:',
    '  --baseUrl   Base HTTP URL (default: http://localhost:3000)',
    '  --count     Number of simultaneous orders (default: 5)',
    '  --amount    Amount per order (default: 10)',
    '  --tokenIn   Token in symbol (default: SOL)',
    '  --tokenOut  Token out symbol (default: USDC)',
    '  --slippage  Slippage bps (default: 50)',
    '  --timeoutMs Overall timeout per order (default: 30000)',
    '  --noColor   Disable ANSI colors',
    '  --quiet     Only print final result lines'
  ].join('\n');
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function intArg(name: string, fallback: number): number {
  const raw = getArg(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function strArg(name: string, fallback: string): string {
  return getArg(name) ?? fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function requiredOrder(statuses: string[]): boolean {
  const required = ['pending', 'routing', 'building', 'submitted'];
  for (let i = 0; i < required.length; i++) {
    if (statuses[i] !== required[i]) return false;
  }
  return true;
}

async function postExecute(baseUrl: string, body: unknown): Promise<ExecuteOrderResponse> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/orders/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/orders/execute failed (${res.status}): ${text}`);
  }
  return (await res.json()) as ExecuteOrderResponse;
}

async function runOneOrder(opts: {
  baseUrl: string;
  tokenIn: string;
  tokenOut: string;
  amount: number;
  slippageBps: number;
  timeoutMs: number;
  label: string;
  color: boolean;
  quiet: boolean;
  labelWidth: number;
}): Promise<OrderRunResult> {
  const startedAt = Date.now();
  const execute = await postExecute(opts.baseUrl, {
    tokenIn: opts.tokenIn,
    tokenOut: opts.tokenOut,
    amount: opts.amount,
    slippageBps: opts.slippageBps
  });

  const statuses: string[] = [];
  const ws = new WebSocket(execute.wsUrl);
  const prefix = `${c(padRight(`[${opts.label}]`, opts.labelWidth + 2), 'cyan', opts.color)} ${c(
    shortId(execute.orderId),
    'gray',
    opts.color
  )}`;

  function logLine(status: string, msg?: string): void {
    if (opts.quiet) return;
    const elapsed = fmtMs(Date.now() - startedAt);
    const s = padRight(status, 9);
    const coloredStatus =
      status === 'pending'
        ? c(s, 'yellow', opts.color)
        : status === 'routing'
          ? c(s, 'blue', opts.color)
          : status === 'building'
            ? c(s, 'magenta', opts.color)
            : status === 'submitted'
              ? c(s, 'cyan', opts.color)
              : status === 'confirmed'
                ? c(s, 'green', opts.color)
                : status === 'failed'
                  ? c(s, 'red', opts.color)
                  : s;

    const right = msg ? ` ${c(msg, 'gray', opts.color)}` : '';
    console.log(`${prefix} ${coloredStatus} ${c(padLeft(elapsed, 8), 'dim', opts.color)}${right}`);
  }

  const done = new Promise<{ final: 'confirmed' | 'failed' }>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`[${opts.label}] timeout waiting for final status (${opts.timeoutMs}ms)`));
    }, opts.timeoutMs);

    ws.on('open', () => {
      // No client messages needed; server pushes lifecycle.
    });

    ws.on('message', (data) => {
      const ev = JSON.parse(String(data)) as OrderEvent;
      statuses.push(ev.status);

      if (ev.status === 'confirmed') {
        logLine('confirmed', `dex=${ev.dex} price=${ev.executedPrice.toFixed(6)} tx=${ev.txHash.slice(0, 14)}…`);
        clearTimeout(timer);
        resolve({ final: 'confirmed' });
        ws.close();
        return;
      }

      if (ev.status === 'failed') {
        logLine('failed', `error=${ev.error}`);
        clearTimeout(timer);
        resolve({ final: 'failed' });
        ws.close();
        return;
      }

      logLine(ev.status);
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const result = await done;
  const durationMs = Date.now() - startedAt;
  const finalEvent = statuses[statuses.length - 1] ?? '';

  if (!requiredOrder(statuses)) {
    console.warn(`${prefix} ${c('WARNING', 'yellow', opts.color)} unexpected lifecycle: ${statuses.join(' → ')}`);
  }

  // We don’t keep the full final payload here (it’s already printed), but we return summary fields
  // by re-subscribing to event backlog is overkill for a CLI; instead we infer from statuses.
  return {
    label: opts.label,
    orderId: execute.orderId,
    final: result.final,
    statuses,
    durationMs,
    ...(finalEvent === 'failed' ? { error: 'see logs' } : {})
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    process.exitCode = 0;
    return;
  }

  const baseUrl = strArg('--baseUrl', 'http://localhost:3000');
  const count = intArg('--count', 5);
  const amount = Number(strArg('--amount', '10'));
  const tokenIn = strArg('--tokenIn', 'SOL');
  const tokenOut = strArg('--tokenOut', 'USDC');
  const slippageBps = intArg('--slippage', 50);
  const timeoutMs = intArg('--timeoutMs', 30_000);
  const color = canColor();
  const quiet = process.argv.includes('--quiet');
  const labelWidth = Math.max(...Array.from({ length: count }).map((_, i) => `order-${i + 1}`.length));

  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('Invalid --amount');
    console.log(usage());
    process.exitCode = 2;
    return;
  }
  if (!Number.isFinite(count) || count <= 0) {
    console.error('Invalid --count');
    console.log(usage());
    process.exitCode = 2;
    return;
  }

  const header = `${c('simulate', 'bold', color)} submitting ${c(String(count), 'bold', color)} market orders to ${c(
    baseUrl,
    'bold',
    color
  )}`;
  console.log(header);
  console.log(
    `${c('params', 'gray', color)} tokenIn=${tokenIn} tokenOut=${tokenOut} amount=${amount} slippageBps=${slippageBps} timeoutMs=${timeoutMs}`
  );
  if (!quiet) console.log(c('---', 'gray', color));

  // Stagger slightly so logs are readable but still simultaneous.
  const runs = Array.from({ length: count }).map(async (_, i) => {
    await sleep(i * 50);
    return await runOneOrder({
      baseUrl,
      tokenIn,
      tokenOut,
      amount,
      slippageBps,
      timeoutMs,
      label: `order-${i + 1}`,
      color,
      quiet,
      labelWidth
    });
  });

  const results = await Promise.allSettled(runs);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(c('---', 'gray', color));
  console.log(
    `${c('done', failed === 0 ? 'green' : 'red', color)} ok=${ok} failed=${failed} ${c(
      `(${fmtMs(
        results
          .filter((r): r is PromiseFulfilledResult<OrderRunResult> => r.status === 'fulfilled')
          .reduce((max, r) => Math.max(max, r.value.durationMs), 0)
      )} max-order-time)`,
      'gray',
      color
    )}`
  );

  const fulfilled = results.filter((r): r is PromiseFulfilledResult<OrderRunResult> => r.status === 'fulfilled').map((r) => r.value);
  if (fulfilled.length > 0) {
    const wLabel = Math.max(...fulfilled.map((r) => r.label.length), 5);
    console.log(c('summary', 'bold', color));
    console.log(`${padRight('label', wLabel)}  orderId    final      time`);
    for (const r of fulfilled) {
      const finalColored =
        r.final === 'confirmed' ? c(padRight(r.final, 9), 'green', color) : c(padRight(r.final, 9), 'red', color);
      console.log(`${padRight(r.label, wLabel)}  ${shortId(r.orderId)}  ${finalColored}  ${padLeft(fmtMs(r.durationMs), 8)}`);
    }
  }

  if (failed > 0) process.exitCode = 1;
}

void main();

