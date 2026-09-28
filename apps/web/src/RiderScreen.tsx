import { RideDto, UserDto } from "@rideflow/shared";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { io, Socket } from "socket.io-client";
import { activeRide, createRide, rideAction, Session } from "./api";
import { MapCanvas } from "./map";

export function RiderScreen({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const user = session.user as UserDto;
  const [pickup, setPickup] = useState<{ lat: number; lng: number } | null>(null);
  const [dropoff, setDropoff] = useState<{ lat: number; lng: number } | null>(null);
  const [target, setTarget] = useState<"pickup" | "dropoff">("pickup");
  const [ride, setRide] = useState<RideDto | null>(null);
  const [driver, setDriver] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [ride?.id]);

  useEffect(() => {
    let socket: Socket | null = null;
    activeRide(session.token)
      .then((result) => setRide(result.ride))
      .catch(() => undefined);
    socket = io({ auth: { token: session.token } });
    socket.on("ride:update", (next: RideDto) => {
      if (next.riderId === user.id) setRide(next);
    });
    socket.on("ride:location", (point: { lat: number; lng: number; rideId: string }) => {
      setRide((current) => {
        if (current && current.id === point.rideId) setDriver({ lat: point.lat, lng: point.lng });
        return current;
      });
    });
    return () => {
      socket?.close();
    };
  }, [session.token, user.id]);

  useEffect(() => {
    if (!ride) return;
    const socket = io({ auth: { token: session.token } });
    socket.emit("ride:join", ride.id);
    socket.on("ride:location", (point: { lat: number; lng: number }) => {
      setDriver({ lat: point.lat, lng: point.lng });
    });
    socket.on("ride:update", (next: RideDto) => setRide(next));
    return () => {
      socket.close();
    };
  }, [ride?.id, session.token]);

  async function requestRide(event: FormEvent) {
    event.preventDefault();
    if (!pickup || !dropoff) return;
    setPending(true);
    setError("");
    try {
      const created = await createRide(session.token, pickup, dropoff, idempotencyKey);
      setRide(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request a ride");
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    if (!ride) return;
    setRide(await rideAction(session.token, ride.id, "cancel"));
  }

  const open = ride && !["completed", "cancelled", "expired", "no_drivers"].includes(ride.status);

  return (
    <div className="desk">
      <header className="topbar">
        <div>
          <p className="eyebrow">Rider</p>
          <strong>{user.name}</strong>
        </div>
        <button type="button" onClick={onLogout}>
          Log out
        </button>
      </header>
      <MapCanvas
        pickup={pickup ?? ride?.pickup}
        dropoff={dropoff ?? ride?.dropoff}
        driver={driver}
        onPick={
          open
            ? undefined
            : (point) => {
                if (target === "pickup") {
                  setPickup(point);
                  setTarget("dropoff");
                } else {
                  setDropoff(point);
                }
              }
        }
      />
      <aside className="panel card">
        <h2>{open ? humanStatus(ride.status) : "Where to?"}</h2>
        {open && ride ? (
          <>
            <p className="fare">{money(ride.fareCents)}</p>
            <p className="muted">Status updates arrive on the ride socket, not a refresh loop.</p>
            {ride.driverId ? <p>Driver assigned.</p> : <p>Waiting for a nearby driver to accept.</p>}
            <button type="button" onClick={cancel}>
              Cancel ride
            </button>
          </>
        ) : (
          <form onSubmit={requestRide}>
            <div className="segment">
              <button type="button" className={target === "pickup" ? "on" : ""} onClick={() => setTarget("pickup")}>
                Pickup
              </button>
              <button type="button" className={target === "dropoff" ? "on" : ""} onClick={() => setTarget("dropoff")}>
                Dropoff
              </button>
            </div>
            <p className="muted">Click the map. Pickup is lime, dropoff is coral.</p>
            {ride ? <p>Last ride: {humanStatus(ride.status)}.</p> : null}
            {error ? <p className="error">{error}</p> : null}
            <button className="primary" disabled={!pickup || !dropoff || pending}>
              {pending ? "Requesting…" : "Request ride"}
            </button>
          </form>
        )}
      </aside>
    </div>
  );
}

function humanStatus(status: RideDto["status"]): string {
  return status.replaceAll("_", " ");
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
