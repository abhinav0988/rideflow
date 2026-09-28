# RideFlow — completed features

Real-time ride platform built as a Backend / SDE-2 portfolio project. One monorepo: Express + TypeScript API, React rider and driver desks, Postgres, Redis, RabbitMQ, and Docker Compose.

## Accounts

- Register as a rider or a driver (email, password, name, role).
- Passwords are hashed with bcrypt. Login returns a JWT that lasts 7 days.
- `GET /api/auth/me` returns the signed-in user.
- Driver registration also creates a driver profile (`offline`, vehicle `sedan`).
- Duplicate emails return 409. Passwords shorter than 8 characters are rejected.
- Login is rate limited: 20 requests per minute per IP, backed by Redis. If Redis is down, login still works.

## Driver presence and nearby search

- A driver goes online with a latitude and longitude. Postgres stores `online`; Redis stores the point.
- `GEOADD` writes the driver into `drivers:geo`. A presence key `driver:{id}:presence` expires after 30 seconds.
- Heartbeats (`POST /api/drivers/location` and the `driver:location` socket event) refresh the geo point and the TTL.
- Going offline removes the geo member and the presence key, and marks Postgres `offline`.
- Nearby search uses Redis `GEOSEARCH`, nearest first, default radius 5 km, up to 5 drivers offered a ride.
- Drivers whose presence key has expired are dropped from the geo index, so a crashed app disappears without a clean shutdown.
- `GET /api/drivers/nearby?lat=&lng=&radiusKm=` returns fresh drivers and distance.
- `GET /api/drivers/me` returns the driver profile. The profile is cached in Redis for 60 seconds and falls back to Postgres. Online/offline clears that cache.
- If Redis is down, going online is rolled back and the API returns 503. The driver is not left “online” but unsearchable.

## Rides

Statuses, in order: `requested` → `matching` → `offered` → `accepted` → `arrived` → `in_progress` → `completed`.

Side exits: `cancelled`, `expired`, `no_drivers`. Any other jump is rejected. Every successful change is appended to `ride_events`.

| Action | Who | Result |
| --- | --- | --- |
| Create ride | Rider | Fare quote, match nearby drivers, offer or `no_drivers` |
| Accept | Offered driver | Exclusive assign |
| Reject | Offered driver | Driver removed from the offer. Last reject becomes `no_drivers` |
| Arrived | Assigned driver | `accepted` → `arrived` |
| Start trip | Assigned driver | `arrived` → `in_progress` |
| Complete | Assigned driver | `in_progress` → `completed` |
| Cancel | Rider or assigned driver | Active ride becomes `cancelled` |

- Fare is a base of $2.00 plus $1.00 per km (haversine). The quote is cached in Redis for 5 minutes. If Redis is down, the fare is still calculated in process.
- Create requires an `Idempotency-Key`. The same key returns the original ride and does not insert a second row. Ride create is rate limited to 10 per minute per IP.
- Accept requires an `Idempotency-Key`. Replaying the same key returns the original response.
- Offers expire after 120 seconds and move to `expired`.
- A rider can read their open ride (`GET /api/rides/active`). A driver can list offers (`GET /api/rides/offers`). A participant can read one ride (`GET /api/rides/:id`).

## One ride, one driver

Accept does both of these:

1. `SET ride:{id}:lock NX PX 5000` so only one accept proceeds.
2. `UPDATE rides SET status = 'accepted' WHERE status = 'offered' AND driver = ANY(offered_driver_ids)`.

Postgres is the correctness check if the lock expires. The second driver gets 409. If Redis cannot take the lock, accept returns 503 and does not update the row.

## Real time

- Socket.IO authenticates with the same JWT.
- Each user joins `user:{id}`. Drivers also join `driver:{id}`. A participant can join `ride:{id}`.
- Ride updates and offers are pushed on those rooms. Driver location during a trip is broadcast as `ride:location`.
- `@socket.io/redis-adapter` is attached, so a client connected to one API process receives events emitted on another. Sticky sessions are not required.
- If Redis is unavailable at startup, the API still boots and Socket.IO stays single-node. Presence and assignment keep failing closed.

## Queues and notifications

- Ride create, accept, complete, and cancel insert an `outbox_events` row in the same Postgres transaction as the ride change. The request does not wait for RabbitMQ.
- An outbox publisher sends `ride.requested`, `ride.accepted`, `ride.completed`, and `ride.cancelled` on the `ride.events` exchange and marks the row published only after a publisher confirm.
- If the publisher crashes after the confirm and before that update, the row stays pending until its 30-second claim expires, then the same `event_id` is published again. That is at-least-once delivery.
- The `notifications` consumer writes one row per `event_id`. A repeat delivery does not insert a second row (`ON CONFLICT DO NOTHING`).
- A failed message is sent to `notifications.retry`. After the TTL (default 2 seconds) it dead-letters back onto `ride.retry` and is consumed again.
- After 3 attempts it is copied to `notifications.dlq` and acknowledged, so it is not retried forever.

## Logging, health, and data

- Every HTTP request gets an `x-request-id` and a pino log line with method, path, status, and duration.
- `GET /api/health/live` returns 200 when the process can answer. It does not check Redis or RabbitMQ.
- `GET /api/health/ready` returns 200 when the process is accepting traffic and Postgres and Redis are up. RabbitMQ is reported, and a broker outage does not fail readiness because the outbox keeps the event.
- `GET /api/health` still returns 200 only when Postgres, Redis, and RabbitMQ are all up.
- `GET /metrics` exposes Prometheus counters, histograms, and gauges.
- Tables: `users`, `drivers`, `rides`, `ride_events`, `idempotency_keys`, `notifications`, `outbox_events`.
- Schema is applied on API startup.

## React app

One Vite + React app. Sign in, or create an account and pick rider or driver.

**Rider**

- Click the map to set pickup (lime) and dropoff (coral). Map is Leaflet on a CARTO dark basemap. No paid map key.
- Request a ride, see fare and status, cancel while the trip is still open.
- Driver position updates over the socket. No polling for status.

**Driver**

- Go online / offline. “Simulate movement” walks the marker so a demo works at a desk.
- Location is pushed about every 2 seconds while online. With an accepted trip, the marker moves toward pickup, then toward dropoff after arrival.
- Offers show fare plus Accept and Reject. After accept: Arrived, Start trip, Complete, Cancel.
- A refresh restores “online” from the driver profile instead of looking offline while Redis still has the driver.

The browser calls the API on the same origin. In dev, Vite proxies `/api` and `/socket.io`. In Docker, nginx does the same.

## Tests

Jest, one worker, against real Postgres, Redis, and RabbitMQ via Testcontainers:

- Legal and illegal ride transitions.
- Nearby search returns a fresh driver and removes a stale geo entry.
- Two drivers accept at once; one wins, one gets 409, and only one `accepted` event is stored.
- The same idempotency key does not create a second ride, including after the cached response is deleted.
- A failing notification lands on the dead-letter queue after retries.
- Accept refuses to update the ride when Redis cannot take the lock.
- A Socket.IO event emitted on one server is received by a client connected to another.

## How it runs

`docker compose up --build` starts Postgres 16, Redis 7, RabbitMQ 3 (management UI), the API, the web app, Prometheus, and Grafana.

- Web: http://localhost:8080
- API: http://localhost:4000
- RabbitMQ: http://localhost:15672 (`rideflow` / `rideflow`)

Host ports are 5433 for Postgres and 6380 for Redis so they do not collide with a database already on the machine. RabbitMQ stays on 5672.

Local development without images: `docker compose up postgres redis rabbitmq`, then `npm run dev:api` and `npm run dev:web` (http://localhost:5173).

## Not built

A live AWS account was not provisioned. The README describes the path (ECR, RDS, ElastiCache, Amazon MQ, ECS) and stops there.
