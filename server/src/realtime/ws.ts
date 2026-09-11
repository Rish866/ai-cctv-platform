import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../config.js';
import { verifySessionId } from '../lib/crypto.js';
import { resolveSession } from '../services/auth.service.js';
import { getMembership } from '../services/membership.service.js';
import { subscribe, unsubscribeAll } from './hub.js';

/**
 * Tenant-aware WebSocket server.
 *
 * On connect we:
 *   1. authenticate the session cookie,
 *   2. determine the user's active org from the SERVER session,
 *   3. verify ACTIVE membership,
 *   4. subscribe the socket to ONLY that org's channel.
 *
 * A client cannot request another org's channel: the subscription org comes
 * from the verified server-side session, never from a client-supplied value.
 * Broadcasts go through publishTenantEvent(org, ...) which delivers only to
 * that org's subscribers.
 */
export function attachWebSockets(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (socket: WebSocket, req) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const signed = cookies[config.session.cookieName];
      const sessionId = signed ? verifySessionId(signed) : null;
      if (!sessionId) return closeUnauthorized(socket);

      const resolved = await resolveSession(sessionId);
      if (!resolved || !resolved.activeOrgId) return closeUnauthorized(socket);

      const membership = await getMembership(resolved.user.id, resolved.activeOrgId);
      if (!membership || membership.status !== 'ACTIVE') return closeUnauthorized(socket);

      // Subscribe ONLY to the verified org channel.
      subscribe(membership.organizationId, socket);
      socket.send(JSON.stringify({ type: 'subscribed', organizationId: membership.organizationId }));

      socket.on('close', () => unsubscribeAll(socket));
      socket.on('error', () => unsubscribeAll(socket));
    } catch {
      closeUnauthorized(socket);
    }
  });

  return wss;
}

function closeUnauthorized(socket: WebSocket): void {
  try {
    socket.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
  } catch {
    /* ignore */
  }
  socket.close(4401, 'unauthorized');
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  }
  return out;
}
