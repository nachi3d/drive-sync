import { decide } from '../decide';
import type { RemoteMeta } from '../types';

function meta(rev: number, schemaVersion = 3): RemoteMeta {
  return {
    format: 'drive-sync-meta',
    appId: 'testapp',
    rev,
    deviceId: 'other',
    deviceName: 'Other phone',
    savedAt: '2026-10-08T10:00:00.000Z',
    appVersion: '1.0.0',
    schemaVersion,
    snapshotFileId: `snap-${rev}`,
    encoding: 'text',
  };
}

describe('decide', () => {
  it('uploads rev 1 when Drive is empty and this device never synced', () => {
    expect(decide({ remote: null, baseRev: null, dirty: false, schemaVersion: 3 })).toEqual({
      kind: 'upload',
      rev: 1,
      expectedRemoteRev: null,
    });
  });

  it('re-uploads after the base when the Drive folder was cleared', () => {
    expect(decide({ remote: null, baseRev: 7, dirty: false, schemaVersion: 3 })).toEqual({
      kind: 'upload',
      rev: 8,
      expectedRemoteRev: null,
    });
  });

  it('does nothing when remote == base and local is clean', () => {
    expect(decide({ remote: meta(4), baseRev: 4, dirty: false, schemaVersion: 3 })).toEqual({ kind: 'noop' });
  });

  it('uploads base+1 when local is dirty and remote == base', () => {
    expect(decide({ remote: meta(4), baseRev: 4, dirty: true, schemaVersion: 3 })).toEqual({
      kind: 'upload',
      rev: 5,
      expectedRemoteRev: 4,
    });
  });

  it('imports when remote is newer and local is clean', () => {
    const remote = meta(5);
    expect(decide({ remote, baseRev: 4, dirty: false, schemaVersion: 3 })).toEqual({ kind: 'import', remote });
  });

  it('imports on a device that never synced and has no local change', () => {
    const remote = meta(5);
    expect(decide({ remote, baseRev: null, dirty: false, schemaVersion: 3 })).toEqual({ kind: 'import', remote });
  });

  it('reports a conflict when remote is newer and local is dirty', () => {
    const remote = meta(5);
    expect(decide({ remote, baseRev: 4, dirty: true, schemaVersion: 3 })).toEqual({ kind: 'conflict', remote });
  });

  it('reports a conflict on a device with its own data that never synced', () => {
    const remote = meta(2);
    expect(decide({ remote, baseRev: null, dirty: true, schemaVersion: 3 })).toEqual({ kind: 'conflict', remote });
  });

  it('refuses a remote snapshot from a newer schema, dirty or not', () => {
    const remote = meta(5, 4);
    for (const dirty of [true, false]) {
      expect(decide({ remote, baseRev: 4, dirty, schemaVersion: 3 })).toEqual({ kind: 'needsAppUpdate', remote });
    }
  });

  it('accepts a remote snapshot from an older schema', () => {
    const remote = meta(5, 2);
    expect(decide({ remote, baseRev: 4, dirty: false, schemaVersion: 3 })).toEqual({ kind: 'import', remote });
  });

  it('reports a conflict when the same rev points to another snapshot (raced upload overwritten)', () => {
    const remote = meta(4);
    for (const dirty of [true, false]) {
      expect(decide({ remote, baseRev: 4, baseSnapshotId: 'mine-4', dirty, schemaVersion: 3 })).toEqual({
        kind: 'conflict',
        remote,
      });
    }
  });

  it('trusts the rev alone when the base snapshot is unknown (state from 0.1.x)', () => {
    expect(decide({ remote: meta(4), baseRev: 4, baseSnapshotId: null, dirty: false, schemaVersion: 3 })).toEqual({
      kind: 'noop',
    });
  });

  it('does nothing when rev and snapshot both match', () => {
    expect(decide({ remote: meta(4), baseRev: 4, baseSnapshotId: 'snap-4', dirty: false, schemaVersion: 3 })).toEqual({
      kind: 'noop',
    });
  });
});
