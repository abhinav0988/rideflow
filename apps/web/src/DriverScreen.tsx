import { RideDto } from "@rideflow/shared";
import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { driverProfile, offers, pushLocation, rideAction, Session, setOffline, setOnline } from "./api";
import { CITY, MapCanvas, stepToward } from "./map";

export function DriverScreen({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [online, setOnlineState] = useState(false);
  const [simulate, setSimulate] = useState(true);
  const [position, setPosition] = useState(CITY);
  const [offerList, setOfferList] = useState<RideDto[]>([]);
  const [trip, setTrip] = useState<RideDto | null>(null);
  const [error, setError] = useState("");
  const positionRef = useRef(position);
  const tripRef = useRef(trip);
  const keys = useRef<Record<string, string>>({});
  positionRef.current = position;
  tripRef.current = trip;

  useEffect(() => {
    driverProfile(session.token)
      .then((result) => {
        if (result.driver.status === "online") setOnlineState(true);
      })
      .catch(() => undefined);
  }, [session.token]);

  useEffect(() => {
    const socket: Socket = io({ auth: { token: session.token } });
    socket.on("ride:offer", (ride: RideDto) => {
      setOfferList((current) => [ride, ...current.filter((item) => item.id !== ride.id)]);
    });
    socket.on("ride:update", (ride: RideDto) => {
      if (ride.driverId === session.user.id && ["accepted", "arrived", "in_progress"].includes(ride.status)) {
        setTrip(ride);
        setOfferList((current) => current.filter((item) => item.id !== ride.id));
      }
      if (["cancelled", "expired", "completed", "no_drivers"].includes(ride.status)) {
        setTrip((current) => (current?.id === ride.id ? ride : current));
        setOfferList((current) => current.filter((item) => item.id !== ride.id));
      }
    });
    socket.on("driver:error", (payload: { error: string }) => setError(payload.error));
    return () => {
      socket.close();
    };
  }, [session.token, session.user.id]);

  useEffect(() => {
    if (!online) return;
    const timer = window.setInterval(() => {
      offers(session.token)
        .then((result) => setOfferList(result.rides))
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [online, session.token]);

  useEffect(() => {
    if (!online || !simulate) return;
    const timer = window.setInterval(() => {
      const currentTrip = tripRef.current;
      const target =
        currentTrip && currentTrip.status === "accepted"
          ? currentTrip.pickup
          : currentTrip && (currentTrip.status === "arrived" || currentTrip.status === "in_progress")
            ? currentTrip.dropoff
            : {
                lat: CITY.lat + Math.sin(Date.now() / 8000) * 0.01,
                lng: CITY.lng + Math.cos(Date.now() / 8000) * 0.01,
              };
      const next = stepToward(positionRef.current, target);
      positionRef.current = next;
      setPosition(next);
      const rideId =
        currentTrip && ["accepted", "arrived", "in_progress"].includes(currentTrip.status)
          ? currentTrip.id
          : undefined;
      pushLocation(session.token, next.lat, next.lng, rideId).catch((err) => {
        setError(err instanceof Error ? err.message : "Location update failed");
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [online, simulate, session.token]);

  async function goOnline() {
    setError("");
    try {
      await setOnline(session.token, positionRef.current.lat, positionRef.current.lng);
      setOnlineState(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not go online");
    }
  }

  async function goOffline() {
    await setOffline(session.token);
    setOnlineState(false);
    setOfferList([]);
  }

  async function accept(ride: RideDto) {
    keys.current[ride.id] ??= crypto.randomUUID();
    try {
      const accepted = await rideAction(session.token, ride.id, "accept", keys.current[ride.id]);
      setTrip(accepted);
      setOfferList((current) => current.filter((item) => item.id !== ride.id));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept");
    }
  }

  async function reject(ride: RideDto) {
    await rideAction(session.token, ride.id, "reject");
    setOfferList((current) => current.filter((item) => item.id !== ride.id));
  }

  async function advance(action: "arrive" | "start" | "complete" | "cancel") {
    if (!trip) return;
    setTrip(await rideAction(session.token, trip.id, action));
  }

  const driving = trip && ["accepted", "arrived", "in_progress"].includes(trip.status);

  return (
    <div className="desk">
      <header className="topbar">
        <div>
          <p className="eyebrow">Driver</p>
          <strong>{session.user.name}</strong>
        </div>
        <button type="button" onClick={onLogout}>
          Log out
        </button>
      </header>
      <MapCanvas
        driver={position}
        pickup={driving ? trip?.pickup : offerList[0]?.pickup}
        dropoff={driving ? trip?.dropoff : offerList[0]?.dropoff}
      />
      <aside className="panel card">
        <h2>{online ? "On the road" : "You are offline"}</h2>
        <label className="check">
          <input type="checkbox" checked={simulate} onChange={(event) => setSimulate(event.target.checked)} />
          Simulate movement
        </label>
        {error ? <p className="error">{error}</p> : null}
        {!online ? (
          <button className="primary" type="button" onClick={goOnline}>
            Go online
          </button>
        ) : (
          <button type="button" onClick={goOffline}>
            Go offline
          </button>
        )}
        {driving && trip ? (
          <section>
            <p className="fare">{trip.status.replaceAll("_", " ")}</p>
            <div className="actions">
              {trip.status === "accepted" ? (
                <button className="primary" type="button" onClick={() => advance("arrive")}>
                  Arrived
                </button>
              ) : null}
              {trip.status === "arrived" ? (
                <button className="primary" type="button" onClick={() => advance("start")}>
                  Start trip
                </button>
              ) : null}
              {trip.status === "in_progress" ? (
                <button className="primary" type="button" onClick={() => advance("complete")}>
                  Complete
                </button>
              ) : null}
              <button type="button" onClick={() => advance("cancel")}>
                Cancel
              </button>
            </div>
          </section>
        ) : (
          <section>
            <h3>Offers</h3>
            {offerList.length === 0 ? <p className="muted">Nearby requests show up here.</p> : null}
            {offerList.map((ride) => (
              <article key={ride.id} className="offer">
                <p>{(ride.fareCents / 100).toFixed(2)} fare</p>
                <div className="actions">
                  <button className="primary" type="button" onClick={() => accept(ride)}>
                    Accept
                  </button>
                  <button type="button" onClick={() => reject(ride)}>
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
      </aside>
    </div>
  );
}
