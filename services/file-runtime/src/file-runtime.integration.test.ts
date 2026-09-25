import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactGenerateInput, FileFormat } from '@jupiter/contracts';
import { JupiterDatabase } from '@jupiter/database';
import { CapabilityPermissionEngine } from '@jupiter/security';
import { ManagedFileArtifactRuntime, type FileHostActions } from './file-artifact-runtime.js';

describe('SET 10 File, Document, Office, and Artifact system', () => {
  let directory: string;
  let approvedRoot: string;
  let trash: string;
  let database: JupiterDatabase;
  let permissions: CapabilityPermissionEngine;
  let runtime: ManagedFileArtifactRuntime;
  let missionId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'jupiter-file-runtime-'));
    approvedRoot = join(directory, 'approved');
    trash = join(directory, 'trash');
    await Promise.all([mkdir(approvedRoot), mkdir(trash)]);
    database = JupiterDatabase.open(join(directory, 'jupiter.db'));
    missionId = randomUUID();
    const timestamp = new Date().toISOString();
    database.createMission({
      missionId,
      title: 'SET 10 fixture',
      userRequest: 'Create verified Office artifacts.',
      status: 'READY',
      priority: 'NORMAL',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    permissions = new CapabilityPermissionEngine({ repository: database });
    const host: FileHostActions = {
      openPath: () => Promise.resolve(''),
      revealPath: () => undefined,
      copyPath: () => undefined,
      deletePath: async (path) => {
        try {
          await rename(path, join(trash, `${randomUUID()}-${basename(path)}`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      },
    };
    runtime = new ManagedFileArtifactRuntime({
      repository: database,
      permissions,
      managedWorkspace: join(directory, 'artifacts'),
      host,
    });
    database.upsertApprovedFileRoot({
      rootId: randomUUID(),
      displayName: 'Controlled fixture',
      path: approvedRoot,
      writable: true,
      managed: false,
      approvedAt: timestamp,
    });
  });

  afterEach(async () => {
    await runtime.shutdown();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('finds the newest file and reads TXT from an approved root', async () => {
    const older = join(approvedRoot, 'a-older.txt');
    const newest = join(approvedRoot, 'z-newest.txt');
    await writeFile(older, 'old', 'utf8');
    await writeFile(newest, 'Hello Jupiter', 'utf8');
    await utimes(older, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));
    await utimes(newest, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const root = required(
      runtime.roots().find((item) => !item.managed),
      'approved root',
    );
    const result = await runtime.find({ rootId: root.rootId, extensions: ['txt'], limit: 1 });
    expect(result.files[0]?.name).toBe('z-newest.txt');
    const document = await runtime.read(
      { rootId: root.rootId, relativePath: 'z-newest.txt' },
      new AbortController().signal,
    );
    expect(document).toMatchObject({ format: 'txt', text: 'Hello Jupiter' });
  });

  it('generates and parses verified DOCX, PPTX, XLSX, PDF, CSV, and JSON artifacts', async () => {
    await authorizeGeneration();
    const docx = await generate('docx', {
      kind: 'document',
      title: 'Verified document',
      paragraphs: ['Hello Jupiter'],
    });
    const pptx = await generate('pptx', {
      kind: 'presentation',
      title: 'Verified presentation',
      slides: [{ title: 'Slide one', body: ['Hello Jupiter'], notes: ['Speaker note'] }],
    });
    const xlsx = await generate('xlsx', {
      kind: 'spreadsheet',
      sheets: [
        {
          name: 'Data',
          rows: [
            ['=UNTRUSTED()', 2],
            [{ formula: '=SUM(B1:B1)', result: 2 }, true],
          ],
        },
      ],
    });
    const pdf = await generate('pdf', {
      kind: 'document',
      title: 'Verified PDF',
      paragraphs: ['Hello Jupiter'],
    });
    const csv = await generate('csv', {
      kind: 'spreadsheet',
      sheets: [{ name: 'Data', rows: [['=UNTRUSTED()', 'safe']] }],
    });
    const json = await generate('json', { kind: 'json', value: { hello: 'Jupiter' } });

    for (const artifact of [docx, pptx, xlsx, pdf, csv, json]) {
      expect(artifact.verificationStatus).toBe('VERIFIED');
      expect(artifact.hash).toMatch(/^[a-f0-9]{64}$/);
      expect((await stat(artifact.path)).size).toBeGreaterThan(0);
    }
    const managedRoot = required(
      runtime.roots().find((item) => item.managed),
      'managed root',
    );
    const readGenerated = async (path: string) =>
      runtime.read(
        { rootId: managedRoot.rootId, relativePath: `${missionId}/${basename(path)}` },
        new AbortController().signal,
      );
    const [docxDocument, pptxDocument, xlsxDocument, pdfDocument] = await Promise.all([
      readGenerated(docx.path),
      readGenerated(pptx.path),
      readGenerated(xlsx.path),
      readGenerated(pdf.path),
    ]);
    expect(docxDocument.text).toContain('Hello Jupiter');
    expect(pptxDocument).toMatchObject({ metadata: { slides: 1 } });
    expect(pptxDocument.text).toContain('Slide one');
    expect(xlsxDocument).toMatchObject({ metadata: { sheets: 1, formulas: 1 } });
    expect(xlsxDocument.text).toContain('=SUM(B1:B1)');
    expect(pdfDocument).toMatchObject({ metadata: { pages: 1 } });
    expect(pdfDocument.text).toContain('Verified PDF');
    expect((await readFile(csv.path, 'utf8')).startsWith("'=UNTRUSTED()")).toBe(true);
    expect(database.listMissionArtifacts(missionId)).toHaveLength(6);
    expect(
      database.listMissionArtifacts(missionId).every((item) => item.status === 'VERIFIED'),
    ).toBe(true);
  });

  it('requires exact CRITICAL permission before deleting a managed artifact', async () => {
    await authorizeGeneration();
    const artifact = await generate('txt', { kind: 'text', text: 'delete fixture' });
    await expect(
      runtime.act({ artifactId: artifact.artifactId, action: 'DELETE' }, 'test'),
    ).rejects.toMatchObject({
      code: 'PERMISSION_REQUIRED',
    });
    const request = required(
      permissions.listRequests('PENDING').find((item) => item.capability === 'files.delete'),
      'delete permission request',
    );
    expect(request.target.id).toBe(artifact.path);
    expect(request.availableDecisions).not.toContain('ALWAYS_ALLOW');
    permissions.resolve({ requestId: request.requestId, decision: 'ALLOW_ONCE' }, 'USER_EXPLICIT');
    const result = await runtime.act({ artifactId: artifact.artifactId, action: 'DELETE' }, 'test');
    expect(result.success).toBe(true);
    expect(result.artifact?.deletedAt).toBeTypeOf('string');
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal, scope escape, and corrupt or missing documents without crashing', async () => {
    const root = required(
      runtime.roots().find((item) => !item.managed),
      'approved root',
    );
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'escaped.txt'), 'outside approved scope', 'utf8');
    await symlink(outside, join(approvedRoot, 'linked-outside'), 'junction');
    await writeFile(join(approvedRoot, 'corrupt.pdf'), 'not a pdf', 'utf8');
    await expect(
      runtime.read(
        { rootId: root.rootId, relativePath: '../outside.txt' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FILE_SCOPE_ESCAPE' });
    await expect(
      runtime.read(
        { rootId: root.rootId, relativePath: 'missing.txt' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(
      runtime.read(
        { rootId: root.rootId, relativePath: 'linked-outside/escaped.txt' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'FILE_REPARSE_POINT_REJECTED' });
    await expect(
      runtime.read(
        { rootId: root.rootId, relativePath: 'corrupt.pdf' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_PARSE_FAILED' });
    expect(runtime.status().available).toBe(true);
  });

  async function authorizeGeneration(): Promise<void> {
    await expect(generate('txt', { kind: 'text', text: 'permission probe' })).rejects.toMatchObject(
      { code: 'PERMISSION_REQUIRED' },
    );
    const request = required(
      permissions.listRequests('PENDING').find((item) => item.capability === 'artifacts.generate'),
      'artifact generation permission request',
    );
    permissions.resolve(
      { requestId: request.requestId, decision: 'ALLOW_SESSION' },
      'USER_EXPLICIT',
    );
  }

  async function generate(
    type: Exclude<FileFormat, 'markdown'>,
    content: ArtifactGenerateInput['content'],
  ) {
    return runtime.generate(
      {
        missionId,
        name: `fixture.${type}`,
        type,
        content,
        source: { kind: 'generated', description: 'Controlled integration fixture' },
      },
      'test',
      new AbortController().signal,
    );
  }
});

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}
