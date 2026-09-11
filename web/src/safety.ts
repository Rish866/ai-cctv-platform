// Shared safety/security constants for the web UI. Mirrors server/src/ai/types.ts.

export const FIRE_TYPES = ['FIRE', 'SMOKE', 'FIRE_AND_SMOKE'] as const;
export const SECURITY_TYPES = [
  'UNAUTHORIZED_ENTRY',
  'AFTER_HOURS_ACTIVITY',
  'OBJECT_REMOVED',
  'LOITERING_SECURITY',
  'UNAUTHORIZED_VEHICLE',
  'RESTRICTED_ZONE_ACTIVITY',
] as const;

export const NOTIFY_CHANNELS = ['EMAIL', 'SMS', 'WEBHOOK', 'IN_APP', 'WHATSAPP', 'PUSH'] as const;

export const INCIDENT_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'RESOLVED',
  'DISMISSED',
  'FALSE_POSITIVE',
] as const;

// Professional, non-overclaiming labels (spec §38).
export const EVENT_LABEL: Record<string, string> = {
  FIRE: 'Fire Detected',
  SMOKE: 'Smoke Detected',
  FIRE_AND_SMOKE: 'Fire & Smoke (Critical)',
  UNAUTHORIZED_ENTRY: 'Unauthorized Entry',
  AFTER_HOURS_ACTIVITY: 'After-Hours Activity',
  OBJECT_REMOVED: 'Object Removed',
  LOITERING_SECURITY: 'Suspicious Loitering',
  UNAUTHORIZED_VEHICLE: 'Unauthorized Vehicle',
  RESTRICTED_ZONE_ACTIVITY: 'Restricted Zone Activity',
  PERSON_DETECTION: 'Person Detected',
  VEHICLE_DETECTION: 'Vehicle Detected',
  RESTRICTED_AREA_INTRUSION: 'Restricted Area Intrusion',
  LINE_CROSSING: 'Line Crossing',
  LOITERING: 'Loitering',
  CROWD_DETECTION: 'Crowd Detected',
  HELMET_DETECTION: 'Helmet Compliance',
  SAFETY_VEST_DETECTION: 'Safety Vest Compliance',
};

export function eventLabel(t: string): string {
  return EVENT_LABEL[t] ?? t;
}

export function isCriticalType(t: string): boolean {
  return t === 'FIRE' || t === 'FIRE_AND_SMOKE';
}
