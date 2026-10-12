import { sha256Hex } from '../sha256';
import type { AttachmentInfo, Snapshot } from '../types';
import type { AppFactory, AppUnderTest } from './harness';

export interface MemoryAppOptions {
  appId?: string;
  schemaVersion?: number;
  appVersion?: string;
}

interface MemoryData {
  entries: string[];
  /** Attachment key of an entry (its "cover"). */
  covers: Record<string, string>;
}

function parse(data: Snapshot): MemoryData {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  const parsed = JSON.parse(text) as Partial<MemoryData>;
  return { entries: parsed.entries ?? [], covers: parsed.covers ?? {} };
}

/**
 * A minimal app for the harness: its data is a list of entries, each with an
 * optional cover (an attachment); its snapshot is that data as JSON. It is
 * dirty while its data version differs from the version of the last snapshot
 * exported or imported.
 */
export function createMemoryApp({
  appId = 'memoryapp',
  schemaVersion = 1,
  appVersion = '1.0.0',
}: MemoryAppOptions = {}): AppFactory {
  return ({ deviceName }) => {
    let data: MemoryData = { entries: [], covers: {} };
    let version = 0;
    let synced: number | null = null;
    let pending: number | null = null;
    const backups: string[] = [];
    /** The device's attachment store. */
    const files = new Map<string, { bytes: Uint8Array; ext: string }>();

    const app: AppUnderTest & { backups: string[]; files: typeof files } = {
      backups,
      files,
      adapter: {
        appId,
        deviceName,
        appVersion,
        schemaVersion,
        async exportSnapshot() {
          pending = version;
          return JSON.stringify(data);
        },
        async importSnapshot(snapshot: Snapshot) {
          data = parse(snapshot);
          version++;
          pending = version;
        },
        isDirtySince: () => synced !== version,
        markSynced() {
          synced = pending;
        },
        beforeImport() {
          backups.push(JSON.stringify(data));
        },
        async saveConflictCopies({ local, remote }) {
          for (const copy of [local, remote]) {
            backups.push(typeof copy === 'string' ? copy : new TextDecoder().decode(copy));
          }
        },
        attachments: {
          listLocalAttachments: (): AttachmentInfo[] =>
            [...files.entries()].map(([key, f]) => ({ key, ext: f.ext, size: f.bytes.length })),
          async readAttachment(key) {
            const file = files.get(key);
            if (file === undefined) throw new Error(`no attachment ${key}`);
            return file.bytes;
          },
          async writeAttachment(key, bytes, ext) {
            files.set(key, { bytes, ext });
          },
          referencedKeys: (snapshot) => Object.values(parse(snapshot).covers),
        },
      },
      edit(label) {
        data = { ...data, entries: [...data.entries, label] };
        version++;
      },
      setAttachment(label, bytes, ext) {
        const key = sha256Hex(bytes);
        files.set(key, { bytes, ext });
        const entries = data.entries.includes(label) ? data.entries : [...data.entries, label];
        data = { entries, covers: { ...data.covers, [label]: key } };
        version++;
      },
      read: () => data,
    };
    return app;
  };
}
