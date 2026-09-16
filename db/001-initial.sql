CREATE TABLE IF NOT EXISTS app_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON app_sessions(expires_at);
CREATE TABLE IF NOT EXISTS app_businesses (id uuid PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS app_memberships (
  business_id uuid REFERENCES app_businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (business_id,user_id)
);
CREATE INDEX IF NOT EXISTS membership_users ON app_memberships(user_id);
CREATE TABLE IF NOT EXISTS app_records (
  business_id uuid NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('products','campaigns','feedback','connectors','activity')),
  id text NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY (business_id,kind,id)
);
CREATE TABLE IF NOT EXISTS app_jobs (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES app_businesses(id),
  user_id uuid NOT NULL REFERENCES app_users(id), campaign_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('plan','prepare','run')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','completed','cancelled','failed')),
  error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_campaign_job ON app_jobs(business_id,campaign_id) WHERE state='queued';
CREATE TABLE IF NOT EXISTS app_rate_limits (key text PRIMARY KEY, count integer NOT NULL, resets_at timestamptz NOT NULL);
INSERT INTO app_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
