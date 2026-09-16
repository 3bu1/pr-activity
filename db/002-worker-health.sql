CREATE TABLE IF NOT EXISTS app_worker_health (id uuid PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
