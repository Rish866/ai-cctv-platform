import type { WebSocket } from 'ws';

/**
 * Tenant-scoped real-time hub.
 *
 * Sockets are grouped by organization id. publishTenantEvent() delivers ONLY to
 * sockets subscribed to that org's channel — there is no global broadcast path.
 * A socket is added to a channel only AFTER the WebSocket upgrade handler has
 * authenticated the session and verified the user's membership in that org
 * (see realtime/ws.ts). This prevents a user connected to org A from ever
 * receiving org B's events.
 */
type Subscribers = Set<WebSocket>;

const channels = new Map<string, Subscribers>();

export function subscribe(organizationId: string, socket: WebSocket): void {
  let set = channels.get(organizationId);
  if (!set) {
    set = new Set();
    channels.set(organizationId, set);
  }
  set.add(socket);
}

export function unsubscribe(organizationId: string, socket: WebSocket): void {
  const set = channels.get(organizationId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) channels.delete(organizationId);
}

export function unsubscribeAll(socket: WebSocket): void {
  for (const [org, set] of channels) {
    if (set.delete(socket) && set.size === 0) channels.delete(org);
  }
}

export interface RealtimeMessage {
  type: string;
  payload: unknown;
}

export function publishTenantEvent(organizationId: string, message: RealtimeMessage): void {
  const set = channels.get(organizationId);
  if (!set) return;
  const data = JSON.stringify({ ...message, organizationId });
  for (const socket of set) {
    // readyState 1 === OPEN
    if (socket.readyState === 1) socket.send(data);
  }
}

/** Test helper: how many sockets are subscribed to an org channel. */
export function _subscriberCount(organizationId: string): number {
  return channels.get(organizationId)?.size ?? 0;
}

export function _resetHub(): void {
  channels.clear();
}
