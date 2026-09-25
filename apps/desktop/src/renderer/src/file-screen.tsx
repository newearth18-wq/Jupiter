import {
  ArtifactActionResultSchema,
  ArtifactListResultSchema,
  DocumentReadResultSchema,
  FileFindResultSchema,
  FileRuntimeStatusSchema,
  ApprovedFileRootSchema,
  type ApprovedFileRoot,
  type FileEntry,
  type FileRuntimeStatus,
  type Language,
  type ManagedArtifact,
  type RpcRequestName,
  type RpcResponseEnvelope,
} from '@jupiter/contracts';
import { Button, EmptyState, StatusBadge, Surface } from '@jupiter/ui';
import { useCallback, useEffect, useState } from 'react';

export function FileScreen({
  language,
  onPermissionRequired,
}: {
  language: Language;
  onPermissionRequired: () => void;
}): React.JSX.Element {
  const t = fileCopy(language);
  const [runtime, setRuntime] = useState<FileRuntimeStatus>();
  const [roots, setRoots] = useState<ApprovedFileRoot[]>([]);
  const [rootId, setRootId] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [artifacts, setArtifacts] = useState<ManagedArtifact[]>([]);
  const [query, setQuery] = useState('');
  const [approvalPath, setApprovalPath] = useState('');
  const [approvalName, setApprovalName] = useState('');
  const [preview, setPreview] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [statusResponse, rootsResponse, artifactsResponse] = await Promise.all([
        rpc('query', 'files.status', {}),
        rpc('query', 'files.roots', {}),
        rpc('query', 'artifacts.list', { includeDeleted: false }),
      ]);
      if (statusResponse.status === 'error') throw new Error(statusResponse.error.message);
      if (rootsResponse.status === 'error') throw new Error(rootsResponse.error.message);
      if (artifactsResponse.status === 'error') throw new Error(artifactsResponse.error.message);
      const nextRoots = Array.from((rootsResponse.data as { roots: unknown[] }).roots, (root) =>
        ApprovedFileRootSchema.parse(root),
      );
      setRuntime(FileRuntimeStatusSchema.parse(statusResponse.data));
      setRoots(nextRoots);
      setRootId((current) => (current.length > 0 ? current : (nextRoots[0]?.rootId ?? '')));
      setArtifacts(ArtifactListResultSchema.parse(artifactsResponse.data).artifacts);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError, t.loadFailed));
    }
  }, [t.loadFailed]);

  const findFiles = useCallback(async (): Promise<void> => {
    if (!rootId) return;
    try {
      const response = await rpc('query', 'files.find', {
        rootId,
        relativePath: '.',
        query,
        extensions: [],
        recursive: false,
        sortBy: 'modifiedAt',
        order: 'desc',
        limit: 100,
      });
      if (response.status === 'error') throw new Error(response.error.message);
      setFiles(FileFindResultSchema.parse(response.data).files);
      setError('');
    } catch (findError) {
      setError(messageOf(findError, t.loadFailed));
    }
  }, [query, rootId, t.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void findFiles();
  }, [findFiles]);

  const approveRoot = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const response = await rpc('command', 'files.roots.approve', {
        path: approvalPath,
        displayName: approvalName || approvalPath,
        writable: false,
      });
      if (response.status === 'error') {
        if (response.error.code === 'PERMISSION_REQUIRED') onPermissionRequired();
        throw new Error(response.error.message);
      }
      const root = ApprovedFileRootSchema.parse(response.data);
      setApprovalPath('');
      setApprovalName('');
      setRootId(root.rootId);
      setMessage(t.rootApproved);
      await load();
    } catch (approveError) {
      setError(messageOf(approveError, t.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  const readDocument = async (file: FileEntry): Promise<void> => {
    if (file.kind !== 'file') return;
    setBusy(true);
    setError('');
    try {
      const response = await rpc('query', 'files.read', {
        rootId: file.rootId,
        relativePath: file.relativePath,
      });
      if (response.status === 'error') throw new Error(response.error.message);
      const result = DocumentReadResultSchema.parse(response.data);
      setPreview(result.text.slice(0, 12_000));
      setMessage(`${result.file.name} · ${result.format.toUpperCase()}`);
    } catch (readError) {
      setPreview('');
      setError(messageOf(readError, t.readFailed));
    } finally {
      setBusy(false);
    }
  };

  const actOnArtifact = async (
    artifact: ManagedArtifact,
    action: 'OPEN' | 'REVEAL' | 'COPY_PATH' | 'DELETE' | 'SHARE',
  ): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const response = await rpc('command', 'artifacts.action', {
        artifactId: artifact.artifactId,
        action,
      });
      if (response.status === 'error') {
        if (response.error.code === 'PERMISSION_REQUIRED') onPermissionRequired();
        throw new Error(response.error.message);
      }
      const result = ArtifactActionResultSchema.parse(response.data);
      setMessage(result.message);
      if (action === 'DELETE' && result.success) await load();
    } catch (actionError) {
      setError(messageOf(actionError, t.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  if (runtime && !runtime.available) {
    return (
      <div className="screen" data-screen="files">
        <EmptyState eyebrow={t.unavailable} title={t.title} description={t.unavailableBody} />
      </div>
    );
  }

  return (
    <div
      className="screen file-screen"
      data-file-state={error ? 'error' : runtime?.available ? 'operational' : 'loading'}
      data-screen="files"
    >
      <header className="screen-header file-screen__header">
        <div>
          <span className="j-eyebrow">{t.eyebrow}</span>
          <h1 data-testid="screen-title">{t.title}</h1>
          <p>{t.description}</p>
        </div>
        <StatusBadge tone={runtime?.available ? 'success' : 'neutral'}>
          {runtime?.available ? t.operational : t.loading}
        </StatusBadge>
      </header>

      {(error || message) && (
        <div
          className={`file-screen__notice ${error ? 'file-screen__notice--error' : ''}`}
          role="status"
        >
          {error || message}
        </div>
      )}

      <div className="file-screen__grid">
        <Surface className="file-browser-panel">
          <div className="panel-heading">
            <div>
              <span className="j-eyebrow">{t.approvedRoots}</span>
              <h2>{t.browser}</h2>
            </div>
            <StatusBadge tone="neutral">{String(files.length)}</StatusBadge>
          </div>
          <div className="file-browser-toolbar">
            <select
              aria-label={t.approvedRoots}
              value={rootId}
              onChange={(event) => setRootId(event.currentTarget.value)}
            >
              {roots.map((root) => (
                <option key={root.rootId} value={root.rootId}>
                  {root.displayName}
                  {root.managed ? ` · ${t.managed}` : ''}
                </option>
              ))}
            </select>
            <input
              placeholder={t.search}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div className="file-list" role="list">
            {files.length === 0 ? (
              <p>{t.noFiles}</p>
            ) : (
              files.map((file) => (
                <button
                  key={`${file.rootId}:${file.relativePath}`}
                  disabled={busy || !file.readable}
                  type="button"
                  onClick={() => void readDocument(file)}
                >
                  <span className="file-list__type">
                    {file.kind === 'directory'
                      ? 'DIR'
                      : file.extension.slice(1).toUpperCase() || 'FILE'}
                  </span>
                  <span>
                    <strong>{file.name}</strong>
                    <small>{new Date(file.modifiedAt).toLocaleString(language)}</small>
                  </span>
                </button>
              ))
            )}
          </div>
        </Surface>

        <Surface className="document-preview-panel">
          <span className="j-eyebrow">{t.safePreview}</span>
          <h2>{t.documentContent}</h2>
          {preview ? <pre>{preview}</pre> : <p>{t.previewEmpty}</p>}
        </Surface>
      </div>

      <Surface className="file-root-panel">
        <div>
          <span className="j-eyebrow">{t.addRoot}</span>
          <p>{t.addRootBody}</p>
        </div>
        <input
          placeholder={t.rootName}
          value={approvalName}
          onChange={(event) => setApprovalName(event.currentTarget.value)}
        />
        <input
          placeholder={t.exactPath}
          spellCheck={false}
          value={approvalPath}
          onChange={(event) => setApprovalPath(event.currentTarget.value)}
        />
        <Button
          disabled={busy || approvalPath.trim().length === 0}
          type="button"
          onClick={() => void approveRoot()}
        >
          {t.reviewPermission}
        </Button>
      </Surface>

      <Surface className="artifact-manager-panel">
        <div className="panel-heading">
          <div>
            <span className="j-eyebrow">{t.artifactManager}</span>
            <h2>{t.verifiedArtifacts}</h2>
          </div>
          <StatusBadge tone="neutral">{String(artifacts.length)}</StatusBadge>
        </div>
        {artifacts.length === 0 ? (
          <p>{t.noArtifacts}</p>
        ) : (
          <div className="artifact-list">
            {artifacts.map((artifact) => (
              <article key={artifact.artifactId}>
                <div>
                  <strong>{artifact.name}</strong>
                  <span>
                    {artifact.type.toUpperCase()} · {formatBytes(artifact.size)} · v
                    {artifact.version}
                  </span>
                  <code>{artifact.hash.slice(0, 16)}…</code>
                </div>
                <StatusBadge
                  tone={artifact.verificationStatus === 'VERIFIED' ? 'success' : 'warning'}
                >
                  {artifact.verificationStatus}
                </StatusBadge>
                <div className="button-row">
                  <Button
                    disabled={busy}
                    type="button"
                    variant="secondary"
                    onClick={() => void actOnArtifact(artifact, 'OPEN')}
                  >
                    {t.open}
                  </Button>
                  <Button
                    disabled={busy}
                    type="button"
                    variant="secondary"
                    onClick={() => void actOnArtifact(artifact, 'REVEAL')}
                  >
                    {t.reveal}
                  </Button>
                  <Button
                    disabled={busy}
                    type="button"
                    variant="ghost"
                    onClick={() => void actOnArtifact(artifact, 'COPY_PATH')}
                  >
                    {t.copyPath}
                  </Button>
                  <Button
                    disabled={busy}
                    type="button"
                    variant="ghost"
                    onClick={() => void actOnArtifact(artifact, 'SHARE')}
                  >
                    {t.share}
                  </Button>
                  <Button
                    disabled={busy || artifact.userSelectedOutput}
                    type="button"
                    variant="danger"
                    onClick={() => void actOnArtifact(artifact, 'DELETE')}
                  >
                    {t.delete}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Surface>
    </div>
  );
}

function rpc(
  kind: 'query' | 'command',
  name: RpcRequestName,
  payload: unknown,
): Promise<RpcResponseEnvelope> {
  return window.jupiter.request({
    schemaVersion: 1,
    kind,
    name,
    context: {
      requestId: crypto.randomUUID(),
      actor: 'renderer',
      timestamp: new Date().toISOString(),
    },
    payload,
  } as never);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function fileCopy(language: Language) {
  if (language === 'th') {
    return {
      eyebrow: 'ระบบไฟล์ที่ตรวจสอบได้',
      title: 'ไฟล์และผลงาน',
      description: 'ค้นหา อ่าน และจัดการผลงานจริงภายในขอบเขตโฟลเดอร์ที่อนุมัติ',
      operational: 'พร้อมใช้งาน',
      loading: 'กำลังโหลด',
      unavailable: 'ไม่พร้อมใช้งาน',
      unavailableBody: 'File Runtime ไม่พร้อมใช้งาน',
      approvedRoots: 'โฟลเดอร์ที่อนุมัติ',
      browser: 'ตัวเรียกดูไฟล์',
      managed: 'จัดการโดย Jupiter',
      search: 'ค้นหาไฟล์…',
      noFiles: 'ไม่พบไฟล์ในขอบเขตนี้',
      safePreview: 'ตัวแปลงเอกสาร',
      documentContent: 'เนื้อหาที่อ่านได้',
      previewEmpty:
        'เลือกไฟล์ TXT, Markdown, PDF, DOCX, PPTX, XLSX, CSV หรือ JSON เพื่ออ่านข้อมูลจริง',
      addRoot: 'เพิ่มขอบเขต',
      addRootBody: 'ระบุเส้นทางจริง จากนั้นอนุมัติเป้าหมายใน Permission Center',
      rootName: 'ชื่อโฟลเดอร์',
      exactPath: 'เส้นทางเต็ม เช่น C:\\Users\\…\\Documents',
      reviewPermission: 'ตรวจสิทธิ์',
      rootApproved: 'อนุมัติโฟลเดอร์แล้ว',
      artifactManager: 'Artifact Manager',
      verifiedArtifacts: 'ผลงานที่ตรวจสอบแล้ว',
      noArtifacts: 'ยังไม่มีผลงานที่ระบบสร้างและตรวจสอบ',
      open: 'เปิด',
      reveal: 'แสดงในโฟลเดอร์',
      copyPath: 'คัดลอกเส้นทาง',
      share: 'แชร์',
      delete: 'ลบ',
      loadFailed: 'โหลดระบบไฟล์ไม่สำเร็จ',
      readFailed: 'อ่านเอกสารไม่สำเร็จ',
      actionFailed: 'ดำเนินการไม่สำเร็จ',
    } as const;
  }
  return {
    eyebrow: 'Verified file system',
    title: 'Files and artifacts',
    description: 'Find, read, and manage real artifacts inside approved file roots.',
    operational: 'Operational',
    loading: 'Loading',
    unavailable: 'Unavailable',
    unavailableBody: 'File Runtime is unavailable.',
    approvedRoots: 'Approved roots',
    browser: 'File browser',
    managed: 'Jupiter managed',
    search: 'Search files…',
    noFiles: 'No files were found in this scope.',
    safePreview: 'Document adapter',
    documentContent: 'Extracted content',
    previewEmpty:
      'Select a TXT, Markdown, PDF, DOCX, PPTX, XLSX, CSV, or JSON file to read real content.',
    addRoot: 'Add scope',
    addRootBody: 'Enter an exact path, then approve the target in Permission Center.',
    rootName: 'Folder name',
    exactPath: 'Exact path, for example C:\\Users\\…\\Documents',
    reviewPermission: 'Review permission',
    rootApproved: 'File root approved.',
    artifactManager: 'Artifact Manager',
    verifiedArtifacts: 'Verified artifacts',
    noArtifacts: 'No generated and verified artifacts exist yet.',
    open: 'Open',
    reveal: 'Reveal',
    copyPath: 'Copy path',
    share: 'Share',
    delete: 'Delete',
    loadFailed: 'The file system could not be loaded.',
    readFailed: 'The document could not be read.',
    actionFailed: 'The action failed.',
  } as const;
}
