import { Logger } from "pino";

export interface ShutdownState {
  acceptingTraffic: boolean;
  done?: Promise<void>;
}

export interface ShutdownSteps {
  state: ShutdownState;
  log: Logger;
  timeoutMs: number;
  stopBackground: () => Promise<void>;
  closeHttp: () => Promise<void>;
  closeSockets: () => Promise<void>;
  closeRabbit: () => Promise<void>;
  closeRedis: () => Promise<void>;
  closePostgres: () => Promise<void>;
}

export function runShutdown(steps: ShutdownSteps): Promise<void> {
  if (steps.state.done) return steps.state.done;
  steps.state.acceptingTraffic = false;
  steps.state.done = execute(steps);
  return steps.state.done;
}

async function execute(steps: ShutdownSteps): Promise<void> {
  steps.log.info("shutdown: marked unready");
  const drain = (async () => {
    steps.log.info("shutdown: stopping consumers");
    await steps.stopBackground();
    steps.log.info("shutdown: draining http");
    await steps.closeHttp();
  })();
  let timedOut = false;
  await Promise.race([
    drain,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, steps.timeoutMs);
    }),
  ]);
  if (timedOut) steps.log.warn({ timeoutMs: steps.timeoutMs }, "shutdown: drain timed out");
  steps.log.info("shutdown: closing sockets");
  await steps.closeSockets().catch((err) => steps.log.error({ err }, "shutdown: socket close failed"));
  steps.log.info("shutdown: closing rabbitmq");
  await steps.closeRabbit().catch((err) => steps.log.error({ err }, "shutdown: rabbit close failed"));
  steps.log.info("shutdown: closing redis");
  await steps.closeRedis().catch((err) => steps.log.error({ err }, "shutdown: redis close failed"));
  steps.log.info("shutdown: closing postgres");
  await steps.closePostgres().catch((err) => steps.log.error({ err }, "shutdown: postgres close failed"));
  steps.log.info("shutdown: complete");
}
