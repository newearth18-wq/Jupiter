import { z } from 'zod';

const BoundedTextSchema = z.string().trim().min(1).max(1_000);
const BrowserUrlSchema = z.url().refine(
  (value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  },
  { message: 'Browser URLs must use HTTP or HTTPS and cannot embed credentials.' },
);
const BrowserOriginSchema = z.url().refine(
  (value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  },
  { message: 'Expected origin must be an HTTP(S) scheme, host, and port only.' },
);
const WindowsPathSchema = z.string().trim().min(1).max(32_767);

export const BrowserActionTypeSchema = z.enum([
  'CREATE_SESSION',
  'CLOSE_SESSION',
  'NAVIGATE',
  'OPEN_TAB',
  'CLOSE_TAB',
  'SWITCH_TAB',
  'CLICK',
  'TYPE_TEXT',
  'FILL_FORM',
  'SELECT_OPTION',
  'PRESS_KEYS',
  'UPLOAD_FILE',
  'DOWNLOAD_FILE',
  'READ_PAGE',
  'EXTRACT_DATA',
  'SCREENSHOT',
  'HTML_SNAPSHOT',
  'WAIT_FOR',
  'SET_COOKIES',
  'CLEAR_COOKIES',
  'GRANT_ORIGIN_PERMISSIONS',
  'SUBMIT_FORM',
]);

export const BrowserProfileModeSchema = z.enum(['TEMPORARY', 'PERSISTENT']);
export const BrowserSessionStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'CLOSED', 'CRASHED']);
export const BrowserSelectorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('role'),
      role: z.string().trim().min(1).max(80),
      name: z.string().trim().min(1).max(500).optional(),
      exact: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('label'),
      label: BoundedTextSchema,
      exact: z.boolean().default(true),
    })
    .strict(),
  z
    .object({ kind: z.literal('text'), text: BoundedTextSchema, exact: z.boolean().default(true) })
    .strict(),
  z.object({ kind: z.literal('testId'), testId: z.string().trim().min(1).max(300) }).strict(),
  z.object({ kind: z.literal('css'), selector: z.string().trim().min(1).max(1_000) }).strict(),
]);

export const BrowserTargetSchema = z
  .object({
    kind: z.enum(['browser', 'session', 'tab', 'page', 'element', 'file', 'origin']),
    id: z.string().trim().min(1).max(2_048),
    display: z.string().trim().min(1).max(500),
  })
  .strict();

const BaseActionShape = {
  actionId: z.uuid(),
  missionId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  tabId: z.uuid().optional(),
  target: BrowserTargetSchema,
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
};
const EmptyParametersSchema = z.object({}).strict();
export const BrowserActionInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...BaseActionShape,
      action: z.literal('CREATE_SESSION'),
      parameters: z
        .object({
          profileMode: BrowserProfileModeSchema.default('TEMPORARY'),
          profileName: z.string().trim().min(1).max(120).optional(),
          allowedOrigins: z.array(BrowserOriginSchema).max(50).default([]),
          downloadDirectory: WindowsPathSchema,
          headless: z.boolean().default(true),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.profileMode === 'PERSISTENT' && value.profileName === undefined) {
            context.addIssue({
              code: 'custom',
              path: ['profileName'],
              message: 'Persistent profiles need a name.',
            });
          }
        }),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('CLOSE_SESSION'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('NAVIGATE'),
      parameters: z.object({ url: BrowserUrlSchema, expectedOrigin: BrowserOriginSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('OPEN_TAB'),
      parameters: z.object({ url: BrowserUrlSchema, expectedOrigin: BrowserOriginSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('CLOSE_TAB'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SWITCH_TAB'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('CLICK'),
      parameters: z
        .object({ selector: BrowserSelectorSchema, expectedOrigin: BrowserOriginSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('TYPE_TEXT'),
      parameters: z
        .object({
          selector: BrowserSelectorSchema,
          text: z.string().max(100_000),
          expectedOrigin: BrowserOriginSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('FILL_FORM'),
      parameters: z
        .object({
          fields: z
            .array(
              z
                .object({ selector: BrowserSelectorSchema, value: z.string().max(100_000) })
                .strict(),
            )
            .min(1)
            .max(100),
          expectedOrigin: BrowserOriginSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SELECT_OPTION'),
      parameters: z
        .object({
          selector: BrowserSelectorSchema,
          values: z.array(z.string().max(500)).min(1).max(100),
          expectedOrigin: BrowserOriginSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('PRESS_KEYS'),
      parameters: z
        .object({ keys: z.string().trim().min(1).max(200), expectedOrigin: BrowserOriginSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('UPLOAD_FILE'),
      parameters: z
        .object({
          selector: BrowserSelectorSchema,
          filePath: WindowsPathSchema,
          allowedExtensions: z
            .array(z.string().regex(/^\.[a-zA-Z0-9]{1,12}$/))
            .min(1)
            .max(30),
          maxBytes: z.number().int().positive().max(2_147_483_647),
          expectedOrigin: BrowserOriginSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('DOWNLOAD_FILE'),
      parameters: z
        .object({
          selector: BrowserSelectorSchema,
          expectedOrigin: BrowserOriginSchema,
          allowedExtensions: z
            .array(z.string().regex(/^\.[a-zA-Z0-9]{1,12}$/))
            .min(1)
            .max(30),
          maxBytes: z.number().int().positive().max(2_147_483_647),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('READ_PAGE'),
      parameters: z
        .object({ maxCharacters: z.number().int().min(1).max(100_000).default(20_000) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('EXTRACT_DATA'),
      parameters: z
        .object({
          fields: z
            .array(
              z
                .object({
                  name: z.string().trim().min(1).max(160),
                  selector: BrowserSelectorSchema,
                })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SCREENSHOT'),
      parameters: z
        .object({ outputPath: WindowsPathSchema, fullPage: z.boolean().default(false) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('HTML_SNAPSHOT'),
      parameters: z.object({ outputPath: WindowsPathSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('WAIT_FOR'),
      parameters: z
        .object({
          selector: BrowserSelectorSchema.optional(),
          state: z.enum([
            'ATTACHED',
            'VISIBLE',
            'HIDDEN',
            'DETACHED',
            'LOAD',
            'DOMCONTENTLOADED',
            'NETWORKIDLE',
          ]),
        })
        .strict()
        .superRefine((value, context) => {
          const elementStates = ['ATTACHED', 'VISIBLE', 'HIDDEN', 'DETACHED'];
          if (value.selector && !elementStates.includes(value.state)) {
            context.addIssue({
              code: 'custom',
              path: ['state'],
              message: 'Selector waits require an element state.',
            });
          }
          if (!value.selector && elementStates.includes(value.state)) {
            context.addIssue({
              code: 'custom',
              path: ['selector'],
              message: 'Element waits require a semantic selector.',
            });
          }
        }),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SET_COOKIES'),
      parameters: z
        .object({
          cookies: z
            .array(
              z
                .object({
                  name: z.string().trim().min(1).max(256),
                  value: z.string().max(4_096),
                  url: BrowserUrlSchema,
                  httpOnly: z.boolean().default(true),
                  secure: z.boolean().default(true),
                  sameSite: z.enum(['Strict', 'Lax', 'None']).default('Lax'),
                })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('CLEAR_COOKIES'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('GRANT_ORIGIN_PERMISSIONS'),
      parameters: z
        .object({
          origin: BrowserOriginSchema,
          permissions: z
            .array(z.enum(['geolocation', 'notifications', 'clipboard-read', 'clipboard-write']))
            .min(1)
            .max(10),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SUBMIT_FORM'),
      parameters: z
        .object({
          selector: BrowserSelectorSchema,
          sensitivity: z.enum(['GENERIC', 'LOGIN', 'MESSAGE', 'PURCHASE']),
          expectedOrigin: BrowserOriginSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const BrowserPageObservationSchema = z
  .object({ url: BrowserUrlSchema, origin: BrowserOriginSchema, title: z.string().max(1_000) })
  .strict();

export const BrowserEvidenceArtifactSchema = z
  .object({
    artifactId: z.uuid(),
    kind: z.enum(['screenshot', 'download', 'html']),
    path: WindowsPathSchema,
    mediaType: z.string().trim().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    verified: z.boolean(),
    sourceOrigin: BrowserOriginSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const BrowserSecuritySignalSchema = z
  .object({
    type: z.enum(['PROMPT_INJECTION', 'UNEXPECTED_ORIGIN', 'UNTRUSTED_CONTENT']),
    severity: z.enum(['INFO', 'WARNING', 'BLOCKED']),
    description: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const BrowserTabSchema = z
  .object({
    tabId: z.uuid(),
    url: BrowserUrlSchema,
    title: z.string().max(1_000),
    active: z.boolean(),
  })
  .strict();

export const BrowserSessionSchema = z
  .object({
    sessionId: z.uuid(),
    missionId: z.uuid().optional(),
    status: BrowserSessionStatusSchema,
    profileMode: BrowserProfileModeSchema,
    profileName: z.string().max(120).optional(),
    allowedOrigins: z.array(BrowserOriginSchema).max(50),
    activeTabId: z.uuid().optional(),
    tabCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const BrowserActionOutputSchema = z
  .object({
    session: BrowserSessionSchema.optional(),
    tabs: z.array(BrowserTabSchema).max(100).optional(),
    visibleText: z.string().max(100_000).optional(),
    extraction: z
      .record(
        z.string().max(160),
        z.union([z.string().max(100_000), z.array(z.string().max(10_000)).max(1_000)]),
      )
      .optional(),
    cookieCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const BrowserActionErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]+$/),
    message: z.string().trim().min(1).max(500),
    recoverable: z.boolean(),
  })
  .strict();

export const BrowserActionResultSchema = z
  .object({
    actionId: z.uuid(),
    action: BrowserActionTypeSchema,
    target: BrowserTargetSchema,
    sessionId: z.uuid().optional(),
    tabId: z.uuid().optional(),
    success: z.boolean(),
    status: z.enum(['SUCCESS', 'FAILED', 'CANCELLED', 'PAUSED']),
    observation: z.string().trim().min(1).max(2_000),
    page: BrowserPageObservationSchema.optional(),
    output: BrowserActionOutputSchema.optional(),
    evidence: z.array(BrowserEvidenceArtifactSchema).max(20),
    securitySignals: z.array(BrowserSecuritySignalSchema).max(50),
    error: BrowserActionErrorSchema.optional(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.success !== (value.status === 'SUCCESS')) {
      context.addIssue({
        code: 'custom',
        path: ['success'],
        message: 'Success must match status.',
      });
    }
    if (['FAILED', 'PAUSED'].includes(value.status) && value.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed or paused actions need an error.',
      });
    }
  });

export const BrowserRuntimeStatusSchema = z
  .object({
    available: z.boolean(),
    engine: z.literal('playwright'),
    processIsolation: z.literal('dedicated-node-process'),
    executable: z.string().max(32_767).optional(),
    managedDownloadDirectory: WindowsPathSchema,
    profiles: z
      .object({ temporary: z.literal('default'), persistent: z.literal('explicit-opt-in') })
      .strict(),
    browserContentTrust: z.literal('untrusted'),
    coordinateFallback: z.literal('not-enabled'),
    supportedActions: z.array(BrowserActionTypeSchema),
  })
  .strict();

export const BrowserHistoryInputSchema = z
  .object({ limit: z.number().int().min(1).max(200).default(50) })
  .strict();
export const BrowserHistoryResultSchema = z
  .object({ actions: z.array(BrowserActionResultSchema) })
  .strict();
export const BrowserSessionListResultSchema = z
  .object({ sessions: z.array(BrowserSessionSchema) })
  .strict();
export const BrowserCancelInputSchema = z.object({ actionId: z.uuid() }).strict();
export const BrowserCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();

export type BrowserActionType = z.infer<typeof BrowserActionTypeSchema>;
export type BrowserProfileMode = z.infer<typeof BrowserProfileModeSchema>;
export type BrowserSelector = z.infer<typeof BrowserSelectorSchema>;
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>;
export type BrowserActionInput = z.infer<typeof BrowserActionInputSchema>;
export type BrowserPageObservation = z.infer<typeof BrowserPageObservationSchema>;
export type BrowserEvidenceArtifact = z.infer<typeof BrowserEvidenceArtifactSchema>;
export type BrowserSecuritySignal = z.infer<typeof BrowserSecuritySignalSchema>;
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export type BrowserTab = z.infer<typeof BrowserTabSchema>;
export type BrowserActionResult = z.infer<typeof BrowserActionResultSchema>;
export type BrowserRuntimeStatus = z.infer<typeof BrowserRuntimeStatusSchema>;
export type BrowserCancelInput = z.infer<typeof BrowserCancelInputSchema>;
