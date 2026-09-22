import { z } from 'zod';

export const BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export const EnvironmentSchema = z.enum(['development', 'test', 'production']);
export const RuntimeStatusSchema = z.enum(['operational', 'degraded', 'unavailable']);
export const NavigationAvailabilitySchema = z.enum(['available', 'not_configured', 'coming_later']);

export const AppMetadataSchema = z
  .object({
    productName: z.literal('Jupiter'),
    version: z.string().min(1),
    environment: EnvironmentSchema,
    buildChannel: z.string().min(1),
    buildId: z.string().min(1),
    commit: z.string().min(1),
    platform: z.string().min(1),
    architecture: z.string().min(1),
    electronVersion: z.string().min(1),
    chromeVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
  })
  .strict();

export const StartupErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean(),
    userAction: z.string().min(1),
    sanitizedDetails: z.string().max(500).optional(),
    timestamp: z.iso.datetime(),
  })
  .strict();

export const ServiceHealthSchema = z
  .object({
    serviceId: z.string().min(1),
    status: RuntimeStatusSchema,
    version: z.string().min(1),
    lastCheck: z.iso.datetime(),
    capabilities: z.array(z.string()),
    sanitizedError: z.string().max(500).optional(),
  })
  .strict();

export const NavigationLinkSchema = z
  .object({
    id: z.enum(['home', 'diagnostics', 'settings']),
    availability: NavigationAvailabilitySchema,
  })
  .strict();

export const BootstrapStateSchema = z
  .object({
    schemaVersion: z.literal(BOOTSTRAP_SCHEMA_VERSION),
    correlationId: z.uuid(),
    generatedAt: z.iso.datetime(),
    metadata: AppMetadataSchema,
    runtime: z
      .object({
        status: RuntimeStatusSchema,
        services: z.array(ServiceHealthSchema),
        startupError: StartupErrorSchema.optional(),
      })
      .strict(),
    navigation: z.array(NavigationLinkSchema),
  })
  .strict();

export const RetryStartupRequestSchema = z
  .object({
    schemaVersion: z.literal(BOOTSTRAP_SCHEMA_VERSION),
    correlationId: z.uuid(),
  })
  .strict();

export type AppEnvironment = z.infer<typeof EnvironmentSchema>;
export type AppMetadata = z.infer<typeof AppMetadataSchema>;
export type BootstrapState = z.infer<typeof BootstrapStateSchema>;
export type RetryStartupRequest = z.infer<typeof RetryStartupRequestSchema>;
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
