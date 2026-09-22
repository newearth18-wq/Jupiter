import { z } from 'zod';
import { CONTRACT_SCHEMA_VERSION } from './common.js';

export const CoreServiceStatusSchema = z.enum([
  'starting',
  'operational',
  'degraded',
  'failed',
  'stopped',
]);

export const CoreServiceHealthSchema = z
  .object({
    serviceId: z.string().min(1).max(120),
    status: CoreServiceStatusSchema,
    version: z.string().min(1),
    lastCheck: z.iso.datetime(),
    latencyMs: z.number().nonnegative().optional(),
    capabilities: z.array(z.string()),
    sanitizedError: z.string().max(500).optional(),
  })
  .strict();

export const DatabaseDiagnosticsSchema = z
  .object({
    status: z.enum(['operational', 'degraded', 'unavailable']),
    engine: z.literal('SQLite'),
    schemaVersion: z.number().int().nonnegative(),
    journalMode: z.string().min(1),
    foreignKeysEnabled: z.boolean(),
    integrity: z.enum(['ok', 'failed']),
    eventCount: z.number().int().nonnegative(),
    auditCount: z.number().int().nonnegative(),
    storageLabel: z.string().min(1).max(120),
  })
  .strict();

export const SanitizedDiagnosticErrorSchema = z
  .object({
    serviceId: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1).max(500),
    timestamp: z.iso.datetime(),
  })
  .strict();

export const DiagnosticsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    generatedAt: z.iso.datetime(),
    coreVersion: z.string().min(1),
    status: z.enum(['operational', 'degraded']),
    database: DatabaseDiagnosticsSchema,
    services: z.array(CoreServiceHealthSchema),
    recentErrors: z.array(SanitizedDiagnosticErrorSchema).max(20),
  })
  .strict();

export type CoreServiceHealth = z.infer<typeof CoreServiceHealthSchema>;
export type DatabaseDiagnostics = z.infer<typeof DatabaseDiagnosticsSchema>;
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>;
