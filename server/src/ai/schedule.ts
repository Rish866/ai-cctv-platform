import type { TenantDb } from '../db/pool.js';

/**
 * After-hours evaluation. A zone is "open" during any of its zone_schedules
 * windows for the given weekday (or a NULL-weekday row that applies daily).
 * Activity in a zone while it is closed is after-hours activity.
 *
 * Schedules are tenant + zone scoped (RLS on zone_schedules), so one org's
 * hours never affect another's — evaluation runs on the tenant-bound `db`.
 */
export interface ScheduleWindow {
  weekday: number | null;
  open_minute: number;
  close_minute: number;
}

/** Minutes since midnight for a Date in UTC (schedules store UTC-relative minutes here). */
export function minutesOfDay(at: Date): number {
  return at.getUTCHours() * 60 + at.getUTCMinutes();
}

export function weekdayOf(at: Date): number {
  return at.getUTCDay(); // 0=Sun..6=Sat
}

/**
 * Returns true if `at` falls OUTSIDE all configured open windows for the zone.
 * If the zone has NO schedule rows, it is considered always-open (so we do not
 * generate false after-hours events for unconfigured zones).
 */
export async function isAfterHours(db: TenantDb, zoneId: string, at: Date = new Date()): Promise<boolean> {
  const rows = (
    await db.query<ScheduleWindow>(
      `SELECT weekday, open_minute, close_minute FROM zone_schedules WHERE zone_id = $1`,
      [zoneId],
    )
  ).rows;
  if (rows.length === 0) return false; // no schedule => always open

  const wd = weekdayOf(at);
  const mins = minutesOfDay(at);
  const applicable = rows.filter((r) => r.weekday === null || r.weekday === wd);
  if (applicable.length === 0) return true; // day has no open window configured

  const withinAnyWindow = applicable.some((r) => {
    if (r.open_minute <= r.close_minute) {
      return mins >= r.open_minute && mins < r.close_minute;
    }
    // Overnight window (e.g. 22:00–06:00) wraps midnight.
    return mins >= r.open_minute || mins < r.close_minute;
  });
  return !withinAnyWindow;
}
