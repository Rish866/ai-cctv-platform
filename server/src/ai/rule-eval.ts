import type { TenantDb } from '../db/pool.js';
import { detectionInZone, type BBox, type ZoneGeometry } from './zone.js';
import { isAfterHours } from './schedule.js';

/**
 * Rule evaluation: turns a raw object detection (person / vehicle / fire / smoke)
 * into the security/safety event type(s) that the camera's ai_rules request.
 *
 * Runs on the tenant-bound db handle so all rule/zone/schedule lookups are RLS
 * scoped. Reuses the existing ai_rules + zones + zone_schedules tables. The
 * resulting event types are fed to the existing processDetection engine, so
 * cooldown/correlation/evidence/notify/WS/audit all continue to apply unchanged.
 */

export type RawClass = 'PERSON' | 'VEHICLE' | 'FIRE' | 'SMOKE';

export interface RawDetection {
  rawClass: RawClass;
  confidence: number;
  bbox: BBox;
  dwellMs?: number;
}

export interface EvaluatedEvent {
  eventType: string;
  confidence: number;
  zoneId: string | null;
  metadata: Record<string, unknown>;
}

interface RuleRow {
  id: string;
  rule_type: string;
  zone_id: string | null;
  enabled: boolean;
  min_confidence: number;
  config: Record<string, unknown>;
}

// Which security rule types a given raw class can produce.
const PERSON_SECURITY_RULES = new Set([
  'UNAUTHORIZED_ENTRY',
  'AFTER_HOURS_ACTIVITY',
  'RESTRICTED_ZONE_ACTIVITY',
  'LOITERING_SECURITY',
  'PERSON_DETECTION',
]);
const VEHICLE_SECURITY_RULES = new Set(['UNAUTHORIZED_VEHICLE', 'VEHICLE_DETECTION', 'RESTRICTED_ZONE_ACTIVITY']);

/**
 * Evaluate a raw detection against the camera's enabled rules. Returns the list
 * of event types that should be raised (deduped). Fire/smoke pass straight
 * through (their own rules handle severity/cooldown in the engine).
 */
export async function evaluateDetection(
  db: TenantDb,
  cameraId: string,
  det: RawDetection,
): Promise<EvaluatedEvent[]> {
  // Fire & smoke: raise directly (engine correlates FIRE+SMOKE).
  if (det.rawClass === 'FIRE' || det.rawClass === 'SMOKE') {
    return [{ eventType: det.rawClass, confidence: det.confidence, zoneId: null, metadata: {} }];
  }

  const rules = (
    await db.query<RuleRow>(
      `SELECT id, rule_type, zone_id, enabled, min_confidence, config
       FROM ai_rules WHERE camera_id = $1 AND enabled = true`,
      [cameraId],
    )
  ).rows;
  if (rules.length === 0) return [];

  const applicable = rules.filter((r) =>
    det.rawClass === 'PERSON' ? PERSON_SECURITY_RULES.has(r.rule_type) : VEHICLE_SECURITY_RULES.has(r.rule_type),
  );
  if (applicable.length === 0) return [];

  // Cache zone geometry lookups within this call.
  const zoneCache = new Map<string, ZoneGeometry | null>();
  const getZone = async (zoneId: string): Promise<ZoneGeometry | null> => {
    if (zoneCache.has(zoneId)) return zoneCache.get(zoneId)!;
    const r = await db.query<{ geometry: ZoneGeometry }>(`SELECT geometry FROM zones WHERE id = $1`, [zoneId]);
    const g = r.rows[0]?.geometry ?? null;
    zoneCache.set(zoneId, g);
    return g;
  };

  const out: EvaluatedEvent[] = [];
  const seen = new Set<string>();

  for (const rule of applicable) {
    if (det.confidence < Number(rule.min_confidence)) continue;

    // Zone gate: if the rule is bound to a zone, the detection must be inside it.
    let zoneMatched = true;
    if (rule.zone_id) {
      const geom = await getZone(rule.zone_id);
      zoneMatched = detectionInZone(det.bbox, geom);
    }
    if (!zoneMatched) continue;

    let eventType = rule.rule_type;

    // AFTER_HOURS_ACTIVITY: only fires when the zone is currently closed.
    if (rule.rule_type === 'AFTER_HOURS_ACTIVITY') {
      if (!rule.zone_id) continue; // needs a zone/schedule
      const after = await isAfterHours(db, rule.zone_id);
      if (!after) continue;
    }

    // LOITERING_SECURITY: requires sustained dwell time (configurable).
    if (rule.rule_type === 'LOITERING_SECURITY') {
      const minDwell = Number((rule.config?.minDwellMs as number) ?? 10_000);
      if ((det.dwellMs ?? 0) < minDwell) continue;
    }

    if (!seen.has(eventType)) {
      seen.add(eventType);
      out.push({
        eventType,
        confidence: det.confidence,
        zoneId: rule.zone_id,
        metadata: { rawClass: det.rawClass, ruleId: rule.id },
      });
    }
  }

  return out;
}
