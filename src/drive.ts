import type { RemoteMeta, Snapshot, SnapshotEncoding } from './types';

export interface DriveFile {
  id: string;
  name: string;
  /** Size in bytes, when the listing reports it. */
  size?: number;
}

/**
 * The few Drive operations sync needs, on the app folder only. The REST
 * implementation is below; tests use FakeDrive (src/testing).
 */
export interface DriveStore {
  /** Most recently modified file with this exact name, or null. */
  findFile(name: string): Promise<DriveFile | null>;
  /** Every file whose name starts with `prefix`. */
  listFiles(prefix: string): Promise<DriveFile[]>;
  createFile(name: string, content: Snapshot): Promise<DriveFile>;
  updateFile(id: string, content: Snapshot): Promise<void>;
  readFile(id: string, encoding: SnapshotEncoding): Promise<Snapshot>;
  /** Deleting a file that is already gone is not an error. */
  deleteFile(id: string): Promise<void>;
}

export type DriveErrorKind = 'offline' | 'auth' | 'http';

export class DriveError extends Error {
  readonly kind: DriveErrorKind;
  readonly status: number | null;

  constructor(kind: DriveErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'DriveError';
    this.kind = kind;
    this.status = status;
  }
}

export function isOfflineError(error: unknown): boolean {
  return error instanceof DriveError && error.kind === 'offline';
}

// ---------------------------------------------------------------- file names

export function metaFileName(appId: string): string {
  return `${appId}.meta.json`;
}

export function snapshotPrefix(appId: string): string {
  return `${appId}.snapshot-`;
}

export function snapshotFileName(appId: string, rev: number): string {
  return `${snapshotPrefix(appId)}${rev}.json`;
}

/** The rev in a snapshot file name, or null if the name is not one. */
export function snapshotRev(appId: string, name: string): number | null {
  const prefix = snapshotPrefix(appId);
  if (!name.startsWith(prefix) || !name.endsWith('.json')) return null;
  const rev = Number(name.slice(prefix.length, -'.json'.length));
  return Number.isInteger(rev) && rev > 0 ? rev : null;
}

export function attachmentPrefix(appId: string): string {
  return `${appId}.att.`;
}

const KEY = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,10}$/;

export function isAttachmentKey(key: string): boolean {
  return KEY.test(key);
}

/** A safe extension for a Drive name: lowercase alphanumerics, 'bin' otherwise. */
export function attachmentExt(ext: string): string {
  const clean = ext.replace(/^\./, '').toLowerCase();
  return EXT.test(clean) ? clean : 'bin';
}

/** `<appId>.att.<sha256>.<ext>` */
export function attachmentFileName(appId: string, key: string, ext: string): string {
  return `${attachmentPrefix(appId)}${key}.${attachmentExt(ext)}`;
}

/** Key and extension of an attachment file name of `appId`, or null if the name is not one. */
export function parseAttachmentName(appId: string, name: string): { key: string; ext: string } | null {
  const prefix = attachmentPrefix(appId);
  if (!name.startsWith(prefix)) return null;
  const [key, ext, ...rest] = name.slice(prefix.length).split('.');
  if (key === undefined || ext === undefined || rest.length > 0 || !KEY.test(key) || !EXT.test(ext)) return null;
  return { key, ext };
}

// ---------------------------------------------------------------- meta

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses meta.json; throws DriveError('http') if it is not a valid meta for `appId`. */
export function parseMeta(text: string, appId: string): RemoteMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DriveError('http', 'meta.json is not JSON');
  }
  if (
    !isRecord(parsed) ||
    parsed.format !== 'drive-sync-meta' ||
    parsed.appId !== appId ||
    typeof parsed.rev !== 'number' ||
    !Number.isInteger(parsed.rev) ||
    parsed.rev < 1 ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.deviceName !== 'string' ||
    typeof parsed.savedAt !== 'string' ||
    typeof parsed.appVersion !== 'string' ||
    typeof parsed.schemaVersion !== 'number' ||
    typeof parsed.snapshotFileId !== 'string' ||
    (parsed.encoding !== 'text' && parsed.encoding !== 'binary')
  ) {
    throw new DriveError('http', 'meta.json has an unexpected shape');
  }
  return {
    format: 'drive-sync-meta',
    appId,
    rev: parsed.rev,
    deviceId: parsed.deviceId,
    deviceName: parsed.deviceName,
    savedAt: parsed.savedAt,
    appVersion: parsed.appVersion,
    schemaVersion: parsed.schemaVersion,
    snapshotFileId: parsed.snapshotFileId,
    encoding: parsed.encoding,
  };
}

// ---------------------------------------------------------------- REST

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export interface TokenSource {
  getAccessToken(): Promise<string>;
  /** Drops a token Drive rejected, so the next getAccessToken() fetches a fresh one. */
  invalidateToken(token: string): Promise<void>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function quoteQuery(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function contentType(content: Snapshot): string {
  return typeof content === 'string' ? 'application/json; charset=utf-8' : 'application/octet-stream';
}

/**
 * Drive v3 over fetch, scope drive.appdata: every file lives in the hidden
 * appDataFolder of the user's own Drive.
 */
export function createRestDrive(tokens: TokenSource, fetchFn: Fetch = fetch): DriveStore {
  async function request(url: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
    const token = await tokens.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetchFn(url, { ...init, headers });
    } catch (error) {
      throw new DriveError('offline', error instanceof Error ? error.message : 'Network request failed');
    }
    if (response.status === 401 && retryAuth) {
      await tokens.invalidateToken(token);
      return request(url, init, false);
    }
    if (response.status === 401 || response.status === 403) {
      throw new DriveError('auth', `Drive refused access (${response.status})`, response.status);
    }
    return response;
  }

  async function ok(response: Response, what: string): Promise<Response> {
    if (response.ok) return response;
    const body = await response.text().catch(() => '');
    throw new DriveError('http', `${what} failed (${response.status}) ${body.slice(0, 200)}`, response.status);
  }

  async function list(q: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | null = null;
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q: `${q} and trashed = false`,
        orderBy: 'modifiedTime desc',
        fields: 'nextPageToken, files(id, name, size)',
        pageSize: '100',
      });
      if (pageToken !== null) params.set('pageToken', pageToken);
      const response = await ok(await request(`${API}/files?${params.toString()}`), 'List files');
      const body = (await response.json()) as {
        files?: { id: string; name: string; size?: string }[];
        nextPageToken?: string;
      };
      for (const { id, name, size } of body.files ?? []) {
        files.push(size === undefined ? { id, name } : { id, name, size: Number(size) });
      }
      pageToken = body.nextPageToken ?? null;
    } while (pageToken !== null);
    return files;
  }

  async function upload(id: string, content: Snapshot): Promise<void> {
    await ok(
      await request(`${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': contentType(content) },
        body: typeof content === 'string' ? content : new Uint8Array(content),
      }),
      'Upload',
    );
  }

  async function deleteFile(id: string): Promise<void> {
    const response = await request(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (response.status === 404) return;
    await ok(response, 'Delete');
  }

  return {
    async findFile(name) {
      const files = await list(`name = ${quoteQuery(name)}`);
      return files[0] ?? null;
    },

    async listFiles(prefix) {
      // `name contains` matches word prefixes; filter exactly here.
      const files = await list(`name contains ${quoteQuery(prefix)}`);
      return files.filter((f) => f.name.startsWith(prefix));
    },

    async createFile(name, content) {
      const response = await ok(
        await request(`${API}/files?fields=id,name`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ name, parents: ['appDataFolder'] }),
        }),
        'Create file',
      );
      const file = (await response.json()) as DriveFile;
      try {
        await upload(file.id, content);
      } catch (error) {
        // Do not leave an empty file behind.
        await deleteFile(file.id).catch(() => undefined);
        throw error;
      }
      return file;
    },

    updateFile: upload,

    async readFile(id, encoding) {
      const response = await ok(
        await request(`${API}/files/${encodeURIComponent(id)}?alt=media`),
        'Download',
      );
      return encoding === 'text' ? response.text() : new Uint8Array(await response.arrayBuffer());
    },

    deleteFile,
  };
}
