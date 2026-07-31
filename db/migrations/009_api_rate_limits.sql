CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  bucket_key CHAR(64) PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT api_rate_limits_bucket_key_format
    CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_rate_limits_request_count_positive
    CHECK (request_count >= 1),
  CONSTRAINT api_rate_limits_timestamp_order
    CHECK (updated_at >= window_started_at)
);

CREATE INDEX IF NOT EXISTS api_rate_limits_updated_at_idx
  ON public.api_rate_limits (updated_at);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.api_rate_limits IS
  'Operational fixed-window API rate-limit counters; identifiers are HMAC-SHA256 digests.';
