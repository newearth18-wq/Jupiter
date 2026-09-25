import { z } from 'zod';
import { MissionIdSchema } from './mission.js';

const SafeNameSchema = z.string().trim().min(1).max(255);
const RelativePathSchema = z.string().min(1).max(4_096);

export const FileFormatSchema = z.enum([
  'txt',
  'markdown',
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
  'json',
]);

export const ApprovedFileRootSchema = z
  .object({
    rootId: z.uuid(),
    displayName: z.string().trim().min(1).max(160),
    path: z.string().min(1).max(32_767),
    writable: z.boolean(),
    managed: z.boolean(),
    approvedAt: z.iso.datetime(),
  })
  .strict();

export const FileEntrySchema = z
  .object({
    rootId: z.uuid(),
    relativePath: z.string().max(4_096),
    name: SafeNameSchema,
    kind: z.enum(['file', 'directory']),
    extension: z.string().max(32),
    size: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    modifiedAt: z.iso.datetime(),
    readable: z.boolean(),
    writable: z.boolean(),
  })
  .strict();

export const FileFindInputSchema = z
  .object({
    rootId: z.uuid(),
    relativePath: z.string().max(4_096).default('.'),
    query: z.string().trim().max(255).default(''),
    extensions: z.array(z.string().trim().max(32)).max(30).default([]),
    recursive: z.boolean().default(false),
    sortBy: z.enum(['name', 'modifiedAt', 'size']).default('modifiedAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export const FileFindResultSchema = z
  .object({
    root: ApprovedFileRootSchema,
    files: z.array(FileEntrySchema),
  })
  .strict();

export const DocumentReadInputSchema = z
  .object({ rootId: z.uuid(), relativePath: RelativePathSchema })
  .strict();

export const DocumentReadResultSchema = z
  .object({
    file: FileEntrySchema,
    format: FileFormatSchema,
    text: z.string().max(5_000_000),
    metadata: z.record(z.string().max(120), z.union([z.string(), z.number(), z.boolean()])),
    extractedAt: z.iso.datetime(),
  })
  .strict();

const FileSourceSchema = z
  .object({
    kind: z.enum(['generated', 'file', 'browser', 'computer', 'user']),
    artifactId: z.uuid().optional(),
    path: z.string().max(32_767).optional(),
    description: z.string().max(1_000),
  })
  .strict();

export const ArtifactVerificationStatusSchema = z.enum(['PENDING', 'VERIFIED', 'FAILED']);

export const ManagedArtifactSchema = z
  .object({
    artifactId: z.uuid(),
    missionId: MissionIdSchema,
    name: SafeNameSchema,
    type: FileFormatSchema,
    path: z.string().min(1).max(32_767),
    createdAt: z.iso.datetime(),
    source: FileSourceSchema,
    size: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    verificationStatus: ArtifactVerificationStatusSchema,
    verificationDetails: z.string().min(1).max(2_000),
    creatingStepId: z.string().min(1).max(160).optional(),
    version: z.number().int().positive(),
    parentArtifactId: z.uuid().optional(),
    userSelectedOutput: z.boolean(),
    deletedAt: z.iso.datetime().optional(),
  })
  .strict();

export const ArtifactListInputSchema = z
  .object({
    missionId: MissionIdSchema.optional(),
    includeDeleted: z.boolean().default(false),
  })
  .strict();
export const ArtifactListResultSchema = z
  .object({ artifacts: z.array(ManagedArtifactSchema) })
  .strict();

const SlideImageSchema = z
  .object({
    path: z.string().min(1).max(32_767),
    x: z.number().min(0).max(20),
    y: z.number().min(0).max(20),
    width: z.number().positive().max(20),
    height: z.number().positive().max(20),
  })
  .strict();

const PresentationSlideSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.array(z.string().max(5_000)).max(100),
    notes: z.array(z.string().max(5_000)).max(100).default([]),
    images: z.array(SlideImageSchema).max(20).default([]),
  })
  .strict();

const SpreadsheetCellSchema = z.union([
  z.string().max(100_000),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .object({
      formula: z.string().trim().min(1).max(8_192),
      result: z.union([z.string().max(100_000), z.number(), z.boolean()]).optional(),
    })
    .strict(),
]);

const ArtifactContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(5_000_000) }).strict(),
  z.object({ kind: z.literal('json'), value: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal('document'),
      title: z.string().trim().min(1).max(300),
      paragraphs: z.array(z.string().max(50_000)).min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('presentation'),
      title: z.string().trim().min(1).max(300),
      theme: z.enum(['jupiter', 'minimal']).default('jupiter'),
      slides: z.array(PresentationSlideSchema).min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('spreadsheet'),
      sheets: z
        .array(
          z
            .object({
              name: z.string().trim().min(1).max(31),
              rows: z.array(z.array(SpreadsheetCellSchema).max(1_000)).max(100_000),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
]);

export const ArtifactGenerateInputSchema = z
  .object({
    missionId: MissionIdSchema,
    name: SafeNameSchema,
    type: FileFormatSchema,
    content: ArtifactContentSchema,
    source: FileSourceSchema,
    creatingStepId: z.string().min(1).max(160).optional(),
    parentArtifactId: z.uuid().optional(),
    userSelectedOutput: z.boolean().default(false),
  })
  .strict();

export const FileMutationActionSchema = z.enum([
  'CREATE_FOLDER',
  'COPY',
  'MOVE',
  'RENAME',
  'DELETE',
]);
const FileMutationBaseSchema = z.object({ rootId: z.uuid() });
export const FileMutationInputSchema = z.discriminatedUnion('action', [
  FileMutationBaseSchema.extend({
    action: z.literal('CREATE_FOLDER'),
    relativePath: RelativePathSchema,
  }).strict(),
  FileMutationBaseSchema.extend({
    action: z.literal('COPY'),
    relativePath: RelativePathSchema,
    destinationRelativePath: RelativePathSchema,
  }).strict(),
  FileMutationBaseSchema.extend({
    action: z.literal('MOVE'),
    relativePath: RelativePathSchema,
    destinationRelativePath: RelativePathSchema,
  }).strict(),
  FileMutationBaseSchema.extend({
    action: z.literal('RENAME'),
    relativePath: RelativePathSchema,
    destinationRelativePath: RelativePathSchema,
  }).strict(),
  FileMutationBaseSchema.extend({
    action: z.literal('DELETE'),
    relativePath: RelativePathSchema,
  }).strict(),
]);

export const FileMutationResultSchema = z
  .object({ action: FileMutationActionSchema, success: z.boolean(), path: z.string() })
  .strict();

export const FileRootApproveInputSchema = z
  .object({
    path: z.string().min(1).max(32_767),
    displayName: z.string().trim().min(1).max(160),
    writable: z.boolean(),
  })
  .strict();

export const ArtifactActionInputSchema = z
  .object({
    artifactId: z.uuid(),
    action: z.enum(['OPEN', 'REVEAL', 'COPY_PATH', 'DELETE', 'SHARE']),
  })
  .strict();

export const ArtifactActionResultSchema = z
  .object({
    action: ArtifactActionInputSchema.shape.action,
    success: z.boolean(),
    availability: z.enum(['available', 'unavailable']),
    message: z.string().min(1).max(1_000),
    artifact: ManagedArtifactSchema.optional(),
  })
  .strict();

export const FileRuntimeStatusSchema = z
  .object({
    available: z.boolean(),
    managedWorkspace: z.string().min(1).max(32_767),
    supportedReadFormats: z.array(FileFormatSchema),
    supportedCreateFormats: z.array(FileFormatSchema),
    approvedRootCount: z.number().int().nonnegative(),
  })
  .strict();

export type ApprovedFileRoot = z.infer<typeof ApprovedFileRootSchema>;
export type FileFormat = z.infer<typeof FileFormatSchema>;
export type FileEntry = z.infer<typeof FileEntrySchema>;
export type FileFindInput = z.input<typeof FileFindInputSchema>;
export type FileFindResult = z.infer<typeof FileFindResultSchema>;
export type DocumentReadInput = z.infer<typeof DocumentReadInputSchema>;
export type DocumentReadResult = z.infer<typeof DocumentReadResultSchema>;
export type ManagedArtifact = z.infer<typeof ManagedArtifactSchema>;
export type ArtifactListInput = z.input<typeof ArtifactListInputSchema>;
export type ArtifactGenerateInput = z.input<typeof ArtifactGenerateInputSchema>;
export type FileMutationInput = z.infer<typeof FileMutationInputSchema>;
export type FileMutationResult = z.infer<typeof FileMutationResultSchema>;
export type FileRootApproveInput = z.infer<typeof FileRootApproveInputSchema>;
export type ArtifactActionInput = z.infer<typeof ArtifactActionInputSchema>;
export type ArtifactActionResult = z.infer<typeof ArtifactActionResultSchema>;
export type FileRuntimeStatus = z.infer<typeof FileRuntimeStatusSchema>;
