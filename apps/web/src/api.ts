import { LatLng, RideDto, UserDto, UserRole } from "@rideflow/shared";

export interface Session {
  token: string;
  user: UserDto;
}

const SESSION_KEY = "rideflow.session";

export function readSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function writeSession(session: Session | null): void {
  if (!session) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(body.error || "Request failed", response.status);
  return body as T;
}

export function register(input: {
  email: string;
  password: string;
  name: string;
  role: UserRole;
}): Promise<{ token: string; user: UserDto }> {
  return api("/api/auth/register", { method: "POST", body: JSON.stringify(input) });
}

export function login(email: string, password: string): Promise<{ token: string; user: UserDto }> {
  return api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function createRide(token: string, pickup: LatLng, dropoff: LatLng, idempotencyKey: string) {
  return api<RideDto>("/api/rides", {
    method: "POST",
    token,
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      dropoffLat: dropoff.lat,
      dropoffLng: dropoff.lng,
    }),
  });
}

export function rideAction(token: string, rideId: string, action: string, idempotencyKey?: string) {
  const headers = new Headers();
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return api<RideDto>(`/api/rides/${rideId}/${action}`, { method: "POST", token, headers });
}

export function activeRide(token: string) {
  return api<{ ride: RideDto | null }>("/api/rides/active", { token });
}

export function offers(token: string) {
  return api<{ rides: RideDto[] }>("/api/rides/offers", { token });
}

export function driverProfile(token: string) {
  return api<{ driver: { id: string; status: string } }>("/api/drivers/me", { token });
}

export function setOnline(token: string, lat: number, lng: number) {
  return api("/api/drivers/online", { method: "POST", token, body: JSON.stringify({ lat, lng }) });
}

export function setOffline(token: string) {
  return api("/api/drivers/offline", { method: "POST", token });
}

export function pushLocation(token: string, lat: number, lng: number, rideId?: string) {
  return api("/api/drivers/location", {
    method: "POST",
    token,
    body: JSON.stringify({ lat, lng, rideId }),
  });
}
