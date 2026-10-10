import type { RemoteMeta } from './types';

export interface DecideInput {
  /** Current meta.json on Drive, or null if nothing was ever uploaded. */
  remote: RemoteMeta | null;
  /** Rev this device last uploaded or imported; null if it never synced. */
  baseRev: number | null;
  /**
   * Snapshot file of that rev. Two devices that race can both write the same
   * rev; the file id tells this device's upload from the other one. Null if
   * unknown (state saved before 0.2.0).
   */
  baseSnapshotId?: string | null;
  /** Local data changed since baseRev. */
  dirty: boolean;
  /** The app's data format version. */
  schemaVersion: number;
}

export type Decision =
  | { kind: 'noop' }
  /** Upload local data as `rev`; `expectedRemoteRev` must still be on Drive right before the write. */
  | { kind: 'upload'; rev: number; expectedRemoteRev: number | null }
  | { kind: 'import'; remote: RemoteMeta }
  | { kind: 'conflict'; remote: RemoteMeta }
  | { kind: 'needsAppUpdate'; remote: RemoteMeta };

/**
 * The whole sync policy, pure. One device is active at a time; the remote
 * rev tells whether another device wrote since this one last synced.
 */
export function decide({ remote, baseRev, baseSnapshotId = null, dirty, schemaVersion }: DecideInput): Decision {
  if (remote === null) {
    // Nothing on Drive (first device, or the app folder was cleared): publish.
    return { kind: 'upload', rev: (baseRev ?? 0) + 1, expectedRemoteRev: null };
  }
  if (remote.schemaVersion > schemaVersion) return { kind: 'needsAppUpdate', remote };
  if (remote.rev === baseRev && baseSnapshotId !== null && remote.snapshotFileId !== baseSnapshotId) {
    // Same rev, other snapshot: another device overwrote this device's upload
    // (upload race). This device's data is not on Drive any more.
    return { kind: 'conflict', remote };
  }
  if (remote.rev === baseRev) {
    return dirty ? { kind: 'upload', rev: remote.rev + 1, expectedRemoteRev: remote.rev } : { kind: 'noop' };
  }
  // Another device wrote since our base (or this device never synced).
  return dirty ? { kind: 'conflict', remote } : { kind: 'import', remote };
}
