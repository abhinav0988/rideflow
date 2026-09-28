import { LatLng } from "@rideflow/shared";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMapEvents } from "react-leaflet";

export const CITY: LatLng = { lat: 12.9716, lng: 77.5946 };

export function MapCanvas({
  pickup,
  dropoff,
  driver,
  onPick,
}: {
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  driver?: LatLng | null;
  onPick?: (point: LatLng) => void;
}) {
  return (
    <MapContainer center={[CITY.lat, CITY.lng]} zoom={13} className="map">
      <TileLayer
        attribution='&copy; OpenStreetMap &copy; CARTO'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      {onPick ? <PickLayer onPick={onPick} /> : null}
      {pickup ? (
        <CircleMarker center={[pickup.lat, pickup.lng]} radius={10} pathOptions={{ color: "#d6ff4a", fillColor: "#d6ff4a", fillOpacity: 0.9 }}>
          <Tooltip permanent>Pickup</Tooltip>
        </CircleMarker>
      ) : null}
      {dropoff ? (
        <CircleMarker center={[dropoff.lat, dropoff.lng]} radius={10} pathOptions={{ color: "#ff8a5b", fillColor: "#ff8a5b", fillOpacity: 0.9 }}>
          <Tooltip permanent>Dropoff</Tooltip>
        </CircleMarker>
      ) : null}
      {driver ? (
        <CircleMarker center={[driver.lat, driver.lng]} radius={11} pathOptions={{ color: "#8ecbff", fillColor: "#8ecbff", fillOpacity: 0.95 }}>
          <Tooltip permanent>Driver</Tooltip>
        </CircleMarker>
      ) : null}
    </MapContainer>
  );
}

function PickLayer({ onPick }: { onPick: (point: LatLng) => void }) {
  useMapEvents({
    click(event) {
      onPick({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
  });
  return null;
}

export function stepToward(from: LatLng, to: LatLng, step = 0.004): LatLng {
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const distance = Math.hypot(dLat, dLng);
  if (distance < step) return { ...to };
  return { lat: from.lat + (dLat / distance) * step, lng: from.lng + (dLng / distance) * step };
}
