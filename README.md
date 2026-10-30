[![CI](https://github.com/abhinav0988/rideflow/actions/workflows/ci.yml/badge.svg)](https://github.com/abhinav0988/rideflow/actions/workflows/ci.yml)
# 🚗 RideFlow – Real-Time Ride Booking Platform

**A production-style backend engineering project demonstrating real-time ride matching, concurrency control, distributed systems, and reliable event-driven architecture.**

RideFlow is an independent Backend / Software Development Engineer portfolio project built using Node.js, TypeScript, PostgreSQL, Redis, RabbitMQ, and Socket.IO.

The React application is a thin client. All ride state, assignment logic, and event processing are managed by the backend API.

> This is an independent portfolio project and is not affiliated with any ride-hailing company.

---

## 🚀 Key Features

- Real-time ride matching and driver discovery.
- Geospatial driver discovery using Redis GEO.
- Concurrent ride acceptance protection.
- PostgreSQL-backed ride state management.
- Idempotent API operations.
- Event-driven architecture using RabbitMQ.
- Transactional outbox pattern.
- At-least-once event delivery.
- Real-time communication using Socket.IO.
- Cross-server event broadcasting using Redis adapter.
- Retry and dead-letter queue handling.
- Structured logging and observability.
- Integration testing using Jest and Testcontainers.
- Docker-based local development environment.

---

## 🛠️ Technology Stack

| Area | Technologies |
|---|---|
| Backend | Node.js, TypeScript, Express.js |
| Frontend | React, Vite |
| Database | PostgreSQL |
| Cache & Coordination | Redis |
| Messaging | RabbitMQ |
| Real-time Communication | Socket.IO, Socket.IO Redis Adapter |
| Testing | Jest, Testcontainers |
| Infrastructure | Docker, Docker Compose, Nginx |
| Logging | Pino |
| Monitoring | Prometheus, Grafana |

**Proposed production infrastructure:** AWS ECS/Fargate, RDS, ElastiCache, Amazon MQ or managed RabbitMQ, ECR, and S3/CloudFront.

AWS is a proposed deployment path. This repository runs locally using Docker Compose and has not been deployed to AWS.

---

## 🏗️ System Architecture

The system separates ride state management, caching, real-time communication, and asynchronous event processing.

```text
                   Rider / Driver
                        |
                        v
                  React Client
                        |
                        v
                   Express API
                        |
          +-------------+-------------+
          |             |             |
          v             v             v
      PostgreSQL      Redis        Socket.IO
          |             |             |
          |             |             |
          v             v             v
      Ride State    GEO / Locks   Real-time Events
          |
          v
    Transactional Outbox
          |
          v
       RabbitMQ
          |
          v
 Notification Consumer
          |
          v
    Notifications
```

### Architecture Responsibilities

| Component | Responsibility |
|---|---|
| React | Rider and driver user interfaces |
| Express API | Authentication, ride operations and business logic |
| PostgreSQL | Persistent ride state, history, idempotency and outbox |
| Redis | Driver presence, geospatial search, locks and caching |
| Socket.IO | Real-time communication |
| RabbitMQ | Asynchronous event delivery |
| Notification Consumer | Notification processing and deduplication |
| Prometheus | Metrics collection |
| Grafana | Metrics visualization |
| Pino | Structured application logging |

---

## 🧠 Engineering Decisions

### 1. PostgreSQL as the Source of Truth

PostgreSQL stores:

- Committed ride state.
- Ride history.
- Idempotency responses.
- Transactional outbox records.

Redis is used for temporary and coordination-related data:

- Driver presence.
- Geospatial driver locations.
- Distributed locks.
- Cache.
- Socket.IO event broadcasting.

This separation ensures that losing Redis does not create a second source of truth for ride state.

### 2. Concurrency Control During Ride Acceptance

A major challenge in ride-booking systems is preventing multiple drivers from accepting the same ride simultaneously.

RideFlow uses two safeguards.

**Redis distributed lock:**

```redis
SET ride:{id}:lock NX PX 5000
```

This allows only one acceptance request to proceed at a time while the lock is held.

**PostgreSQL conditional update:**

```sql
UPDATE rides
SET status = 'accepted'
WHERE status = 'offered'
AND driver = ANY(offered_driver_ids);
```

The PostgreSQL conditional update is the final correctness boundary.

Even if the Redis lock expires, only one request can successfully transition the ride from `offered` to `accepted`.

- The winning driver receives successful acceptance.
- The losing driver receives HTTP 409.
- If Redis cannot acquire the lock, the API returns HTTP 503 without updating the ride.

### 3. Transactional Outbox Pattern

Ride creation, acceptance, completion, and cancellation update the following records within a single PostgreSQL transaction:

- Ride state.
- `ride_events` record.
- `outbox_events` record.

The API request does not wait for RabbitMQ publishing.

A background publisher:

1. Claims an unpublished outbox record.
2. Commits the claim.
3. Publishes the event to RabbitMQ.
4. Waits for broker confirmation.
5. Marks the outbox record as published.

This prevents ride-state changes from being committed without a corresponding durable event record.

### 4. Reliable At-Least-Once Event Delivery

RideFlow does not claim exactly-once delivery.

It implements at-least-once delivery through:

- Transactional outbox.
- RabbitMQ publisher confirms.
- Stable event IDs.
- Idempotent consumer processing.
- Consumer-side deduplication.

If the publisher crashes after RabbitMQ confirms an event but before the outbox record is marked published, the event may be published again after the claim expires.

The consumer uses the stable `event_id` to identify duplicates and avoid duplicate notification records.

### 5. Redis GEO and Driver Presence

Driver heartbeats update Redis using:

```redis
GEOADD drivers:geo longitude latitude driverId
```

Driver presence is maintained using a 30-second TTL:

```redis
SET driver:{id}:presence online EX 30
```

Nearby-driver discovery uses:

```redis
GEOSEARCH
```

Drivers whose presence keys expire are removed from active search results.

This handles disconnected or crashed drivers even when they do not perform a clean offline operation.

### 6. Socket.IO Across Multiple API Instances

RideFlow uses the Socket.IO Redis adapter to support cross-server event delivery.

Clients join rooms such as:

```text
user:{id}
driver:{id}
ride:{id}
```

When an API instance emits an event, the Redis adapter forwards it to other Socket.IO instances.

This allows clients connected to different API servers to receive the same ride updates.

Sticky sessions are not required for this Redis adapter-based event broadcasting architecture.

---

## 📡 API Overview

The API provides functionality across the following modules.

| Module | Responsibilities |
|---|---|
| Authentication | Rider and driver authentication |
| Drivers | Driver profile and availability |
| Ride Management | Create, accept, complete and cancel rides |
| Driver Matching | Nearby driver discovery |
| Pricing | Fare quotes |
| Idempotency | Duplicate request protection |
| Health | Liveness and readiness checks |
| Metrics | Prometheus metrics |

For implementation details, refer to the Express route and service modules in `apps/api`.

---

## ⚙️ Getting Started

### Prerequisites

Install the following:

- Node.js
- npm
- Docker
- Docker Compose
- Git

### 1. Clone the repository

```bash
git clone https://github.com/abhinav0988/rideflow.git

cd rideflow
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Update the environment variables as required for your local environment.

### 3. Start the complete application

```bash
docker compose up --build
```

### 4. Access the application

| Service | URL |
|---|---|
| Web Application | http://localhost:8080 |
| Backend API | http://localhost:4000 |
| RabbitMQ Management | http://localhost:15672 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3000 |

Local development credentials configured by the Compose setup:

| Service | Username | Password |
|---|---|---|
| RabbitMQ | rideflow | rideflow |
| Grafana | admin | rideflow |

> **Security:** These credentials are intended only for local development. Change default credentials and use secure secrets before exposing any environment publicly.

### 5. Try the application

1. Open the web application.
2. Register one rider account.
3. Register one driver account.
4. Put the driver online.
5. Keep simulated driver movement enabled.
6. Request a ride using the rider interface.
7. Observe ride assignment and real-time updates.

---

## 💻 Local Development

To run the infrastructure separately:

```bash
docker compose up postgres redis rabbitmq
```

Install dependencies:

```bash
npm install
```

Start the backend:

```bash
npm run dev:api
```

Start the frontend:

```bash
npm run dev:web
```

Web development server:

```text
http://localhost:5173
```

### Local Infrastructure Ports

| Service | Port |
|---|---:|
| PostgreSQL | 5433 |
| Redis | 6380 |
| RabbitMQ | 5672 |
| RabbitMQ Management | 15672 |

The PostgreSQL and Redis host ports are configured to avoid conflicts with commonly used local database instances.

---

## 🧪 Testing

RideFlow uses Jest and Testcontainers for integration testing against real infrastructure dependencies.

Run tests:

```bash
npm test
```

Docker must be running because the integration tests start PostgreSQL, Redis, and RabbitMQ containers.

### Important Test Scenarios

| Test Area | Scenarios |
|---|---|
| Driver Discovery | Nearby search and expired driver presence |
| Concurrency | Multiple drivers accepting the same ride |
| Redis Failure | Assignment behavior when Redis is unavailable |
| Messaging | RabbitMQ retry and dead-letter handling |
| Idempotency | Duplicate request and consumer handling |
| Real-time Events | Cross-server Socket.IO communication |
| Integration | PostgreSQL, Redis and RabbitMQ interactions |

GitHub Actions runs the project's CI workflow.

---

## 📊 Observability and Operations

### Health Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health/live` | Checks whether the application process can respond |
| `GET /api/health/ready` | Checks PostgreSQL and Redis readiness |
| `GET /api/health` | Checks PostgreSQL, Redis and RabbitMQ |
| `GET /metrics` | Exposes Prometheus metrics |

RabbitMQ does not fail the readiness endpoint because ride events remain in the transactional outbox until the broker confirms publication.

### Monitoring

Prometheus collects application metrics.

Grafana visualizes metrics using Prometheus as its data source.

```text
Application
    |
    v
Prometheus
    |
    v
Grafana
```

### Logging

Pino provides structured application logs with request correlation using:

```text
x-request-id
```

### Graceful Shutdown

The application handles SIGTERM and SIGINT.

The shutdown sequence:

1. Marks the process unready.
2. Stops the outbox publisher.
3. Stops the notification consumer.
4. Stops HTTP and Socket.IO.
5. Closes RabbitMQ.
6. Closes Redis.
7. Closes PostgreSQL.

The shutdown drain is bounded by `SHUTDOWN_TIMEOUT_MS`, which defaults to 10 seconds.

---

## 🎯 Important Backend Engineering Scenarios

These are some of the engineering problems demonstrated by RideFlow.

### How do you scale Socket.IO across multiple servers?

The Socket.IO Redis adapter forwards events between API instances.

Clients join rooms such as `ride:{id}`. An event emitted from one server can reach clients connected to another server.

Implementation:

```text
apps/api/src/realtime/gateway.ts
```

Test:

```text
apps/api/tests/socketAdapter.test.ts
```

The test runs two Socket.IO servers against one Redis instance and verifies cross-node event delivery.

### How do you find nearby drivers?

Driver heartbeats update Redis GEO and a presence key with a 30-second TTL.

Nearby search uses GEOSEARCH.

Expired presence keys are checked so disconnected drivers do not remain in active search results.

Implementation:

```text
apps/api/src/redis/geo.ts
```

Test:

```text
apps/api/tests/nearbyDrivers.test.ts
```

### How do you prevent two drivers from accepting the same ride?

Ride acceptance uses:

1. Redis `SET NX` lock.
2. PostgreSQL conditional update.

PostgreSQL ensures that only one request can successfully change the ride from `offered` to `accepted`.

Implementation:

```text
apps/api/src/modules/rides/service.ts
```

Tests:

```text
apps/api/tests/exclusiveAccept.test.ts
apps/api/tests/redisFailure.test.ts
```

### What happens when RabbitMQ processing fails?

Ride events are published to the `ride.events` topic exchange.

The notification consumer:

- Writes notification records using the event ID.
- Deduplicates repeated deliveries.
- Retries failures through a TTL-based retry queue.
- Routes failed messages through dead-letter handling.
- Moves messages to `notifications.dlq` after the configured maximum attempts.

The default `NOTIFICATION_MAX_ATTEMPTS` is 3.

Implementation:

```text
apps/api/src/mq/rabbit.ts
```

Test:

```text
apps/api/tests/notificationDlq.test.ts
```

### What happens if Redis becomes unavailable?

RideFlow fails closed for operations where Redis coordination is required.

- Nearby search and driver availability return HTTP 503.
- Ride acceptance returns HTTP 503 before the PostgreSQL update.
- Existing ride state remains stored in PostgreSQL.
- Fare caching and rate limiting degrade according to their configured behavior.
- Rate limits fail open so login is not coupled to Redis.

This prevents Redis failure from causing unsafe ride assignment.

### How are illegal ride state transitions prevented?

Ride state transitions are implemented in:

```text
packages/shared/src/index.ts
```

Illegal state transitions throw errors, and successful transitions are recorded in `ride_events`.

---

## 🔐 Additional API Capabilities

The API also demonstrates:

- JWT authentication with rider and driver roles.
- Idempotency-Key support for ride creation and acceptance.
- PostgreSQL-backed request idempotency.
- Redis-backed idempotency caching.
- Fixed-window rate limiting on login and ride creation.
- Driver profile and fare quote caching.
- PostgreSQL fallback for cached data.
- Structured Pino request logging.
- Ride offer expiration.
- Configurable `OFFER_TTL_SEC` with a default of 120 seconds.

---

## ☁️ Proposed Production Deployment Architecture

RideFlow currently runs locally using Docker Compose.

The following is a proposed AWS production deployment architecture, not an existing deployment.

### Proposed Infrastructure

| Component | AWS Service |
|---|---|
| Container Registry | Amazon ECR |
| Backend API | ECS / Fargate |
| Database | Amazon RDS for PostgreSQL |
| Cache | Amazon ElastiCache for Redis |
| Messaging | Amazon MQ or managed RabbitMQ |
| Load Balancer | Application Load Balancer |
| Secrets | AWS Secrets Manager |
| Static Frontend | Amazon S3 + CloudFront |

### Proposed Deployment Steps

1. Build API and frontend Docker images.
2. Push container images to Amazon ECR.
3. Provision PostgreSQL using Amazon RDS.
4. Provision Redis using Amazon ElastiCache.
5. Configure RabbitMQ using Amazon MQ or another managed RabbitMQ service.
6. Deploy the API using ECS/Fargate behind an Application Load Balancer.
7. Store JWT secrets and database credentials in AWS Secrets Manager.
8. Configure security groups so databases and messaging services are accessible only from authorized application tasks.
9. Serve the frontend through S3 and CloudFront or a separate web container.

The Redis Socket.IO adapter supports cross-instance event broadcasting without requiring sticky sessions.

---

## 📁 Project Structure

```text
rideflow/
│
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── realtime/
│   │   │   ├── redis/
│   │   │   ├── modules/
│   │   │   └── mq/
│   │   └── tests/
│   │
│   └── web/
│       └── React + Vite application
│
├── packages/
│   └── shared/
│       └── Shared ride states, fare logic and DTOs
│
├── docs/
│
├── docker-compose.yml
├── ARCHITECTURE.md
├── .env.example
└── README.md
```

---

## 📚 Additional Documentation

- [Architecture Documentation](ARCHITECTURE.md)
- [Database Performance Documentation](docs/database-performance.md)

---

## 👨‍💻 About This Project

RideFlow was built as an independent backend engineering portfolio project to demonstrate practical understanding of:

- Node.js backend development.
- Distributed systems.
- Database transactions.
- Redis-based coordination.
- Message-driven architecture.
- Real-time communication.
- Reliability and failure handling.
- Integration testing.
- Production-oriented observability.

The focus is on understanding engineering trade-offs and implementing reliable backend workflows rather than simply building CRUD endpoints.

---

## 🔗 Connect

**Developer:** Abhinav Mangal

- GitHub: https://github.com/abhinav0988
- LinkedIn: https://www.linkedin.com/in/abhinav-mangal-93020b134/
- Portfolio: https://abhinav0988.github.io/portfolio
- Email: abhinavmangal68@gmail.com

---

⭐ If you find this project interesting, feel free to explore the repository and its implementation.
