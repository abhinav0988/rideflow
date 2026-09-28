# RideFlow

Production-style real-time ride platform built as a Backend / SDE portfolio project.

RideFlow is an independent portfolio project for backend, real-time, and distributed-system patterns. It is not affiliated with any ride-hailing company. The React app is a thin desk. Ride state, assignment, and events live in the API.

The API demonstrates:

- real-time ride matching
- geospatial driver discovery
- concurrency control
- idempotency
- event-driven architecture
- transactional outbox
- at-least-once delivery
- real-time Socket.IO communication
- observability
- integration testing

## Technology stack

| Area | Technologies |
| --- | --- |
| Backend | Node.js, TypeScript, Express |
| Frontend | React, Vite |
| Database | PostgreSQL |
| Cache and coordination | Redis |
| Messaging | RabbitMQ |
| Real time | Socket.IO, Socket.IO Redis adapter |
| Testing | Jest, Testcontainers |
| Infrastructure | Docker, Docker Compose, nginx |
| Observability | Pino, Prometheus, Grafana |

AWS is a proposed production path below. Nothing in this repo is deployed there.

## Engineering decisions

### PostgreSQL is the source of truth

Committed ride state, ride history, idempotency responses, and outbox rows live in PostgreSQL. Redis holds presence, locks, cache, and Socket.IO fan-out. Losing Redis must not invent a second copy of a ride.

### The Redis lock coordinates acceptance

`acceptRide` takes `SET ride:{id}:lock NX PX 5000`, then runs `UPDATE rides ... WHERE status = 'offered' AND driver = ANY(offered_driver_ids)`. The lock stops two accepts from proceeding together. If it expires, the conditional update is still the guard: only one row can leave `offered`. The other driver gets 409. If Redis cannot take the lock, the handler returns 503 and does not update the row.

### Transactional outbox

Create, accept, complete, and cancel write the ride change, the `ride_events` row, and an `outbox_events` row in one Postgres transaction. The request does not wait for RabbitMQ. A publisher later claims the row, commits, and publishes.

### At-least-once delivery

This is not exactly-once delivery. The guarantee is a transactional outbox, a RabbitMQ publisher confirm, a stable `event_id`, and an idempotent consumer. The row is marked published only after the broker confirms. If the process dies after that confirm and before the published update, the same `event_id` is sent again after the claim expires. The notification consumer inserts on that id and ignores the duplicate.

### Redis GEO and presence

Heartbeats `GEOADD` the driver and set `driver:{id}:presence` with a 30-second TTL. Nearby search is `GEOSEARCH`. A driver whose presence key has expired is removed, including one that crashed without going offline.

### Socket.IO across API instances

Clients join `user:{id}`, `driver:{id}`, and `ride:{id}`. The Redis adapter forwards an emit on one API process to a client connected to another. Sticky sessions are not required.

## Run it

```bash
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:8080
- API: http://localhost:4000
- RabbitMQ management: http://localhost:15672 (`rideflow` / `rideflow`)
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000 (`admin` / `rideflow`)

Open two browsers. Register one rider and one driver. Put the driver online (leave "Simulate movement" on), then request a ride from the rider map.

For local development without rebuilding images:

```bash
docker compose up postgres redis rabbitmq
cp .env.example .env
npm install
npm run dev:api
npm run dev:web
```

Host ports are 5433 (Postgres) and 6380 (Redis) so they do not collide with a local database. RabbitMQ stays on 5672.

Web dev server: http://localhost:5173. Tests:

```bash
npm test
```

Jest starts Postgres, Redis, and RabbitMQ with Testcontainers, so Docker has to be running.

## Operations

- `GET /api/health/live` — the process can answer. Redis or RabbitMQ being down does not fail it.
- `GET /api/health/ready` — Postgres and Redis are up, and the process is not shutting down. RabbitMQ is listed and does not fail this check, because ride events stay in the outbox until the broker confirms them.
- `GET /api/health` — Postgres, Redis, and RabbitMQ are all up. Kept so older checks still work.
- `GET /metrics` — Prometheus text. Grafana is at http://localhost:3000 (`admin` / `rideflow`) and reads Prometheus at http://localhost:9090.

SIGTERM and SIGINT mark the process unready, stop the outbox publisher and notification consumer, stop HTTP and Socket.IO, then close RabbitMQ, Redis, and Postgres. Drain is bounded by `SHUTDOWN_TIMEOUT_MS` (default 10 seconds).

Ride writes and their RabbitMQ events share one Postgres transaction via `outbox_events`. The publisher claims a row, commits, then publishes. It marks the row published only after a broker confirm. A crash between confirm and that update republishes the same `event_id` after the claim expires. The notification consumer deduplicates on that id. See [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/database-performance.md](docs/database-performance.md).

## Interview stories

### How do you scale Socket.IO to multiple servers?

`useRedisAdapter` in [`apps/api/src/realtime/gateway.ts`](apps/api/src/realtime/gateway.ts) attaches `@socket.io/redis-adapter`. A ride room joined on one API process receives emits from another. Sticky sessions are not required. [`apps/api/tests/socketAdapter.test.ts`](apps/api/tests/socketAdapter.test.ts) runs two Socket.IO servers against one Redis and checks a cross-node `ride:update`.

### How do you find nearby drivers?

Driver heartbeats call `GEOADD` on `drivers:geo` and set `driver:{id}:presence` with a TTL ([`apps/api/src/redis/geo.ts`](apps/api/src/redis/geo.ts)). Search is `GEOSEARCH` sorted by distance. Members whose presence key has expired are removed, so a crashed driver disappears without a clean shutdown. Covered by [`apps/api/tests/nearbyDrivers.test.ts`](apps/api/tests/nearbyDrivers.test.ts).

### How do you stop two drivers accepting the same ride?

`acceptRide` in [`apps/api/src/modules/rides/service.ts`](apps/api/src/modules/rides/service.ts) does both:

1. `SET ride:{id}:lock NX PX 5000` so only one accept proceeds.
2. `UPDATE rides SET status = 'accepted' WHERE status = 'offered' AND driver = ANY(offered_driver_ids)`.

Postgres is the correctness boundary if the lock expires. The API returns 409 to the loser. If Redis cannot take the lock, the handler returns 503 and does not update the row, so a Redis outage cannot double-assign. Tests: [`apps/api/tests/exclusiveAccept.test.ts`](apps/api/tests/exclusiveAccept.test.ts), [`apps/api/tests/redisFailure.test.ts`](apps/api/tests/redisFailure.test.ts).

### What happens when RabbitMQ processing fails?

Ride events go to the `ride.events` topic exchange. The `notifications` consumer writes one row per event id. A failure republishes to `notifications.retry` with a TTL; when the TTL fires, the message dead-letters back onto `ride.retry`. After `NOTIFICATION_MAX_ATTEMPTS` (default 3) it is copied to `notifications.dlq` and acked so it is not retried forever. The insert is `ON CONFLICT DO NOTHING`, so a redelivery does not duplicate the notification. Topology and consumer: [`apps/api/src/mq/rabbit.ts`](apps/api/src/mq/rabbit.ts). Test: [`apps/api/tests/notificationDlq.test.ts`](apps/api/tests/notificationDlq.test.ts).

### What if Redis is down?

- Nearby search and going online fail with 503. The ride row stays in Postgres (`matching` if create already committed) and is not assigned to a random driver.
- Accept fails closed with 503 before the `UPDATE`.
- Fare cache and rate limits degrade. Pricing still runs in process. Rate limits fail open so login is not coupled to Redis. Assignment does not.

Ride transitions themselves live in [`packages/shared/src/index.ts`](packages/shared/src/index.ts). Illegal jumps throw. Every successful change is appended to `ride_events`.

## What else is in the API

- JWT auth with `rider` and `driver` roles
- Idempotency-Key on ride create and accept, stored in Postgres and cached in Redis
- Fixed-window rate limits on login and ride create
- Driver profile and fare quotes cached in Redis, with Postgres as the fallback
- pino request logs with `x-request-id`
- Offer expiry (`OFFER_TTL_SEC`, default 120) moves stale offers to `expired`

## Production deployment path

This repo runs on Docker Compose. The notes below are a proposed production architecture. RideFlow has not been deployed to AWS:

1. Build `apps/api/Dockerfile` and `apps/web/Dockerfile`, push both to ECR.
2. RDS for Postgres, ElastiCache for Redis, Amazon MQ (or a RabbitMQ service) for the broker.
3. Run the API on ECS/Fargate behind an ALB. The Redis Socket.IO adapter means the target group does not need sticky sessions.
4. Put `JWT_SECRET` and database URLs in Secrets Manager, not in the image.
5. Serve the web image the same way, or put the static build on S3 + CloudFront and point it at the API.
6. Security groups: ALB public, tasks private, data stores reachable only from the API tasks.

## Layout

```text
apps/api          Express, Socket.IO, queues, Jest
apps/web          Vite + React rider and driver desks
packages/shared   ride states, fare math, DTOs
docker-compose.yml
```
