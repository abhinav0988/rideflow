# PostgreSQL design

PostgreSQL is the durable source of truth for users, rides, ride history, idempotency responses, notifications, and the outbox. Redis can be flushed or restarted without changing a committed ride. A cache miss, a lost presence key, or a lost accept lock falls back to Postgres or fails closed. Postgres does not fall back to Redis.

The plans below were executed on 28 Sep 2026 against the Compose Postgres 16 container (`postgres:16-alpine`, host port 5433) on this machine. Seed rows were inserted inside a transaction and rolled back. They are not production numbers.

The live Compose database at the time of the check held 2 rides and 0 outbox rows. On that database the active-ride query was a sequential scan (execution 0.069 ms, 1 buffer hit, 2 rows removed by the filter). Postgres is right to ignore an index when the table is that small. The plans below use a seeded table so the planner has a real choice. They still do not predict production latency.

## Constraints

Application checks reject bad requests. These constraints reject a bad write from any client, including a bug or a manual SQL session. `schema.sql` adds each one only when `pg_constraint` does not already contain that name, so startup can run the file again.

| Table | Constraint | Invariant | Why application checks are not enough |
| --- | --- | --- | --- |
| `users` | `users_email_key` | one account per email | two concurrent registrations can both pass the read check |
| `users` | `users_role_check` | role is `rider` or `driver` | a direct insert could store another role |
| `drivers` | `drivers_pkey` | one driver row per user | the profile is keyed by the user |
| `drivers` | `drivers_user_id_fkey` | `user_id` references `users` | a driver row without a user is not a login |
| `drivers` | `drivers_status_check` | `online` or `offline` | presence in Redis is not the stored status |
| `rides` | `rides_rider_id_fkey` | `rider_id` references `users` | a ride needs an account |
| `rides` | `rides_driver_id_fkey` | `driver_id`, when set, references `users` | an assigned driver must be an account. Null is allowed before accept |
| `rides` | `rides_status_check` | status is one of the ten shared ride states | the shared state machine only checks transitions the API performs. The column must also reject an unknown value |
| `rides` | `rides_pickup_lat_check`, `rides_dropoff_lat_check` | latitude is between -90 and 90 | map input is checked in the API, and SQL can still insert a bad point |
| `rides` | `rides_pickup_lng_check`, `rides_dropoff_lng_check` | longitude is between -180 and 180 | same as latitude |
| `rides` | `rides_fare_check` | `fare_cents >= 0` | fare is computed in the API. The column still rejects a negative amount |
| `rides` | `rides_idempotency_key_key` | one ride row per stored create key | the unique violation is how a retried insert finds the original ride |
| `ride_events` | `ride_events_ride_id_fkey` | every event belongs to a ride | history without a ride cannot be loaded |
| `ride_events` | `ride_events_to_status_check` | `to_status` is a known ride state | the audit row must name a real status |
| `ride_events` | `ride_events_from_status_check` | `from_status` is null or a known ride state | the first event has no previous status. Any other value is not a ride state |
| `ride_events` | `ride_events_actor_id_fkey` | `actor_id`, when set, references `users` | null is used when offer expiry has no actor. A non-null actor must be an account. Delete behavior is the Postgres default, `NO ACTION`, so history is not removed with a user |
| `idempotency_keys` | primary key `(user_id, key)` | one stored response per user and key | Redis is a cache. Two requests can miss it and both try to insert |
| `idempotency_keys` | `idempotency_keys_user_id_fkey` | `user_id` references `users` | a replay row must belong to an account |
| `notifications` | `notifications_pkey` on `id` | one notification row per event id | the consumer inserts `ON CONFLICT (id) DO NOTHING`. The primary key is what makes the second delivery a no-op |
| `outbox_events` | `outbox_events_event_id_key` | `event_id` is unique | retries and duplicate publishes reuse the same id |
| `outbox_events` | status check | `pending` or `published` | the publisher only claims `pending` rows |
| `outbox_events` | `attempt_count >= 0` | a failure count cannot be negative | attempt count drives the backoff |
| `outbox_events` | `outbox_published_at_check` | `pending` has no `published_at`; `published` has one | a row is not published until the confirm update sets both fields together |

Foreign keys do not use `ON DELETE CASCADE`. Rides, ride events, and idempotency rows are history. Deleting a user is not an API operation. If it is added later, the delete has to say what happens to that history.

`notifications.ride_id` is not a foreign key. The consumer records the message it was given. A missing ride row would otherwise fail the insert, retry, and then dead-letter a message the worker already understood. `outbox_events.aggregate_id` is not a foreign key either. The table stores `aggregate_type` plus an id, and the ride write and the outbox insert already share one transaction in the service.

`rides.idempotency_key` is unique across the whole table. `idempotency_keys` is unique per user. The create path stores `ride.create:` plus the client key, without the user id, in `rides.idempotency_key`. Two riders who send the same `Idempotency-Key` can collide on that column. That is the current API behavior and was not changed.

## Indexes

| Table | Index | Query | Reason | Write cost |
| --- | --- | --- | --- | --- |
| `rides` | `rides_rider_status_idx (rider_id, status)` | active ride, rider branch | `activeRide` filters one rider and a status list | updated when a ride is inserted or its rider or status changes |
| `rides` | `rides_driver_status_idx (driver_id, status)` | active ride, driver branch | same query, driver side | updated when assignment or status changes |
| `rides` | `rides_offered_updated_idx (updated_at) WHERE status = 'offered'` | stale offer scan | `expireOfferedRides` reads only offered rows older than the offer TTL | maintained only while a ride is `offered` |
| `rides` | primary key `id` | get ride, accept, sockets | point lookup | one entry per ride |
| `rides` | unique `idempotency_key` | replay after a unique violation on create | find the ride that already used this create key | one entry per created ride |
| `ride_events` | `ride_events_ride_created_idx (ride_id, created_at)` | events for one ride in time order | the API does not currently list history. Tests and any future history read use `ride_id`. Postgres does not index a foreign key column on its own | one entry per transition |
| `idempotency_keys` | primary key `(user_id, key)` | replay after a Redis miss | the lookup is exactly the primary key | one entry per stored response. No second index |
| `notifications` | primary key `id` | consumer dedupe | `id` is the event id. A second index on the same column would only add writes | one entry per notification |
| `outbox_events` | `outbox_pending_idx (created_at, id) WHERE status = 'pending'` | publisher claim | see Outbox below | pending rows only. Published rows leave the index |
| `outbox_events` | unique `event_id` | duplicate publish identity | the consumer dedupes on this id | one entry per event |
| `users` | unique `email` | login and registration | lookup by email | one entry per user |

`rides_offered_idx`, a GIN index on `offered_driver_ids`, was removed. `listOffers` uses `$1 = ANY (offered_driver_ids)`. On 8,002 rides and 400 offered rows, that predicate did not touch the GIN index. Rewriting it to `offered_driver_ids @> ARRAY[$1]` did use the GIN index and was slower on that dataset (0.444 ms and 112 buffer hits, against 0.216 ms and 179 buffer hits for `ANY`). The partial offered index already limits the scan to rides in `offered`. The GIN index was write cost on every offer change without a measured gain, so it is not kept.

An index on `(status, updated_at)` for every status was not added. Expiry only reads `offered`, and the partial index covers that. A partial index of non-terminal rides for the metrics count was not added. That count runs once per Prometheus scrape, not on a user request.

## Query plans

Seed, rolled back: 4,502 rides (1,500 offered), 3,000 pending outbox rows (about one third not yet available), 4,511 ride events, 3,004 idempotency keys. Postgres 16 in Docker. `EXPLAIN (ANALYZE, BUFFERS)` after `ANALYZE`. Times are for this laptop and this seed.

### Pending outbox lookup

```text
Limit  (actual time=0.018..0.019 rows=1 loops=1)
  Buffers: shared hit=4
  ->  LockRows
        ->  Index Scan using outbox_pending_idx on outbox_events
              Filter: ((status = 'pending') AND (available_at <= now()))
              Rows Removed by Filter: 1
              Buffers: shared hit=3
Execution Time: 0.038 ms
```

The index is `(created_at, id)` where `status = 'pending'`. The scan follows the `ORDER BY` and stops at the first row whose `available_at` has arrived. An index on `(available_at, created_at, id)` filtered the time range and then sorted the matching rows (0.722 ms and a 2,000-row sort on an earlier seed of the same shape). That index was replaced.

### Active rider ride

```text
Limit  (actual time=0.036..0.037 rows=1 loops=1)
  Buffers: shared hit=10
  ->  Bitmap Heap Scan on rides
        ->  BitmapOr
              ->  Bitmap Index Scan on rides_rider_status_idx
                    Index Cond: (rider_id = ...)
              ->  Bitmap Index Scan on rides_driver_status_idx
                    Index Cond: ((driver_id = ...) AND (status = ANY (...)))
Execution Time: 0.113 ms
```

The `OR` uses both indexes when each user has a few rides. The same query sequential-scanned when one rider owned most of an 8,000-row seed. The query was left as written. The indexes already match a normal desk refresh.

### Driver offers

```text
Sort  (actual time=0.471..0.492 rows=612 loops=1)
  ->  Bitmap Heap Scan on rides
        Recheck Cond: (status = 'offered')
        Filter: (... = ANY (offered_driver_ids))
        Rows Removed by Filter: 888
        ->  Bitmap Index Scan on rides_offered_updated_idx
Execution Time: 0.550 ms
```

1,500 offered rows, 612 containing the driver. The partial index finds offered rides. Membership is a filter. This seed matched many rows, so the filter removed 888 of 1,500. A driver with a handful of offers would read fewer heap pages. No extra index was added.

### Stale offers

```text
Index Scan using rides_offered_updated_idx on rides
  Index Cond: (updated_at < (now() - '00:02:00'::interval))
Execution Time: 0.027 ms
```

The seed's `updated_at` values were newer than 120 seconds, so the scan returned 0 rows. The plan still used the partial index. An earlier seed with older `updated_at` values also used this index and returned 1,100 rows in 0.231 ms.

### Ride event history

```text
Index Scan using ride_events_ride_created_idx on ride_events
  Index Cond: (ride_id = ...)
Execution Time: 0.023 ms
```

One event for that ride. The index supports `WHERE ride_id = ? ORDER BY created_at`. The HTTP API does not call this query today.

### Idempotency replay

```text
Index Scan using idempotency_keys_pkey on idempotency_keys
  Index Cond: ((user_id = ...) AND (key = 'key-1'))
Execution Time: 0.026 ms
```

The Redis miss path is a primary-key lookup. No second index.

## Idempotency

Redis stores `idem:{userId}:{key}` for 24 hours. `readIdempotency` reads Redis first and, on a miss or a Redis error, reads `idempotency_keys` by `(user_id, key)`. `saveIdempotency` inserts into Postgres with `ON CONFLICT (user_id, key) DO NOTHING`, then fills Redis. A lost Redis key does not lose the stored response. Two users may store the same key. One user may not store it twice.

## Outbox

The publisher claims with:

```sql
SELECT id, event_id, event_type, payload, attempt_count
FROM outbox_events
WHERE status = 'pending' AND available_at <= now()
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1
```

`outbox_pending_idx` is a partial btree on `(created_at, id)` for `status = 'pending'`. It matches the order, so `LIMIT 1` can stop at the first available row. `available_at` stays a filter because `now()` cannot be stored in an index predicate. The claim then moves `available_at` forward and commits before RabbitMQ is called. A published row leaves this index.
