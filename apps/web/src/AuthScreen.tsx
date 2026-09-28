import { FormEvent, useState } from "react";
import { UserRole } from "@rideflow/shared";
import { login, register, Session } from "./api";

export function AuthScreen({ onSession }: { onSession: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [role, setRole] = useState<UserRole>("rider");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result =
        mode === "login"
          ? await login(email, password)
          : await register({ email, password, name, role });
      onSession(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-copy">
        <p className="eyebrow">RideFlow</p>
        <h1>A ride desk you can defend in an interview.</h1>
        <p>
          Nearby drivers live in Redis. One ride can be accepted once. Location and status move over
          Socket.IO, and failed notifications land on a dead-letter queue.
        </p>
      </section>
      <form className="card auth-card" onSubmit={submit}>
        <div className="segment">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>
            Sign in
          </button>
          <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>
            Create account
          </button>
        </div>
        {mode === "register" ? (
          <>
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label>
              I am a
              <select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
                <option value="rider">Rider</option>
                <option value="driver">Driver</option>
              </select>
            </label>
          </>
        ) : null}
        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" type="submit" disabled={pending}>
          {pending ? "Working…" : mode === "login" ? "Enter" : "Create account"}
        </button>
      </form>
    </main>
  );
}
