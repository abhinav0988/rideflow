import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RabbitMQContainer, StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";

export interface Infra {
  databaseUrl: string;
  redisUrl: string;
  rabbitUrl: string;
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  rabbit: StartedRabbitMQContainer;
}

let starting: Promise<Infra> | null = null;

export function infra(): Promise<Infra> {
  if (!starting) starting = boot();
  return starting;
}

async function boot(): Promise<Infra> {
  const [postgres, redis, rabbit] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").start(),
    new RedisContainer("redis:7-alpine").start(),
    new RabbitMQContainer("rabbitmq:3-alpine").start(),
  ]);
  return {
    databaseUrl: postgres.getConnectionUri(),
    redisUrl: redis.getConnectionUrl(),
    rabbitUrl: rabbit.getAmqpUrl(),
    postgres,
    redis,
    rabbit,
  };
}
