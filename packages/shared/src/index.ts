export const RIDE_STATUSES = [
  "requested",
  "matching",
  "offered",
  "accepted",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
  "expired",
  "no_drivers",
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

export type UserRole = "rider" | "driver";

export const RideEvents = {
  Requested: "ride.requested",
  Accepted: "ride.accepted",
  Completed: "ride.completed",
  Cancelled: "ride.cancelled",
} as const;

export type RideEventName = (typeof RideEvents)[keyof typeof RideEvents];

const TRANSITIONS: Record<RideStatus, readonly RideStatus[]> = {
  requested: ["matching", "cancelled"],
  matching: ["offered", "no_drivers", "cancelled", "expired"],
  offered: ["accepted", "cancelled", "expired", "no_drivers"],
  accepted: ["arrived", "cancelled"],
  arrived: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  expired: [],
  no_drivers: [],
};

export function canTransition(from: RideStatus, to: RideStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RideStatus, to: RideStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal ride transition: ${from} -> ${to}`);
  }
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RideDto {
  id: string;
  riderId: string;
  driverId: string | null;
  status: RideStatus;
  pickup: LatLng;
  dropoff: LatLng;
  fareCents: number;
  offeredDriverIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const earthKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function quoteFareCents(pickup: LatLng, dropoff: LatLng): number {
  const km = haversineKm(pickup, dropoff);
  return Math.max(200, Math.round(200 + km * 100));
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
