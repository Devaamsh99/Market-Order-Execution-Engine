CREATE TABLE IF NOT EXISTS order_history (
  order_id TEXT PRIMARY KEY,
  order_type TEXT NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  slippage_bps INTEGER NOT NULL,
  status TEXT NOT NULL,
  dex_chosen TEXT NULL,
  executed_price NUMERIC NULL,
  tx_hash TEXT NULL,
  failure_reason TEXT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_history_status ON order_history(status);
CREATE INDEX IF NOT EXISTS idx_order_history_created_at ON order_history(created_at_ms);

