ALTER TABLE app_jobs ADD COLUMN IF NOT EXISTS scheduled_at timestamptz NOT NULL DEFAULT now();
