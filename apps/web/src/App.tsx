import { useState } from "react";
import { AuthScreen } from "./AuthScreen";
import { readSession, Session, writeSession } from "./api";
import { DriverScreen } from "./DriverScreen";
import { RiderScreen } from "./RiderScreen";

export function App() {
  const [session, setSession] = useState<Session | null>(() => readSession());

  function save(next: Session | null) {
    writeSession(next);
    setSession(next);
  }

  if (!session) return <AuthScreen onSession={save} />;
  if (session.user.role === "driver") {
    return <DriverScreen session={session} onLogout={() => save(null)} />;
  }
  return <RiderScreen session={session} onLogout={() => save(null)} />;
}
