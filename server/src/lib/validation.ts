import { z } from 'zod';

export const uuid = z.string().uuid();

export const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  fullName: z.string().min(1).max(200),
  organizationName: z.string().min(1).max(200),
});

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email().max(320),
});

export const siteSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  timezone: z.string().max(64).default('UTC'),
});

export const zoneSchema = z.object({
  siteId: uuid,
  name: z.string().min(1).max(200),
  geometry: z.record(z.string(), z.unknown()).default({}),
});

export const cameraSchema = z.object({
  siteId: uuid,
  zoneId: uuid.optional().nullable(),
  name: z.string().min(1).max(200),
  rtspHost: z.string().max(300).optional().nullable(),
  rtspPath: z.string().max(300).optional().nullable(),
  onvifEndpoint: z.string().max(300).optional().nullable(),
  // Credentials are optional; when present they are encrypted at rest and never
  // returned to the client.
  username: z.string().max(200).optional(),
  password: z.string().max(200).optional(),
});

export const cameraUpdateSchema = cameraSchema.partial();

export const aiRuleSchema = z.object({
  cameraId: uuid,
  zoneId: uuid.optional().nullable(),
  ruleType: z.enum([
    'PERSON_DETECTION',
    'VEHICLE_DETECTION',
    'RESTRICTED_AREA_INTRUSION',
    'LINE_CROSSING',
    'LOITERING',
    'CROWD_DETECTION',
    'HELMET_DETECTION',
    'SAFETY_VEST_DETECTION',
  ]),
  enabled: z.boolean().default(true),
  minConfidence: z.number().min(0).max(1).default(0.5),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const eventStatusSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']),
});

export const notificationRuleSchema = z.object({
  name: z.string().min(1).max(200),
  channel: z.enum(['EMAIL', 'SMS', 'WEBHOOK', 'IN_APP']),
  target: z.string().min(1).max(500),
  minSeverity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
  enabled: z.boolean().default(true),
});

export const inviteMemberSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER']),
});

export const updateMemberSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER']).optional(),
  status: z.enum(['ACTIVE', 'INVITED', 'SUSPENDED']).optional(),
});

export const reportSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().max(64).default('EVENT_SUMMARY'),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const searchSchema = z.object({
  q: z.string().min(1).max(200),
});

// Simulated AI event ingestion (represents the AI worker -> rule engine step).
export const ingestEventSchema = z.object({
  cameraId: uuid,
  eventType: z.enum([
    'PERSON_DETECTION',
    'VEHICLE_DETECTION',
    'RESTRICTED_AREA_INTRUSION',
    'LINE_CROSSING',
    'LOITERING',
    'CROWD_DETECTION',
    'HELMET_DETECTION',
    'SAFETY_VEST_DETECTION',
  ]),
  confidence: z.number().min(0).max(1),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  correlationId: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  // Optional evidence payload (base64) — a snapshot from the camera.
  snapshotBase64: z.string().optional(),
});
