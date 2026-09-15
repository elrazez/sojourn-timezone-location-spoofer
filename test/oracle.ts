// The independent oracle the tests measure distances with: the haversine great-circle distance on a
// sphere of the mean Earth radius. src goes the other way, from a distance and a bearing to a point,
// so a point that reads right here is a point the code really put where it said it did.
// ponytail: the two share this one constant, so a wrong Earth radius would cancel out and the Jitter
// bound would still read right; an oracle on a different sphere model would catch that.

export const EARTH_RADIUS = 6371000;

export function metresApart(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const half =
    Math.sin(radians(to.latitude - from.latitude) / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(radians(to.longitude - from.longitude) / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(half));
}
