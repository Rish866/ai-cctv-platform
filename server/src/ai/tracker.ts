import { randomUUID } from 'node:crypto';
import type { BBox } from './zone.js';

/**
 * Lightweight session object tracker (IoU-based nearest-match). Assigns a
 * temporary, per-camera-session track id (e.g. "person-track-3") so we can
 * measure DWELL TIME and detect zone entry/exit for loitering-style rules.
 *
 * IMPORTANT (spec §15, §39): this is NOT biometric identity and NOT face
 * recognition. Track ids are ephemeral, scoped to a single camera session, and
 * carry no personal information. State is namespaced per {org, camera} so it can
 * never mix tenants.
 */

interface Track {
  id: string;
  label: string;
  bbox: BBox;
  firstSeen: number;
  lastSeen: number;
}

interface CameraTrackState {
  tracks: Map<string, Track>;
  seq: number;
}

const IOU_MATCH_THRESHOLD = 0.3;
const TRACK_TTL_MS = 10_000;

function iou(a: BBox, b: BBox): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

export interface TrackedDetection {
  trackId: string;
  label: string;
  bbox: BBox;
  dwellMs: number;
  isNew: boolean;
}

export class SessionTracker {
  // Keyed by `${organizationId}:${cameraId}` — hard tenant/camera namespace.
  private state = new Map<string, CameraTrackState>();

  private key(org: string, cam: string): string {
    return `${org}:${cam}`;
  }

  /**
   * Update the tracker with the current frame's detections for one camera and
   * return each detection annotated with a stable trackId + dwell time.
   */
  update(
    organizationId: string,
    cameraId: string,
    detections: Array<{ label: string; bbox: BBox }>,
    now = Date.now(),
  ): TrackedDetection[] {
    const key = this.key(organizationId, cameraId);
    let cs = this.state.get(key);
    if (!cs) {
      cs = { tracks: new Map(), seq: 0 };
      this.state.set(key, cs);
    }

    // Expire stale tracks.
    for (const [id, t] of cs.tracks) {
      if (now - t.lastSeen > TRACK_TTL_MS) cs.tracks.delete(id);
    }

    const out: TrackedDetection[] = [];
    const claimed = new Set<string>();
    for (const det of detections) {
      // Find best IoU match among existing tracks with the same label.
      let bestId: string | null = null;
      let bestIou = IOU_MATCH_THRESHOLD;
      for (const [id, t] of cs.tracks) {
        if (t.label !== det.label || claimed.has(id)) continue;
        const score = iou(t.bbox, det.bbox);
        if (score >= bestIou) {
          bestIou = score;
          bestId = id;
        }
      }
      if (bestId) {
        const t = cs.tracks.get(bestId)!;
        t.bbox = det.bbox;
        t.lastSeen = now;
        claimed.add(bestId);
        out.push({ trackId: bestId, label: det.label, bbox: det.bbox, dwellMs: now - t.firstSeen, isNew: false });
      } else {
        cs.seq += 1;
        const id = `${det.label.toLowerCase()}-track-${cs.seq}-${randomUUID().slice(0, 6)}`;
        cs.tracks.set(id, { id, label: det.label, bbox: det.bbox, firstSeen: now, lastSeen: now });
        claimed.add(id);
        out.push({ trackId: id, label: det.label, bbox: det.bbox, dwellMs: 0, isNew: true });
      }
    }
    return out;
  }

  /** Which labels are currently present (not expired) for a camera. */
  presentLabels(organizationId: string, cameraId: string, now = Date.now()): Set<string> {
    const cs = this.state.get(this.key(organizationId, cameraId));
    const labels = new Set<string>();
    if (!cs) return labels;
    for (const t of cs.tracks.values()) {
      if (now - t.lastSeen <= TRACK_TTL_MS) labels.add(t.label);
    }
    return labels;
  }

  reset(): void {
    this.state.clear();
  }
}

export const sessionTracker = new SessionTracker();
