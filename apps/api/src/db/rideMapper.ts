import { RideDto, RideStatus } from "@rideflow/shared";

export interface RideRow {
  id: string;
  rider_id: string;
  driver_id: string | null;
  status: RideStatus;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  fare_cents: number;
  offered_driver_ids: string[];
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export function mapRide(row: RideRow): RideDto {
  return {
    id: row.id,
    riderId: row.rider_id,
    driverId: row.driver_id,
    status: row.status,
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng },
    fareCents: row.fare_cents,
    offeredDriverIds: row.offered_driver_ids ?? [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
