-- Hardening: currency reference data, app role, append-only + hash-chained action_records.

-- Currencies (reference data). Money columns reference currencies(code).
INSERT INTO currencies (code, minor_unit_exponent, name) VALUES
  ('GBP', 2, 'Pound sterling'),
  ('USD', 2, 'US dollar'),
  ('EUR', 2, 'Euro'),
  ('CNY', 2, 'Chinese yuan'),
  ('HKD', 2, 'Hong Kong dollar'),
  ('JPY', 0, 'Japanese yen');--> statement-breakpoint
ALTER TABLE currencies ADD CONSTRAINT currencies_code_format CHECK (code ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE currencies ADD CONSTRAINT currencies_exponent_range CHECK (minor_unit_exponent BETWEEN 0 AND 4);--> statement-breakpoint

-- App role: not a superuser, owns nothing. Password is set by scripts/migrate.ts from APP_DB_PASSWORD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sme_app') THEN
    CREATE ROLE sme_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sme_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  businesses, financial_accounts, counterparties, transactions, invoices, bills,
  recurring_commitments, forecast_runs, forecast_lines, mandates, action_proposals
  TO sme_app;--> statement-breakpoint
GRANT SELECT ON currencies TO sme_app;--> statement-breakpoint
GRANT SELECT, INSERT ON action_records TO sme_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON action_records FROM sme_app;--> statement-breakpoint

-- Canonical text of a record for hashing. A JSON array is unambiguous (no delimiter clashes).
CREATE FUNCTION action_record_canonical(r action_records) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(
    r.business_id, r.chain_seq, r.id, r.proposal_id, r.event, r.actor, r.detail, r.verification,
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.prev_hash
  )::text
$$;--> statement-breakpoint

-- Chain is per business. The trigger (not the app) assigns position and hashes, so no writer can skip it.
CREATE FUNCTION action_records_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('action_records:' || NEW.business_id::text, 0));
  SELECT chain_seq, hash INTO last_seq, last_hash
    FROM action_records WHERE business_id = NEW.business_id ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.hash := encode(sha256(convert_to(action_record_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER action_records_chain_trg BEFORE INSERT ON action_records
  FOR EACH ROW EXECUTE FUNCTION action_records_chain();--> statement-breakpoint

CREATE FUNCTION action_records_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'action_records is append-only (% blocked)', TG_OP;
END
$$;--> statement-breakpoint
CREATE TRIGGER action_records_no_update_delete BEFORE UPDATE OR DELETE ON action_records
  FOR EACH ROW EXECUTE FUNCTION action_records_immutable();--> statement-breakpoint
CREATE TRIGGER action_records_no_truncate BEFORE TRUNCATE ON action_records
  FOR EACH STATEMENT EXECUTE FUNCTION action_records_immutable();
