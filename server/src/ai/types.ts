/**
 * Safety & Security AI — shared type constants.
 *
 * These are the NEW ai_rule_type / event_type values added by migration 0002.
 * The existing 8 detection types are unchanged and continue to flow through the
 * same event pipeline; these simply extend the same enum.
 */

// Existing (pre-add-on) types — kept here for a single source of truth.
export const BASE_AI_TYPES = [
  'PERSON_DETECTION',
  'VEHICLE_DETECTION',
  'RESTRICTED_AREA_INTRUSION',
  'LINE_CROSSING',
  'LOITERING',
  'CROWD_DETECTION',
  'HELMET_DETECTION',
  'SAFETY_VEST_DETECTION',
] as const;

export const FIRE_TYPES = ['FIRE', 'SMOKE', 'FIRE_AND_SMOKE'] as const;

export const SECURITY_TYPES = [
  'UNAUTHORIZED_ENTRY',
  'AFTER_HOURS_ACTIVITY',
  'OBJECT_REMOVED',
  'LOITERING_SECURITY',
  'UNAUTHORIZED_VEHICLE',
  'RESTRICTED_ZONE_ACTIVITY',
] as const;

export const SAFETY_SECURITY_TYPES = [...FIRE_TYPES, ...SECURITY_TYPES] as const;

export const ALL_AI_TYPES = [...BASE_AI_TYPES, ...SAFETY_SECURITY_TYPES] as const;

export type AiEventType = (typeof ALL_AI_TYPES)[number];

export const EVENT_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export const EVENT_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'RESOLVED',
  'DISMISSED',
  'FALSE_POSITIVE',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const NOTIFY_CHANNELS = ['EMAIL', 'SMS', 'WEBHOOK', 'IN_APP', 'WHATSAPP', 'PUSH'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const AI_MODEL_TYPES = [
  'PERSON',
  'VEHICLE',
  'FIRE',
  'SMOKE',
  'OBJECT_TRACKING',
  'GENERIC_SECURITY',
] as const;
export type AiModelType = (typeof AI_MODEL_TYPES)[number];

/**
 * Recommended default severity per event type. Authorized users may override
 * per-rule; this is only the fallback when a rule does not specify one.
 */
export const DEFAULT_SEVERITY: Record<string, EventSeverity> = {
  // Fire & Safety
  FIRE: 'CRITICAL',
  FIRE_AND_SMOKE: 'CRITICAL',
  SMOKE: 'HIGH',
  // Security
  UNAUTHORIZED_ENTRY: 'HIGH',
  AFTER_HOURS_ACTIVITY: 'HIGH',
  OBJECT_REMOVED: 'HIGH',
  LOITERING_SECURITY: 'MEDIUM',
  UNAUTHORIZED_VEHICLE: 'MEDIUM',
  RESTRICTED_ZONE_ACTIVITY: 'HIGH',
};

/** Human-friendly, professionally-worded labels (no false certainty claims). */
export const EVENT_LABEL: Record<string, string> = {
  FIRE: 'Fire Detected',
  SMOKE: 'Smoke Detected',
  FIRE_AND_SMOKE: 'Critical Fire & Smoke Detected',
  UNAUTHORIZED_ENTRY: 'Unauthorized Entry',
  AFTER_HOURS_ACTIVITY: 'After-Hours Activity',
  OBJECT_REMOVED: 'Object Removed',
  LOITERING_SECURITY: 'Suspicious Loitering',
  UNAUTHORIZED_VEHICLE: 'Unauthorized Vehicle',
  RESTRICTED_ZONE_ACTIVITY: 'Restricted Zone Activity',
};

export const FIRE_TYPE_SET = new Set<string>(FIRE_TYPES);
export const SECURITY_TYPE_SET = new Set<string>(SECURITY_TYPES);

export function isFireType(t: string): boolean {
  return FIRE_TYPE_SET.has(t);
}
export function isSecurityType(t: string): boolean {
  return SECURITY_TYPE_SET.has(t);
}
export function isSafetySecurityType(t: string): boolean {
  return FIRE_TYPE_SET.has(t) || SECURITY_TYPE_SET.has(t);
}
