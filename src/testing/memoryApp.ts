import type { Snapshot } from '../types';
import type { AppFactory, AppUnderTest } from './harness';

export interface MemoryAppOptions {
  appId?: string;
  schemaVersion?: number;
  appVersion?: string;
}

/**
 * A minimal app for the harness: its data is a list of entries, its snapshot
 * that list as JSON, and it is dirty while its data version differs from the
 * version of the last snapshot exported or imported.
 */
export function createMemoryApp({
  appId = 'memoryapp',
  schemaVersion = 1,
  appVersion = '1.0.0',
}: MemoryAppOptions = {}): AppFactory {
  return ({ deviceName }) => {
    let entries: string[] = [];
    let version = 0;
    let synced: number | null = null;
    let pending: number | null = null;
    const backups: string[] = [];

    const app: AppUnderTest & { backups: string[] } = {
      backups,
      adapter: {
        appId,
        deviceName,
        appVersion,
        schemaVersion,
        async exportSnapshot() {
          pending = version;
          return JSON.stringify({ entries });
        },
        async importSnapshot(data: Snapshot) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          entries = (JSON.parse(text) as { entries: string[] }).entries;
          version++;
          pending = version;
        },
        isDirtySince: () => synced !== version,
        markSynced() {
          synced = pending;
        },
        beforeImport() {
          backups.push(JSON.stringify({ entries }));
        },
        async saveConflictCopies({ local, remote }) {
          for (const copy of [local, remote]) {
            backups.push(typeof copy === 'string' ? copy : new TextDecoder().decode(copy));
          }
        },
      },
      edit(label) {
        entries = [...entries, label];
        version++;
      },
      read: () => entries,
    };
    return app;
  };
}
