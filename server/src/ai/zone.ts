/**
 * Zone geometry evaluation. Determines whether a detection (its bounding-box
 * center) falls inside a configured zone. All coordinates are normalized [0,1]
 * so they are resolution-independent.
 *
 * Supported zone geometry (stored in zones.geometry jsonb):
 *   { "type": "polygon",   "points": [[x,y],[x,y],...] }
 *   { "type": "rectangle", "x": .., "y": .., "width": .., "height": .. }
 * An empty/absent geometry means "whole frame" (the detection always matches),
 * so a zone with no drawn area still triggers its rules.
 */

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ZoneGeometry {
  type?: 'polygon' | 'rectangle';
  points?: Array<[number, number]>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export function bboxCenter(b: BBox): { cx: number; cy: number } {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

/** Ray-casting point-in-polygon for normalized coordinates. */
export function pointInPolygon(px: number, py: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Returns true if the detection's center is inside the zone geometry. Empty
 * geometry => whole frame (always true).
 */
export function detectionInZone(bbox: BBox, geometry: ZoneGeometry | null | undefined): boolean {
  const { cx, cy } = bboxCenter(bbox);
  if (!geometry || Object.keys(geometry).length === 0) return true;
  if (geometry.type === 'rectangle' || (geometry.width != null && geometry.height != null)) {
    const gx = geometry.x ?? 0;
    const gy = geometry.y ?? 0;
    const gw = geometry.width ?? 1;
    const gh = geometry.height ?? 1;
    return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
  }
  if (geometry.type === 'polygon' && Array.isArray(geometry.points) && geometry.points.length >= 3) {
    return pointInPolygon(cx, cy, geometry.points);
  }
  // Unknown geometry => be permissive (whole frame) rather than silently drop.
  return true;
}
