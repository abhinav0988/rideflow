import http from "http";
import { Server } from "socket.io";
import { io as ioClient, Socket } from "socket.io-client";
import { useRedisAdapter } from "../src/realtime/gateway";
import { infra } from "./infra";

describe("socket.io redis adapter", () => {
  it("delivers a ride-room event from one API node to a client on another", async () => {
    const stack = await infra();
    const serverA = http.createServer();
    const serverB = http.createServer();
    const ioA = new Server(serverA);
    const ioB = new Server(serverB);
    const closeA = await useRedisAdapter(ioA, stack.redisUrl);
    const closeB = await useRedisAdapter(ioB, stack.redisUrl);

    ioB.on("connection", (socket) => {
      socket.on("join", (room: string, ack: () => void) => {
        socket.join(room);
        ack();
      });
    });

    const portB = await listen(serverB);
    await listen(serverA);
    const client = ioClient(`http://127.0.0.1:${portB}`, { transports: ["websocket"] });
    await waitFor(client, "connect");
    await new Promise<void>((resolve) => client.emit("join", "ride:42", () => resolve()));

    const update = new Promise<{ ok: boolean }>((resolve) => {
      client.on("ride:update", resolve);
    });
    ioA.to("ride:42").emit("ride:update", { ok: true });
    await expect(update).resolves.toEqual({ ok: true });

    client.close();
    await closeA();
    await closeB();
    ioA.close();
    ioB.close();
    serverA.close();
    serverB.close();
  });
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      resolve(address.port);
    });
  });
}

function waitFor(socket: Socket, event: string): Promise<void> {
  return new Promise((resolve) => socket.on(event, () => resolve()));
}
