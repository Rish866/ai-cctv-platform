/**
 * Typed HTTP errors. The security posture is FAIL CLOSED: anything unexpected
 * bubbles up as a 500 that reveals nothing; authorization failures are explicit.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg = 'Bad request', details?: unknown) =>
  new HttpError(400, msg, 'BAD_REQUEST', details);

export const unauthorized = (msg = 'Authentication required') =>
  new HttpError(401, msg, 'UNAUTHORIZED');

export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg, 'FORBIDDEN');

/**
 * For cross-tenant / IDOR attempts we return 404 (not 403) so an attacker cannot
 * even confirm that a resource id exists in another tenant. "Not found" is the
 * correct, information-hiding response for a resource the caller may not access.
 */
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'NOT_FOUND');

export const conflict = (msg = 'Conflict') => new HttpError(409, msg, 'CONFLICT');

export const tooMany = (msg = 'Too many requests') =>
  new HttpError(429, msg, 'RATE_LIMITED');
