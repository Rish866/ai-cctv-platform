import { z } from 'zod';
import { AI_MODEL_TYPES, ALL_AI_TYPES, NOTIFY_CHANNELS } from '../ai/types.js';

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

// All AI rule/event types (base 8 + safety/security add-on). Single source of
// truth lives in ai/types.ts.
const aiTypeEnum = z.enum(ALL_AI_TYPES);
const notifyChannelEnum = z.enum(NOTIFY_CHANNELS);

export const aiRuleSchema = z.object({
  cameraId: uuid,
  zoneId: uuid.optional().nullable(),
  ruleType: aiTypeEnum,
  enabled: z.boolean().default(true),
  minConfidence: z.number().min(0).max(1).default(0.5),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  // Add-on config (all optional + backward compatible).
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  minDurationMs: z.number().int().min(0).max(600000).optional(),
  notifyChannels: z.array(notifyChannelEnum).optional(),
  aiModelId: uuid.optional().nullable(),
  config: z.record(z.string(), z.unknown()).default({}),
});

// Incident workflow statuses (extends the original 4 with INVESTIGATING /
// FALSE_POSITIVE). Existing callers passing the original values keep working.
export const eventStatusSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'DISMISSED', 'FALSE_POSITIVE']),
});

export const notificationRuleSchema = z.object({
  name: z.string().min(1).max(200),
  channel: notifyChannelEnum,
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

// AI event ingestion (represents the AI worker -> rule engine step). Now accepts
// all AI types including the new safety/security ones. Fully backward compatible.
export const ingestEventSchema = z.object({
  cameraId: uuid,
  eventType: aiTypeEnum,
  confidence: z.number().min(0).max(1),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  correlationId: z.string().max(200).optional(),
  durationMs: z.number().int().min(0).max(600000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  // Optional evidence payload (base64) — a snapshot from the camera.
  snapshotBase64: z.string().optional(),
});

// ---- Add-on: safety/security configuration schemas ----
export const zoneScheduleSchema = z.object({
  zoneId: uuid,
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  openMinute: z.number().int().min(0).max(1440).default(540),
  closeMinute: z.number().int().min(0).max(1440).default(1080),
  timezone: z.string().max(64).default('UTC'),
});

export const monitoredObjectSchema = z.object({
  cameraId: uuid,
  zoneId: uuid.optional().nullable(),
  label: z.string().min(1).max(200),
  region: z.record(z.string(), z.unknown()).default({}),
  confirmMs: z.number().int().min(0).max(600000).default(3000),
});

export const aiModelSchema = z.object({
  modelType: z.enum(AI_MODEL_TYPES),
  name: z.string().min(1).max(200),
  version: z.string().max(64).default('v1'),
  backendRef: z.string().max(300).optional().nullable(),
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  isDemoAdapter: z.boolean().default(false),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const incidentNoteSchema = z.object({
  note: z.string().min(1).max(4000),
});
