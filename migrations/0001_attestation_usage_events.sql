-- Additive billing foundation. Historical receipts are not rewritten or backfilled.
CREATE TABLE IF NOT EXISTS attestation_usage_events (
  id SERIAL PRIMARY KEY,
  receipt_id INTEGER NOT NULL UNIQUE,
  user_id VARCHAR NOT NULL,
  org_id INTEGER,
  channel VARCHAR NOT NULL CHECK (channel IN ('http', 'mcp', 'internal')),
  entitlement VARCHAR NOT NULL CHECK (entitlement IN ('legacy_free', 'delegated_entitlement', 'prepaid_credit', 'agent_mpp')),
  units INTEGER NOT NULL DEFAULT 1 CHECK (units > 0),
  unit_price_cents INTEGER CHECK (unit_price_cents IS NULL OR unit_price_cents > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  settlement_status VARCHAR NOT NULL DEFAULT 'unsettled'
    CHECK (settlement_status IN ('unsettled', 'funded_credit', 'refunded', 'reversed')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attestation_usage_events_user_created_idx
  ON attestation_usage_events (user_id, created_at);
