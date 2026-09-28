CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('rider', 'driver')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drivers (
  user_id UUID PRIMARY KEY REFERENCES users (id),
  vehicle TEXT NOT NULL DEFAULT 'sedan',
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id UUID NOT NULL REFERENCES users (id),
  driver_id UUID REFERENCES users (id),
  status TEXT NOT NULL,
  pickup_lat DOUBLE PRECISION NOT NULL,
  pickup_lng DOUBLE PRECISION NOT NULL,
  dropoff_lat DOUBLE PRECISION NOT NULL,
  dropoff_lng DOUBLE PRECISION NOT NULL,
  fare_cents INTEGER NOT NULL,
  offered_driver_ids UUID[] NOT NULL DEFAULT '{}',
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ride_events (
  id BIGSERIAL PRIMARY KEY,
  ride_id UUID NOT NULL REFERENCES rides (id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id UUID NOT NULL REFERENCES users (id),
  key TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  ride_id UUID,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID UNIQUE NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS rides_rider_status_idx ON rides (rider_id, status);
CREATE INDEX IF NOT EXISTS rides_driver_status_idx ON rides (driver_id, status);
CREATE INDEX IF NOT EXISTS rides_offered_updated_idx ON rides (updated_at) WHERE status = 'offered';
CREATE INDEX IF NOT EXISTS ride_events_ride_created_idx ON ride_events (ride_id, created_at);
DROP INDEX IF EXISTS rides_offered_idx;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'outbox_pending_idx'
      AND indexdef NOT LIKE '%(created_at, id)%'
  ) THEN
    DROP INDEX outbox_pending_idx;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox_events (created_at, id)
  WHERE status = 'pending';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rides_status_check') THEN
    ALTER TABLE rides ADD CONSTRAINT rides_status_check CHECK (
      status IN (
        'requested', 'matching', 'offered', 'accepted', 'arrived',
        'in_progress', 'completed', 'cancelled', 'expired', 'no_drivers'
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rides_pickup_lat_check') THEN
    ALTER TABLE rides ADD CONSTRAINT rides_pickup_lat_check CHECK (pickup_lat BETWEEN -90 AND 90);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rides_pickup_lng_check') THEN
    ALTER TABLE rides ADD CONSTRAINT rides_pickup_lng_check CHECK (pickup_lng BETWEEN -180 AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rides_dropoff_lat_check') THEN
    ALTER TABLE rides ADD CONSTRAINT rides_dropoff_lat_check CHECK (dropoff_lat BETWEEN -90 AND 90);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rides_dropoff_lng_check') THEN
    ALTER TABLE rides ADD CONSTRAINT rides_dropoff_lng_check CHECK (dropoff_lng BETWEEN -180 AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rides_fare_check') THEN
    ALTER TABLE rides ADD CONSTRAINT rides_fare_check CHECK (fare_cents >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ride_events_to_status_check') THEN
    ALTER TABLE ride_events ADD CONSTRAINT ride_events_to_status_check CHECK (
      to_status IN (
        'requested', 'matching', 'offered', 'accepted', 'arrived',
        'in_progress', 'completed', 'cancelled', 'expired', 'no_drivers'
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ride_events_from_status_check') THEN
    ALTER TABLE ride_events ADD CONSTRAINT ride_events_from_status_check CHECK (
      from_status IS NULL OR from_status IN (
        'requested', 'matching', 'offered', 'accepted', 'arrived',
        'in_progress', 'completed', 'cancelled', 'expired', 'no_drivers'
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ride_events_actor_id_fkey') THEN
    ALTER TABLE ride_events
      ADD CONSTRAINT ride_events_actor_id_fkey
      FOREIGN KEY (actor_id) REFERENCES users (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbox_published_at_check') THEN
    ALTER TABLE outbox_events ADD CONSTRAINT outbox_published_at_check CHECK (
      (status = 'pending' AND published_at IS NULL)
      OR (status = 'published' AND published_at IS NOT NULL)
    );
  END IF;
END $$;
