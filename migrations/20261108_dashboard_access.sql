BEGIN;
-- Immutable operator-owned pin; never delete/reassign when a tenant is removed.
CREATE TABLE service_dashboard_principals (
 issuer_id varchar PRIMARY KEY REFERENCES users(id),
 tenant_key text NOT NULL,
 UNIQUE (issuer_id, tenant_key)
);
CREATE TABLE service_dashboard_bindings (
 id serial PRIMARY KEY,
 issuer_id varchar NOT NULL REFERENCES users(id),
 owner_id varchar REFERENCES users(id),
 org_id integer REFERENCES organizations(id) ON DELETE CASCADE,
 tenant_key text NOT NULL,
 scope text NOT NULL DEFAULT 'selected' CHECK (scope IN ('selected', 'full-service')),
 scope_evidence text,
 evidence text NOT NULL CHECK (length(trim(evidence)) > 0),
 verified_by varchar NOT NULL CHECK (length(trim(verified_by)) > 0),
 created_at timestamp NOT NULL DEFAULT now(),
 revoked_at timestamp,
 CHECK ((scope = 'selected' AND scope_evidence IS NULL) OR
        (scope = 'full-service' AND scope_evidence IS NOT NULL AND length(trim(scope_evidence)) > 0)),
 FOREIGN KEY (issuer_id, tenant_key) REFERENCES service_dashboard_principals(issuer_id, tenant_key),
 CHECK (tenant_key = CASE WHEN owner_id IS NOT NULL THEN 'user:' || owner_id ELSE 'org:' || CAST(org_id AS text) END),
 CHECK ((owner_id IS NULL) <> (org_id IS NULL)),
 CHECK (issuer_id <> 'forgeproof-system'),
 CHECK (owner_id IS DISTINCT FROM issuer_id)
);
-- A service principal belongs to one tenant. Use separate principals for separate tenants.
CREATE UNIQUE INDEX service_dashboard_binding_tenant ON service_dashboard_bindings(issuer_id) WHERE revoked_at IS NULL;
CREATE TABLE service_dashboard_grants (
 id serial PRIMARY KEY,
 binding_id integer NOT NULL REFERENCES service_dashboard_bindings(id) ON DELETE CASCADE,
 receipt_id integer NOT NULL REFERENCES attestation_receipts(id) ON DELETE CASCADE,
 granted_by varchar NOT NULL,
 created_at timestamp DEFAULT now(),
 revoked_at timestamp
);
CREATE UNIQUE INDEX service_dashboard_grant_active ON service_dashboard_grants(binding_id, receipt_id) WHERE revoked_at IS NULL;
CREATE INDEX service_dashboard_grant_receipt ON service_dashboard_grants(receipt_id) WHERE revoked_at IS NULL;
COMMIT;
