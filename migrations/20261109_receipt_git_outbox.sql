BEGIN;

CREATE TABLE IF NOT EXISTS public.receipt_outbox (
  id serial PRIMARY KEY,
  receipt_id integer NOT NULL UNIQUE
    REFERENCES public.attestation_receipts(id) ON DELETE RESTRICT,
  event_id varchar(64) NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  payload_hash varchar(64) NOT NULL,
  status varchar NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamp without time zone NOT NULL DEFAULT now(),
  lease_owner varchar,
  lease_expires_at timestamp without time zone,
  last_error_code varchar,
  git_commit_sha varchar,
  ledger_sequence integer,
  ledger_event_hash varchar(64),
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  delivered_at timestamp without time zone
);

CREATE INDEX IF NOT EXISTS receipt_outbox_due
  ON public.receipt_outbox(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS public.receipt_ledger_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  base_receipt_id integer NOT NULL CHECK (base_receipt_id >= 0),
  sequence integer NOT NULL CHECK (sequence >= 0),
  event_hash varchar(64) NOT NULL,
  receipt_entry_hash varchar(128) NOT NULL,
  commit_sha varchar NOT NULL,
  signer_key_id varchar(64) NOT NULL,
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

COMMIT;
