import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  ApprovedFileRootSchema,
  ArtifactActionInputSchema,
  ArtifactActionResultSchema,
  ArtifactGenerateInputSchema,
  ArtifactListInputSchema,
  DocumentReadInputSchema,
  DocumentReadResultSchema,
  FileEntrySchema,
  FileFindInputSchema,
  FileFindResultSchema,
  FileMutationInputSchema,
  FileMutationResultSchema,
  FileRootApproveInputSchema,
  FileRuntimeStatusSchema,
  ManagedArtifactSchema,
  type Actor,
  type ApprovedFileRoot,
  type ArtifactActionInput,
  type ArtifactActionResult,
  type ArtifactGenerateInput,
  type ArtifactListInput,
  type DocumentReadInput,
  type DocumentReadResult,
  type FileEntry,
  type FileFindInput,
  type FileFindResult,
  type FileFormat,
  type FileMutationInput,
  type FileMutationResult,
  type FileRootApproveInput,
  type FileRuntimeStatus,
  type ManagedArtifact,
  type MissionArtifact,
  type PermissionCapability,
} from '@jupiter/contracts';
import {
  JupiterError,
  type ArtifactRepository,
  type FileArtifactRuntime,
  type MissionRepository,
  type PermissionRuntime,
} from '@jupiter/core';
import { extractDocument } from './document-adapters.js';
import {
  generateArtifactBytes,
  verifyArtifactBytes,
  type ArtifactWriterOptions,
} from './office-writers.js';

export type FileHostActions = {
  openPath: (path: string) => Promise<string>;
  revealPath: (path: string) => void;
  copyPath: (path: string) => void;
  deletePath: (path: string) => Promise<void>;
};

export type FileArtifactRuntimeOptions = {
  repository: ArtifactRepository & Pick<MissionRepository, 'addMissionArtifact'>;
  permissions: PermissionRuntime;
  managedWorkspace: string;
  host: FileHostActions;
  writerOptions?: ArtifactWriterOptions;
  now?: () => Date;
};

const READ_FORMATS: readonly FileFormat[] = [
  'txt',
  'markdown',
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
  'json',
];
const CREATE_FORMATS: readonly FileFormat[] = [
  'txt',
  'markdown',
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
  'json',
];
const CAPABILITIES: readonly PermissionCapability[] = [
  capability('files.root.approve', 'Approve a local file root', 'HIGH'),
  capability('files.write', 'Create, copy, move, or rename local files', 'HIGH'),
  capability('files.delete', 'Delete an exact local file or folder', 'CRITICAL'),
  capability('files.open', 'Open or reveal an exact local file', 'LOW'),
  capability('artifacts.generate', 'Generate a verified Mission artifact', 'MEDIUM'),
];

export class ManagedFileArtifactRuntime implements FileArtifactRuntime {
  readonly #repository: FileArtifactRuntimeOptions['repository'];
  readonly #permissions: PermissionRuntime;
  readonly #workspace: string;
  readonly #host: FileHostActions;
  readonly #writerOptions: ArtifactWriterOptions;
  readonly #now: () => Date;
  readonly #managedRoot: ApprovedFileRoot;
  #closed = false;

  constructor(options: FileArtifactRuntimeOptions) {
    this.#repository = options.repository;
    this.#permissions = options.permissions;
    const requestedWorkspace = resolve(options.managedWorkspace);
    mkdirSync(requestedWorkspace, { recursive: true });
    const workspaceDetails = lstatSync(requestedWorkspace);
    if (!workspaceDetails.isDirectory() || workspaceDetails.isSymbolicLink())
      throw fileError(
        'ARTIFACT_WORKSPACE_INVALID',
        'The managed artifact workspace must be a real local directory.',
      );
    this.#workspace = realpathSync(requestedWorkspace);
    this.#host = options.host;
    this.#writerOptions = options.writerOptions ?? {};
    this.#now = options.now ?? (() => new Date());
    for (const definition of CAPABILITIES) {
      if (
        !this.#permissions
          .listCapabilities()
          .some((item) => item.capability === definition.capability)
      )
        this.#permissions.registerCapability(definition);
    }
    const existing = this.#repository
      .listApprovedFileRoots()
      .find((root) => root.managed && resolve(root.path) === this.#workspace);
    this.#managedRoot =
      existing ??
      ApprovedFileRootSchema.parse({
        rootId: randomUUID(),
        displayName: 'Jupiter managed artifacts',
        path: this.#workspace,
        writable: true,
        managed: true,
        approvedAt: this.#timestamp(),
      });
    this.#repository.upsertApprovedFileRoot(this.#managedRoot);
  }

  status(): FileRuntimeStatus {
    return FileRuntimeStatusSchema.parse({
      available: !this.#closed,
      managedWorkspace: this.#workspace,
      supportedReadFormats: READ_FORMATS,
      supportedCreateFormats: CREATE_FORMATS,
      approvedRootCount: this.roots().length,
    });
  }

  roots(): ApprovedFileRoot[] {
    return this.#repository.listApprovedFileRoots();
  }

  approveRoot(input: FileRootApproveInput, actor: Actor): ApprovedFileRoot {
    this.#assertAvailable();
    const valid = FileRootApproveInputSchema.parse(input);
    const requestedPath = resolve(valid.path);
    let path: string;
    try {
      const details = lstatSync(requestedPath);
      if (!details.isDirectory() || details.isSymbolicLink())
        throw fileError(
          'FILE_ROOT_INVALID',
          'An approved root must be a real directory, not a file, link, or junction.',
        );
      path = realpathSync(requestedPath);
      accessSync(path, valid.writable ? constants.R_OK | constants.W_OK : constants.R_OK);
    } catch (error) {
      if (error instanceof JupiterError) throw error;
      throw fileError(
        'FILE_ROOT_INVALID',
        'The requested root does not exist or does not have the requested access.',
      );
    }
    this.#requirePermission('files.root.approve', path, 'file-root:approve', actor);
    const existing = this.#repository
      .listApprovedFileRoots()
      .find((root) => resolve(root.path).toLocaleLowerCase() === path.toLocaleLowerCase());
    if (existing) return existing;
    const root = ApprovedFileRootSchema.parse({
      rootId: randomUUID(),
      displayName: valid.displayName,
      path,
      writable: valid.writable,
      managed: false,
      approvedAt: this.#timestamp(),
    });
    this.#repository.upsertApprovedFileRoot(root);
    return root;
  }

  async find(input: FileFindInput): Promise<FileFindResult> {
    this.#assertAvailable();
    const valid = FileFindInputSchema.parse(input);
    const root = this.#root(valid.rootId);
    const directory = await this.#resolveExisting(root, valid.relativePath);
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory())
      throw fileError('FILE_NOT_DIRECTORY', 'The requested path is not a directory.');
    const entries: FileEntry[] = [];
    const pending = [directory];
    let scanned = 0;
    const scanLimit = 10_000;
    while (pending.length > 0 && scanned < scanLimit) {
      const current = pending.shift();
      if (!current) break;
      for (const item of await readdir(current, { withFileTypes: true })) {
        if (scanned >= scanLimit) break;
        scanned += 1;
        const absolutePath = resolve(current, item.name);
        const itemStat = await lstat(absolutePath);
        if (itemStat.isSymbolicLink()) continue;
        const extension = extname(item.name).toLowerCase();
        const matchesQuery = item.name
          .toLocaleLowerCase()
          .includes(valid.query.toLocaleLowerCase());
        const matchesExtension =
          valid.extensions.length === 0 ||
          valid.extensions.map(normalizeExtension).includes(extension);
        if (matchesQuery && (item.isDirectory() || matchesExtension))
          entries.push(await this.#fileEntry(root, absolutePath));
        if (valid.recursive && item.isDirectory()) pending.push(absolutePath);
      }
    }
    entries.sort((left, right) => compareEntries(left, right, valid.sortBy, valid.order));
    return FileFindResultSchema.parse({ root, files: entries.slice(0, valid.limit) });
  }

  async read(input: DocumentReadInput, signal: AbortSignal): Promise<DocumentReadResult> {
    this.#assertAvailable();
    assertNotAborted(signal, 'FILE_READ_CANCELLED', 'The document read was cancelled.');
    const valid = DocumentReadInputSchema.parse(input);
    const root = this.#root(valid.rootId);
    const path = await this.#resolveExisting(root, valid.relativePath);
    const file = await this.#fileEntry(root, path);
    if (file.kind !== 'file')
      throw fileError('FILE_NOT_READABLE', 'The requested path is not a file.');
    try {
      const extracted = await extractDocument(path);
      assertNotAborted(signal, 'FILE_READ_CANCELLED', 'The document read was cancelled.');
      return DocumentReadResultSchema.parse({ ...extracted, file, extractedAt: this.#timestamp() });
    } catch (error) {
      if (error instanceof JupiterError) throw error;
      throw fileError(
        'DOCUMENT_PARSE_FAILED',
        sanitizedMessage(error),
        'Choose a supported, readable document that is not corrupted.',
      );
    }
  }

  async mutate(input: FileMutationInput, actor: Actor): Promise<FileMutationResult> {
    this.#assertAvailable();
    const valid = FileMutationInputSchema.parse(input);
    const root = this.#root(valid.rootId);
    if (!root.writable) throw fileError('FILE_ROOT_READ_ONLY', 'The approved root is read-only.');
    const target =
      valid.action === 'CREATE_FOLDER'
        ? await this.#resolveDestination(root, valid.relativePath)
        : await this.#resolveExisting(root, valid.relativePath);
    if (valid.action === 'DELETE') {
      this.#requirePermission('files.delete', target, 'file:delete', actor);
      await this.#host.deletePath(target);
      return FileMutationResultSchema.parse({ action: valid.action, success: true, path: target });
    }
    if (valid.action === 'CREATE_FOLDER') {
      this.#requirePermission('files.write', target, 'file:create_folder', actor);
      await mkdir(target);
      return FileMutationResultSchema.parse({ action: valid.action, success: true, path: target });
    }
    const destination = await this.#resolveDestination(root, valid.destinationRelativePath);
    await assertDestinationAbsent(destination);
    this.#requirePermission(
      'files.write',
      destination,
      `file:${valid.action.toLowerCase()}`,
      actor,
    );
    if (valid.action === 'COPY') await this.#atomicCopy(target, destination);
    else await rename(target, destination);
    return FileMutationResultSchema.parse({
      action: valid.action,
      success: true,
      path: destination,
    });
  }

  artifacts(input: ArtifactListInput): ManagedArtifact[] {
    return this.#repository.listManagedArtifacts(ArtifactListInputSchema.parse(input));
  }

  async generate(
    input: ArtifactGenerateInput,
    actor: Actor,
    signal: AbortSignal,
  ): Promise<ManagedArtifact> {
    this.#assertAvailable();
    const valid = ArtifactGenerateInputSchema.parse(input);
    const missionDirectory = resolve(this.#workspace, valid.missionId);
    this.#assertWithin(this.#workspace, missionDirectory);
    this.#requirePermission(
      'artifacts.generate',
      missionDirectory,
      'artifact:generate',
      actor,
      valid.missionId,
    );
    assertNotAborted(signal, 'ARTIFACT_GENERATION_CANCELLED', 'Artifact generation was cancelled.');
    await mkdir(missionDirectory, { recursive: true });
    const parent = valid.parentArtifactId
      ? this.#repository.getManagedArtifact(valid.parentArtifactId)
      : undefined;
    if (valid.parentArtifactId && !parent)
      throw fileError('ARTIFACT_PARENT_NOT_FOUND', 'The parent artifact does not exist.');
    if (parent && parent.missionId !== valid.missionId)
      throw fileError(
        'ARTIFACT_PARENT_MISSION_MISMATCH',
        'Artifact lineage cannot cross Mission boundaries.',
      );
    const version = parent ? parent.version + 1 : 1;
    const name = normalizedArtifactName(valid.name, valid.type, version);
    const destination = resolve(missionDirectory, name);
    this.#assertWithin(missionDirectory, destination);
    await assertDestinationAbsent(destination);
    const bytes = await generateArtifactBytes(valid, this.#writerOptions);
    assertNotAborted(signal, 'ARTIFACT_GENERATION_CANCELLED', 'Artifact generation was cancelled.');
    const verificationDetails = await verifyArtifactBytes(valid.type, bytes, valid.content);
    try {
      await atomicWrite(destination, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw fileError(
          'ARTIFACT_ALREADY_EXISTS',
          'An artifact with this name and version already exists. Choose a new name or parent version.',
        );
      throw error;
    }
    const persisted = await readFile(destination);
    const details = await stat(destination);
    if (persisted.byteLength !== bytes.byteLength || details.size === 0)
      throw fileError(
        'ARTIFACT_WRITE_VERIFICATION_FAILED',
        'The written artifact could not be verified.',
      );
    const artifact = ManagedArtifactSchema.parse({
      artifactId: randomUUID(),
      missionId: valid.missionId,
      name,
      type: valid.type,
      path: destination,
      createdAt: this.#timestamp(),
      source: valid.source,
      size: details.size,
      hash: hash(persisted),
      verificationStatus: 'VERIFIED',
      verificationDetails,
      ...(valid.creatingStepId ? { creatingStepId: valid.creatingStepId } : {}),
      version,
      ...(valid.parentArtifactId ? { parentArtifactId: valid.parentArtifactId } : {}),
      userSelectedOutput: valid.userSelectedOutput,
    });
    this.#repository.upsertManagedArtifact(artifact);
    const missionArtifact: MissionArtifact = {
      missionArtifactId: randomUUID(),
      missionId: artifact.missionId,
      artifactId: artifact.artifactId,
      name: artifact.name,
      kind: artifact.type,
      status: 'VERIFIED',
      createdAt: artifact.createdAt,
    };
    this.#repository.addMissionArtifact(missionArtifact);
    return artifact;
  }

  async act(input: ArtifactActionInput, actor: Actor): Promise<ArtifactActionResult> {
    this.#assertAvailable();
    const valid = ArtifactActionInputSchema.parse(input);
    const artifact = this.#repository.getManagedArtifact(valid.artifactId);
    if (!artifact || artifact.deletedAt)
      throw fileError('ARTIFACT_NOT_FOUND', 'The artifact does not exist or was already deleted.');
    if (valid.action === 'SHARE') {
      return ArtifactActionResultSchema.parse({
        action: valid.action,
        success: false,
        availability: 'unavailable',
        message: 'Share is unavailable until an explicit destination integration is configured.',
        artifact,
      });
    }
    if (valid.action === 'COPY_PATH') {
      this.#host.copyPath(artifact.path);
      return ArtifactActionResultSchema.parse({
        action: valid.action,
        success: true,
        availability: 'available',
        message: 'The exact artifact path was copied.',
        artifact,
      });
    }
    this.#requirePermission(
      valid.action === 'DELETE' ? 'files.delete' : 'files.open',
      artifact.path,
      `artifact:${valid.action.toLowerCase()}`,
      actor,
      artifact.missionId,
    );
    if (valid.action === 'DELETE') {
      if (artifact.userSelectedOutput)
        throw fileError(
          'ARTIFACT_USER_OUTPUT_PROTECTED',
          'User-selected outputs are never removed by Artifact Manager cleanup.',
        );
      await this.#host.deletePath(artifact.path);
      const deleted = ManagedArtifactSchema.parse({ ...artifact, deletedAt: this.#timestamp() });
      this.#repository.upsertManagedArtifact(deleted);
      return ArtifactActionResultSchema.parse({
        action: valid.action,
        success: true,
        availability: 'available',
        message: 'The exact managed artifact was moved to the Recycle Bin.',
        artifact: deleted,
      });
    }
    if (valid.action === 'OPEN') {
      const error = await this.#host.openPath(artifact.path);
      if (error) throw fileError('ARTIFACT_OPEN_FAILED', error);
    } else {
      this.#host.revealPath(artifact.path);
    }
    return ArtifactActionResultSchema.parse({
      action: valid.action,
      success: true,
      availability: 'available',
      message: valid.action === 'OPEN' ? 'Artifact opened.' : 'Artifact revealed in File Explorer.',
      artifact,
    });
  }

  shutdown(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  #root(rootId: string): ApprovedFileRoot {
    const root = this.#repository.getApprovedFileRoot(rootId);
    if (!root)
      throw fileError('FILE_ROOT_NOT_APPROVED', 'The requested file root is not approved.');
    return root;
  }

  async #resolveExisting(root: ApprovedFileRoot, relativePath: string): Promise<string> {
    const candidate = this.#candidate(root, relativePath);
    await this.#rejectReparseSegments(root.path, candidate);
    try {
      const [realRoot, realCandidate] = await Promise.all([
        realpath(root.path),
        realpath(candidate),
      ]);
      this.#assertWithin(realRoot, realCandidate);
      return realCandidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw fileError('FILE_NOT_FOUND', 'The requested file or directory does not exist.');
      throw error;
    }
  }

  async #resolveDestination(root: ApprovedFileRoot, relativePath: string): Promise<string> {
    const candidate = this.#candidate(root, relativePath);
    const parent = resolve(candidate, '..');
    await this.#rejectReparseSegments(root.path, parent);
    const [realRoot, realParent] = await Promise.all([realpath(root.path), realpath(parent)]);
    this.#assertWithin(realRoot, realParent);
    return resolve(realParent, basename(candidate));
  }

  #candidate(root: ApprovedFileRoot, relativePath: string): string {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes('..'))
      throw fileError('FILE_SCOPE_ESCAPE', 'Absolute paths and parent traversal are not allowed.');
    const candidate = resolve(root.path, relativePath);
    this.#assertWithin(resolve(root.path), candidate);
    return candidate;
  }

  #assertWithin(root: string, candidate: string): void {
    const pathFromRoot = relative(resolve(root), resolve(candidate));
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot))
      throw fileError('FILE_SCOPE_ESCAPE', 'The resolved path escapes the approved root.');
  }

  async #rejectReparseSegments(root: string, candidate: string): Promise<void> {
    this.#assertWithin(root, candidate);
    const parts = relative(resolve(root), resolve(candidate)).split(sep).filter(Boolean);
    let current = resolve(root);
    const rootStat = await lstat(current);
    if (rootStat.isSymbolicLink())
      throw fileError(
        'FILE_REPARSE_POINT_REJECTED',
        'Approved roots cannot be symbolic links or junctions.',
      );
    for (const part of parts) {
      current = resolve(current, part);
      try {
        const item = await lstat(current);
        if (item.isSymbolicLink())
          throw fileError(
            'FILE_REPARSE_POINT_REJECTED',
            'Symbolic links and junctions are not allowed in approved paths.',
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
  }

  async #fileEntry(root: ApprovedFileRoot, path: string): Promise<FileEntry> {
    const details = await stat(path);
    let readable = true;
    let writable = root.writable;
    try {
      await access(path, constants.R_OK);
    } catch {
      readable = false;
    }
    try {
      await access(path, constants.W_OK);
    } catch {
      writable = false;
    }
    return FileEntrySchema.parse({
      rootId: root.rootId,
      relativePath: relative(root.path, path) || '.',
      name: basename(path),
      kind: details.isDirectory() ? 'directory' : 'file',
      extension: details.isDirectory() ? '' : extname(path).toLowerCase(),
      size: details.isDirectory() ? 0 : details.size,
      createdAt: details.birthtime.toISOString(),
      modifiedAt: details.mtime.toISOString(),
      readable,
      writable,
    });
  }

  async #atomicCopy(source: string, destination: string): Promise<void> {
    const temporary = `${destination}.jupiter-${randomUUID()}.tmp`;
    try {
      await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  #requirePermission(
    capabilityName: string,
    target: string,
    scope: string,
    actor: Actor,
    missionId?: string,
  ): void {
    const requesterType = actor === 'renderer' ? 'UI' : actor === 'service' ? 'AGENT' : 'CORE';
    const requesterId = requesterType === 'UI' ? 'files-artifacts-screen' : 'file-artifact-runtime';
    const authorization = this.#permissions.authorize({
      capability: capabilityName,
      actor,
      requesterType,
      requesterId,
      declaredCapabilities: [capabilityName],
      targetId: target,
      scopeId: scope,
      ...(missionId ? { missionId } : {}),
      constraints: { exactTargetFingerprint: hash(Buffer.from(target, 'utf8')) },
      automated: false,
    });
    if (authorization.status === 'ALLOWED') return;
    if (authorization.status === 'DENIED')
      throw permissionError('FILE_PERMISSION_DENIED', 'Permission policy denied this file action.');
    const request = this.#permissions.request({
      capability: capabilityName,
      action: `${capabilityName} on the exact local target.`,
      reason: 'The user requested a real File or Artifact action.',
      target: { type: 'local-path', id: target, display: target },
      scope: { type: 'file-action', id: scope, display: scope },
      requester: {
        actor,
        type: requesterType,
        id: requesterId,
        display: requesterType === 'UI' ? 'Files and Artifacts screen' : 'File Artifact Runtime',
        declaredCapabilities: [capabilityName],
        ...(missionId ? { missionId } : {}),
      },
      trustSource: requesterType === 'UI' ? 'USER_INTENT' : 'TRUSTED_RUNTIME',
      dataLeavingDevice: { value: false, description: 'The action remains on this device.' },
      consequence:
        capabilityName === 'files.delete'
          ? 'The exact target will be moved to the Recycle Bin and its availability will change.'
          : 'The exact approved local target may be created, changed, opened, or revealed.',
      reversible: capabilityName !== 'files.delete',
      automated: false,
      constraints: { exactTargetFingerprint: hash(Buffer.from(target, 'utf8')) },
    });
    throw new JupiterError({
      code: 'PERMISSION_REQUIRED',
      category: 'permission',
      message: 'Explicit permission is required before the file action can run.',
      recoverable: true,
      retryable: true,
      userAction: 'Review the exact target in Permission Center, then retry.',
      sanitizedDetails: `permissionRequestId=${request.requestId}`,
    });
  }

  #assertAvailable(): void {
    if (this.#closed)
      throw fileError('FILE_RUNTIME_UNAVAILABLE', 'File and Artifact Runtime is unavailable.');
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.jupiter-${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assertDestinationAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw fileError(
    'FILE_DESTINATION_EXISTS',
    'The destination already exists. Jupiter will not overwrite it implicitly.',
  );
}

function normalizedArtifactName(name: string, type: FileFormat, version: number): string {
  const requested = basename(name)
    .replace(/[<>:"/\\|?*]/g, '-')
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .trim();
  const extension = `.${type === 'markdown' ? 'md' : type}`;
  const stem = requested.toLowerCase().endsWith(extension)
    ? requested.slice(0, -extension.length)
    : requested;
  return `${stem}${version > 1 ? `-v${String(version)}` : ''}${extension}`;
}

function assertNotAborted(signal: AbortSignal, code: string, message: string): void {
  if (signal.aborted) throw fileError(code, message);
}

function normalizeExtension(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

function compareEntries(
  left: FileEntry,
  right: FileEntry,
  sortBy: 'name' | 'modifiedAt' | 'size',
  order: 'asc' | 'desc',
): number {
  const direction = order === 'asc' ? 1 : -1;
  if (sortBy === 'size') return (left.size - right.size) * direction;
  return left[sortBy].localeCompare(right[sortBy]) * direction;
}

function capability(
  name: string,
  description: string,
  risk: PermissionCapability['risk'],
): PermissionCapability {
  return {
    capability: name,
    name: description,
    description,
    risk,
    allowedRequesterTypes: ['CORE', 'AGENT', 'UI'],
    automationAllowed: false,
    available: true,
  };
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizedMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'The document adapter failed.';
}

function fileError(
  code: string,
  message: string,
  userAction = 'Review the exact approved path and retry.',
): JupiterError {
  return new JupiterError({
    code,
    category: code.includes('SCOPE') || code.includes('REPARSE') ? 'permission' : 'validation',
    message,
    recoverable: true,
    retryable: false,
    userAction,
  });
}

function permissionError(code: string, message: string): JupiterError {
  return new JupiterError({
    code,
    category: 'permission',
    message,
    recoverable: true,
    retryable: false,
    userAction: 'Review the exact request in Permission Center.',
  });
}
