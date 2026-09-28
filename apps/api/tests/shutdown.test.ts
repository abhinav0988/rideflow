import pino from "pino";
import { runShutdown, ShutdownState } from "../src/shutdown";

describe("graceful shutdown", () => {
  it("is idempotent and closes dependencies after marking unready", async () => {
    const state: ShutdownState = { acceptingTraffic: true };
    const calls: string[] = [];
    const steps = {
      state,
      log: pino({ level: "silent" }),
      timeoutMs: 1000,
      stopBackground: async () => {
        calls.push("background");
      },
      closeHttp: async () => {
        calls.push("http");
      },
      closeSockets: async () => {
        calls.push("sockets");
      },
      closeRabbit: async () => {
        calls.push("rabbit");
      },
      closeRedis: async () => {
        calls.push("redis");
      },
      closePostgres: async () => {
        calls.push("postgres");
      },
    };
    await Promise.all([runShutdown(steps), runShutdown(steps)]);
    expect(state.acceptingTraffic).toBe(false);
    expect(calls).toEqual(["background", "http", "sockets", "rabbit", "redis", "postgres"]);
  });
});
