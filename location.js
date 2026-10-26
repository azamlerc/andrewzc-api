// Canonical entity location: GeoJSON Point, longitude before latitude.
export function pointLatLon(location) {
  if (location?.type !== "Point" || !Array.isArray(location.coordinates)
      || location.coordinates.length !== 2) return null;
  const [lon, lat] = location.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function formatLocation(location) {
  const point = pointLatLon(location);
  return point ? `${point.lat}, ${point.lon}` : "";
}

// Validate before writing, including arbitrary fields supplied by API/AI clients.
// Existing legacy fields in MongoDB are deliberately left untouched.
export function assertLocationFields(fields) {
  const keys = Object.keys(fields);
  if (keys.some(key => key === "coords" || key.startsWith("coords."))) {
    throw Object.assign(new Error("coords is deprecated; use location as a GeoJSON Point."), { status: 400 });
  }
  if (keys.some(key => key.startsWith("location."))
      || (Object.hasOwn(fields, "location") && fields.location !== null && !pointLatLon(fields.location))) {
    throw Object.assign(new Error("location must be null or a GeoJSON Point with finite [longitude, latitude] coordinates in range."), { status: 400 });
  }
}
