import { describe, expect, it } from 'vitest';
import {
  ArtifactGenerateInputSchema,
  FileFindInputSchema,
  FileMutationInputSchema,
  ManagedArtifactSchema,
} from './artifact.js';

describe('artifact contracts', () => {
  it('applies bounded file-search defaults', () => {
    const input = FileFindInputSchema.parse({ rootId: crypto.randomUUID() });
    expect(input).toMatchObject({ relativePath: '.', recursive: false, limit: 100 });
  });

  it('rejects unknown file operations', () => {
    expect(() =>
      FileMutationInputSchema.parse({
        rootId: crypto.randomUUID(),
        action: 'EXECUTE',
        relativePath: 'unsafe.exe',
      }),
    ).toThrow();
  });

  it('requires verified artifact identity fields', () => {
    expect(() =>
      ManagedArtifactSchema.parse({
        artifactId: crypto.randomUUID(),
        missionId: crypto.randomUUID(),
        name: 'report.docx',
        type: 'docx',
      }),
    ).toThrow();
  });

  it('validates typed Office generation content', () => {
    expect(
      ArtifactGenerateInputSchema.parse({
        missionId: crypto.randomUUID(),
        name: 'report.pptx',
        type: 'pptx',
        content: {
          kind: 'presentation',
          title: 'Jupiter',
          slides: [{ title: 'Verified', body: ['Real output'] }],
        },
        source: { kind: 'generated', description: 'Contract fixture' },
      }).content.kind,
    ).toBe('presentation');
  });
});
