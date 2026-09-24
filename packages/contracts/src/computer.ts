import { z } from 'zod';

const BoundedTextSchema = z.string().trim().min(1).max(1_024);
const WindowsPathSchema = z.string().trim().min(1).max(32_767);

export const ComputerActionTypeSchema = z.enum([
  'OPEN_APP',
  'CLOSE_APP',
  'FOCUS_WINDOW',
  'MINIMIZE_WINDOW',
  'MAXIMIZE_WINDOW',
  'RESTORE_WINDOW',
  'MOVE_RESIZE_WINDOW',
  'ENUMERATE_WINDOWS',
  'GET_ACTIVE_WINDOW',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'PRESS_KEYS',
  'SCROLL_ELEMENT',
  'SELECT_ELEMENT',
  'DRAG_DROP',
  'COPY',
  'PASTE',
  'READ_UI_TREE',
  'SCREENSHOT',
  'WAIT_FOR_WINDOW',
  'SAVE_FILE',
]);

export const ComputerAdapterIdSchema = z.enum(['generic-windows', 'notepad', 'file-explorer']);

export const ComputerInteractionModeSchema = z.enum([
  'WINDOWS_UI_AUTOMATION',
  'WINDOWS_API',
  'SEMANTIC_KEYBOARD',
  'COORDINATE_FALLBACK',
]);

export const ComputerElementSelectorSchema = z
  .object({
    automationId: z.string().max(300).optional(),
    name: z.string().max(500).optional(),
    controlType: z.string().max(120).optional(),
    className: z.string().max(300).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one semantic selector field is required.',
  });

export const ComputerTargetSchema = z
  .object({
    kind: z.enum(['application', 'window', 'control', 'file', 'screen']),
    id: BoundedTextSchema,
    display: z.string().trim().min(1).max(500),
    processId: z.number().int().positive().optional(),
    windowTitle: z.string().max(500).optional(),
    selector: ComputerElementSelectorSchema.optional(),
  })
  .strict();

const CoordinateFallbackSchema = z
  .object({
    approved: z.literal(true),
    reason: z.string().trim().min(1).max(500),
    bounds: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().positive().max(100_000),
        height: z.number().int().positive().max(100_000),
      })
      .strict(),
  })
  .strict();

const EmptyParametersSchema = z.object({}).strict();
const BaseActionShape = {
  actionId: z.uuid(),
  target: ComputerTargetSchema,
  adapterHint: ComputerAdapterIdSchema.optional(),
  missionId: z.uuid().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
};

export const ComputerActionInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...BaseActionShape,
      action: z.literal('OPEN_APP'),
      parameters: z
        .object({
          executable: WindowsPathSchema,
          arguments: z.array(z.string().max(1_024)).max(20).default([]),
          workingDirectory: WindowsPathSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('CLOSE_APP'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('FOCUS_WINDOW'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  ...(['MINIMIZE_WINDOW', 'MAXIMIZE_WINDOW', 'RESTORE_WINDOW'] as const).map((action) =>
    z
      .object({ ...BaseActionShape, action: z.literal(action), parameters: EmptyParametersSchema })
      .strict(),
  ),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('MOVE_RESIZE_WINDOW'),
      parameters: z
        .object({
          x: z.number().int().min(-100_000).max(100_000),
          y: z.number().int().min(-100_000).max(100_000),
          width: z.number().int().min(100).max(100_000),
          height: z.number().int().min(100).max(100_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('ENUMERATE_WINDOWS'),
      parameters: z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('GET_ACTIVE_WINDOW'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('CLICK_ELEMENT'),
      parameters: z.object({ coordinateFallback: CoordinateFallbackSchema.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('TYPE_TEXT'),
      parameters: z
        .object({ text: z.string().max(100_000), replace: z.boolean().default(true) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('PRESS_KEYS'),
      parameters: z
        .object({ keys: z.array(z.string().trim().min(1).max(40)).min(1).max(12) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SCROLL_ELEMENT'),
      parameters: z
        .object({
          direction: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT']),
          amount: z.enum(['SMALL', 'LARGE']).default('SMALL'),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SELECT_ELEMENT'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('DRAG_DROP'),
      parameters: z.object({ destination: ComputerElementSelectorSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('COPY'),
      parameters: EmptyParametersSchema,
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('PASTE'),
      parameters: z.object({ text: z.string().max(100_000) }).strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('READ_UI_TREE'),
      parameters: z
        .object({
          maxDepth: z.number().int().min(1).max(10).default(5),
          maxNodes: z.number().int().min(1).max(500).default(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SCREENSHOT'),
      parameters: z.object({ outputPath: WindowsPathSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('WAIT_FOR_WINDOW'),
      parameters: z
        .object({
          processName: z.string().trim().min(1).max(260).optional(),
          titleContains: z.string().trim().min(1).max(500).optional(),
        })
        .strict()
        .refine((value) => value.processName !== undefined || value.titleContains !== undefined, {
          message: 'A process name or title fragment is required.',
        }),
    })
    .strict(),
  z
    .object({
      ...BaseActionShape,
      action: z.literal('SAVE_FILE'),
      parameters: z
        .object({
          outputPath: WindowsPathSchema,
          expectedContent: z.string().max(100_000),
          overwrite: z.boolean().default(false),
        })
        .strict(),
    })
    .strict(),
]);

export const ComputerUiNodeSchema = z
  .object({
    name: z.string().max(500),
    automationId: z.string().max(300),
    controlType: z.string().max(120),
    className: z.string().max(300),
    depth: z.number().int().nonnegative().max(10),
    enabled: z.boolean(),
  })
  .strict();

export const ComputerEvidenceArtifactSchema = z
  .object({
    artifactId: z.uuid(),
    kind: z.enum(['file', 'screenshot']),
    path: WindowsPathSchema,
    mediaType: z.string().trim().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    verified: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const ComputerActionOutputSchema = z
  .object({
    processId: z.number().int().positive().optional(),
    windowHandle: z.string().regex(/^\d+$/).optional(),
    windowTitle: z.string().max(500).optional(),
    nodeCount: z.number().int().nonnegative().optional(),
    uiTree: z.array(ComputerUiNodeSchema).max(500).optional(),
    fileVerified: z.boolean().optional(),
    windows: z
      .array(
        z
          .object({
            processId: z.number().int().positive(),
            windowHandle: z.string().regex(/^\d+$/),
            windowTitle: z.string().max(500),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict();

export const ComputerActionErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]+$/),
    message: z.string().trim().min(1).max(500),
    recoverable: z.boolean(),
  })
  .strict();

export const ComputerActionResultSchema = z
  .object({
    actionId: z.uuid(),
    action: ComputerActionTypeSchema,
    target: ComputerTargetSchema,
    success: z.boolean(),
    status: z.enum(['SUCCESS', 'FAILED', 'CANCELLED']),
    observation: z.string().trim().min(1).max(1_000),
    evidence: z.array(ComputerEvidenceArtifactSchema).max(10),
    output: ComputerActionOutputSchema.optional(),
    error: ComputerActionErrorSchema.optional(),
    adapterId: ComputerAdapterIdSchema,
    interactionMode: ComputerInteractionModeSchema,
    coordinateFallbackUsed: z.boolean(),
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
    if (value.status === 'FAILED' && value.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed actions need an error.',
      });
    }
    if (value.coordinateFallbackUsed !== (value.interactionMode === 'COORDINATE_FALLBACK')) {
      context.addIssue({
        code: 'custom',
        path: ['coordinateFallbackUsed'],
        message: 'Coordinate fallback must be explicitly labeled.',
      });
    }
  });

export const ComputerRuntimeStatusSchema = z
  .object({
    available: z.boolean(),
    platform: z.literal('win32'),
    processIsolation: z.literal('dedicated-powershell-process'),
    defaultDemoPath: WindowsPathSchema,
    adapters: z.array(
      z
        .object({
          adapterId: ComputerAdapterIdSchema,
          name: z.string().min(1).max(160),
          available: z.boolean(),
          supportedActions: z.array(ComputerActionTypeSchema),
        })
        .strict(),
    ),
    coordinateFallback: z.literal('explicit-critical-permission-only'),
  })
  .strict();

export const ComputerHistoryInputSchema = z
  .object({ limit: z.number().int().min(1).max(200).default(50) })
  .strict();
export const ComputerHistoryResultSchema = z
  .object({ actions: z.array(ComputerActionResultSchema) })
  .strict();
export const ComputerCancelInputSchema = z.object({ executionId: z.uuid() }).strict();
export const ComputerCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();

export const NotepadDemoInputSchema = z
  .object({
    executionId: z.uuid(),
    outputPath: WindowsPathSchema,
    text: z.string().min(1).max(100_000),
    overwrite: z.boolean().default(false),
  })
  .strict();

export const NotepadDemoResultSchema = z
  .object({
    executionId: z.uuid(),
    success: z.boolean(),
    status: z.enum(['SUCCESS', 'FAILED', 'CANCELLED']),
    observation: z.string().min(1).max(1_000),
    actions: z.array(ComputerActionResultSchema).min(1).max(20),
    artifact: ComputerEvidenceArtifactSchema.optional(),
    error: ComputerActionErrorSchema.optional(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
  })
  .strict();

export type ComputerActionType = z.infer<typeof ComputerActionTypeSchema>;
export type ComputerAdapterId = z.infer<typeof ComputerAdapterIdSchema>;
export type ComputerElementSelector = z.infer<typeof ComputerElementSelectorSchema>;
export type ComputerTarget = z.infer<typeof ComputerTargetSchema>;
export type ComputerActionInput = z.infer<typeof ComputerActionInputSchema>;
export type ComputerUiNode = z.infer<typeof ComputerUiNodeSchema>;
export type ComputerEvidenceArtifact = z.infer<typeof ComputerEvidenceArtifactSchema>;
export type ComputerActionResult = z.infer<typeof ComputerActionResultSchema>;
export type ComputerRuntimeStatus = z.infer<typeof ComputerRuntimeStatusSchema>;
export type ComputerCancelInput = z.infer<typeof ComputerCancelInputSchema>;
export type NotepadDemoInput = z.infer<typeof NotepadDemoInputSchema>;
export type NotepadDemoResult = z.infer<typeof NotepadDemoResultSchema>;
