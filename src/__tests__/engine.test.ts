import { createSyncEngine, type DriveSync, type Timers } from '../engine';
import { DriveError, metaFileName, parseMeta, snapshotFileName } from '../drive';
import { createMemoryStorage, FakeAuth, FakeDrive } from '../testing';
import type {
  ConflictChoice,
  ConflictCopies,
  ConflictInfo,
  KeyValueStorage,
  RemoteMeta,
  SyncAdapter,
} from '../types';

const APP = 'testapp';

function manualTimers(): Timers & { pending(): number; fire(): void } {
  const handles = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout(fn) {
      const id = next++;
      handles.set(id, fn);
      return id;
    },
    clearTimeout(handle) {
      handles.delete(handle as number);
    },
    pending: () => handles.size,
    fire() {
      const fns = [...handles.values()];
      handles.clear();
      for (const fn of fns) fn();
    },
  };
}

interface Device {
  name: string;
  app: { data: string; synced: string | null; exported: string | null };
  adapter: SyncAdapter;
  auth: FakeAuth;
  storage: KeyValueStorage & { data: Map<string, string> };
  timers: ReturnType<typeof manualTimers>;
  sync: DriveSync;
  imports: RemoteMeta[];
  safetyBackups: RemoteMeta[];
  conflictCopies: ConflictCopies[];
  conflicts: ConflictInfo[];
  /** What the conflict handler answers next. */
  answer: ConflictChoice | null;
  write(data: string): void;
}

function makeDevice(
  drive: FakeDrive,
  name: string,
  { schemaVersion = 3, storage = createMemoryStorage(), withHandler = true } = {},
): Device {
  const device = {} as Device;
  const app = { data: `${name}-initial`, synced: null as string | null, exported: null as string | null };
  const adapter: SyncAdapter = {
    appId: APP,
    deviceName: name,
    appVersion: '1.0.0',
    schemaVersion,
    async exportSnapshot() {
      app.exported = app.data;
      return app.data;
    },
    async importSnapshot(data, meta) {
      if (typeof data !== 'string') throw new Error('expected text');
      device.imports.push(meta);
      app.data = data;
      app.exported = data;
    },
    isDirtySince: () => app.data !== app.synced,
    markSynced: () => {
      app.synced = app.exported;
    },
    beforeImport: (meta) => {
      device.safetyBackups.push(meta);
    },
    saveConflictCopies: async (copies) => {
      device.conflictCopies.push(copies);
    },
  };
  const auth = new FakeAuth();
  const timers = manualTimers();
  const sync = createSyncEngine({
    adapter,
    auth,
    drive,
    storage,
    timers,
    now: () => '2026-10-08T10:00:00.000Z',
    newDeviceId: () => `id-${name}`,
    onConflict: withHandler
      ? async (info) => {
          device.conflicts.push(info);
          return device.answer;
        }
      : undefined,
  });
  Object.assign(device, {
    name,
    app,
    adapter,
    auth,
    storage,
    timers,
    sync,
    imports: [],
    safetyBackups: [],
    conflictCopies: [],
    conflicts: [],
    answer: null,
    write(data: string) {
      app.data = data;
    },
  });
  return device;
}

function remoteMeta(drive: FakeDrive): RemoteMeta | null {
  const text = drive.text(metaFileName(APP));
  return text === null ? null : parseMeta(text, APP);
}

function remoteData(drive: FakeDrive): string | null {
  const meta = remoteMeta(drive);
  if (meta === null) return null;
  const file = drive.files.get(meta.snapshotFileId);
  return file && typeof file.content === 'string' ? file.content : null;
}

/** Lets queued microtasks and chained promises (conflict handler, resolve) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
}

async function connected(drive: FakeDrive, name: string, options?: Parameters<typeof makeDevice>[2]) {
  const device = makeDevice(drive, name, options);
  await device.sync.connect({ sync: false });
  return device;
}

describe('connect and first upload', () => {
  it('uploads rev 1 with meta and the snapshot in the app folder', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');

    expect(await a.sync.syncNow()).toBe('uploaded');

    expect(drive.names()).toEqual([metaFileName(APP), snapshotFileName(APP, 1)]);
    expect(remoteMeta(drive)).toMatchObject({
      rev: 1,
      deviceId: 'id-Phone A',
      deviceName: 'Phone A',
      appVersion: '1.0.0',
      schemaVersion: 3,
      encoding: 'text',
    });
    expect(remoteData(drive)).toBe('Phone A-initial');
    expect(a.sync.status()).toMatchObject({
      phase: 'idle',
      account: 'reader@example.com',
      lastSyncedAt: '2026-10-08T10:00:00.000Z',
      lastSyncedFrom: 'Phone A',
    });
  });

  it('syncs right after connect unless told not to', async () => {
    const drive = new FakeDrive();
    const a = makeDevice(drive, 'Phone A');
    expect(await a.sync.connect()).toBe(true);
    await settle();
    expect(remoteMeta(drive)?.rev).toBe(1);
  });

  it('stays disconnected when the user cancels sign-in', async () => {
    const drive = new FakeDrive();
    const a = makeDevice(drive, 'Phone A');
    a.auth.email = null;
    expect(await a.sync.connect()).toBe(false);
    expect(a.sync.status().phase).toBe('disconnected');
    expect(await a.sync.syncNow()).toBe('disconnected');
    expect(drive.calls).toEqual([]);
  });

  it('does nothing before connect', async () => {
    const drive = new FakeDrive();
    const a = makeDevice(drive, 'Phone A');
    expect(await a.sync.syncNow()).toBe('disconnected');
    expect(drive.calls).toEqual([]);
  });
});

describe('transitions', () => {
  it('remote == base and local clean → nothing written', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    await a.sync.syncNow();
    drive.calls = [];

    expect(await a.sync.syncNow()).toBe('unchanged');
    expect(drive.calls.filter((c) => !c.startsWith('find:') && !c.startsWith('read:'))).toEqual([]);
  });

  it('local dirty and remote == base → uploads base+1', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    await a.sync.syncNow();

    a.write('v2');
    expect(await a.sync.syncNow()).toBe('uploaded');
    expect(remoteMeta(drive)?.rev).toBe(2);
    expect(remoteData(drive)).toBe('v2');
    expect(a.adapter.isDirtySince(2)).toBe(false);
  });

  it('remote newer and local clean → imports, after a safety backup', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    const b = await connected(drive, 'Phone B');
    await a.sync.syncNow();
    await b.sync.restoreFromDrive();

    a.write('from A');
    await a.sync.syncNow();

    expect(await b.sync.syncNow()).toBe('imported');
    expect(b.app.data).toBe('from A');
    expect(b.safetyBackups.map((m) => m.rev)).toEqual([1, 2]);
    expect(b.sync.status()).toMatchObject({ phase: 'idle', lastSyncedFrom: 'Phone A' });
    expect(await b.sync.syncNow()).toBe('unchanged');
  });

  it('remote newer schema → refuses, imports nothing, uploads nothing', async () => {
    const drive = new FakeDrive();
    const newer = await connected(drive, 'New app', { schemaVersion: 4 });
    await newer.sync.syncNow();
    const old = await connected(drive, 'Old app', { schemaVersion: 3 });
    old.write('local change');

    expect(await old.sync.syncNow()).toBe('needsAppUpdate');
    expect(old.sync.status()).toMatchObject({ phase: 'needsAppUpdate', remote: { schemaVersion: 4 } });
    expect(old.imports).toEqual([]);
    expect(remoteData(drive)).toBe('New app-initial');

    expect(await old.sync.restoreFromDrive()).toMatchObject({ kind: 'needsAppUpdate' });
    expect(old.imports).toEqual([]);
  });

  it('re-uploads when the app folder was cleared', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    await a.sync.syncNow();
    drive.files.clear();

    expect(await a.sync.syncNow()).toBe('uploaded');
    expect(remoteMeta(drive)?.rev).toBe(2);
  });
});

describe('handoff A → B', () => {
  it('new phone restores, works, then the old phone picks the changes up', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    a.write('library v1');
    await a.sync.syncNow();

    // New phone: restore from Drive on the first screen.
    const b = makeDevice(drive, 'Phone B');
    await b.sync.connect({ sync: false });
    expect(await b.sync.peekRemote()).toMatchObject({ kind: 'found', meta: { rev: 1, deviceName: 'Phone A' } });
    expect(await b.sync.restoreFromDrive()).toMatchObject({ kind: 'restored', meta: { rev: 1 } });
    expect(b.app.data).toBe('library v1');

    b.write('library v2');
    expect(await b.sync.syncNow()).toBe('uploaded');
    expect(remoteMeta(drive)).toMatchObject({ rev: 2, deviceName: 'Phone B' });

    expect(await a.sync.syncNow()).toBe('imported');
    expect(a.app.data).toBe('library v2');
    expect(a.sync.status().lastSyncedFrom).toBe('Phone B');
  });

  it('restoreFromDrive reports nothing when Drive is empty', async () => {
    const drive = new FakeDrive();
    const b = await connected(drive, 'Phone B');
    expect(await b.sync.restoreFromDrive()).toEqual({ kind: 'nothing' });
    expect(await b.sync.peekRemote()).toEqual({ kind: 'nothing' });
  });
});

describe('conflicts', () => {
  async function diverged() {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    const b = await connected(drive, 'Phone B');
    await a.sync.syncNow();
    await b.sync.restoreFromDrive();
    a.write('A edit');
    await a.sync.syncNow();
    b.write('B edit');
    return { drive, a, b };
  }

  it('remote newer and local dirty → asks, never silent', async () => {
    const { drive, b } = await diverged();

    expect(await b.sync.syncNow()).toBe('conflict');
    await settle();

    expect(b.conflicts).toEqual([
      { remote: expect.objectContaining({ rev: 2, deviceName: 'Phone A' }), localDeviceName: 'Phone B' },
    ]);
    expect(b.sync.status().phase).toBe('conflict');
    expect(b.app.data).toBe('B edit');
    expect(remoteData(drive)).toBe('A edit');
  });

  it('keepLocal uploads over the remote', async () => {
    const { drive, b } = await diverged();
    b.answer = 'keepLocal';
    await b.sync.syncNow();
    await settle();

    expect(remoteMeta(drive)).toMatchObject({ rev: 3, deviceName: 'Phone B' });
    expect(remoteData(drive)).toBe('B edit');
    expect(b.sync.status().phase).toBe('idle');
  });

  it('keepRemote imports the remote, after a safety backup', async () => {
    const { b } = await diverged();
    b.answer = 'keepRemote';
    await b.sync.syncNow();
    await settle();

    expect(b.app.data).toBe('A edit');
    expect(b.safetyBackups.at(-1)?.rev).toBe(2);
    expect(b.sync.status()).toMatchObject({ phase: 'idle', lastSyncedFrom: 'Phone A' });
  });

  it('exportBoth keeps both copies and stays in conflict', async () => {
    const { drive, b } = await diverged();
    b.answer = 'exportBoth';
    await b.sync.syncNow();
    await settle();

    expect(b.conflictCopies).toEqual([
      { local: 'B edit', remote: 'A edit', remoteMeta: expect.objectContaining({ rev: 2 }) },
    ]);
    expect(b.sync.status().phase).toBe('conflict');
    expect(b.app.data).toBe('B edit');
    expect(remoteMeta(drive)?.rev).toBe(2);

    // The user then picks a side.
    expect(await b.sync.resolveConflict('keepLocal')).toBe('uploaded');
    expect(remoteData(drive)).toBe('B edit');
  });

  it('postponing (null) changes nothing; a later handler is asked', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    const b = makeDevice(drive, 'Phone B', { withHandler: false });
    await b.sync.connect({ sync: false });
    await a.sync.syncNow();
    b.write('B data');

    expect(await b.sync.syncNow()).toBe('conflict');
    await settle();
    expect(remoteData(drive)).toBe('Phone A-initial');

    const asked: ConflictInfo[] = [];
    b.sync.setConflictHandler(async (info) => {
      asked.push(info);
      return null;
    });
    await settle();
    expect(asked).toHaveLength(1);
    expect(b.sync.status().phase).toBe('conflict');
    expect(remoteData(drive)).toBe('Phone A-initial');
    expect(b.app.data).toBe('B data');
  });

  it('re-runs the decision if Drive moved again before the choice was applied', async () => {
    const { a, b } = await diverged();
    expect(await b.sync.syncNow()).toBe('conflict');
    await settle();

    a.write('A again');
    await a.sync.syncNow();

    // Still dirty, remote moved from 2 to 3: a fresh conflict about rev 3.
    expect(await b.sync.resolveConflict('keepLocal')).toBe('conflict');
    expect(b.sync.status().remote?.rev).toBe(3);
  });
});

describe('upload race', () => {
  it('treats a meta change between snapshot upload and meta write as a conflict', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    const b = await connected(drive, 'Phone B');
    await a.sync.syncNow();
    await b.sync.restoreFromDrive();
    a.write('A edit');

    // B uploads rev 2 while A is uploading its snapshot.
    drive.beforeCall = async (op) => {
      if (op === `create:${snapshotFileName(APP, 2)}` && drive.beforeCall) {
        drive.beforeCall = null;
        b.write('B edit');
        await b.sync.syncNow();
      }
    };

    expect(await a.sync.syncNow()).toBe('conflict');
    expect(remoteMeta(drive)).toMatchObject({ rev: 2, deviceName: 'Phone B' });
    expect(remoteData(drive)).toBe('B edit');
    // A's orphan snapshot was removed; only B's rev 2 remains.
    expect(drive.names().filter((n) => n === snapshotFileName(APP, 2))).toHaveLength(1);
    expect(a.sync.status()).toMatchObject({ phase: 'conflict', remote: { deviceName: 'Phone B' } });
  });
});

describe('rotation', () => {
  it('keeps the newest 5 snapshots', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    for (let i = 1; i <= 7; i++) {
      a.write(`v${i}`);
      await a.sync.syncNow();
    }
    expect(drive.names()).toEqual(
      [metaFileName(APP), ...[3, 4, 5, 6, 7].map((rev) => snapshotFileName(APP, rev))].sort(),
    );
    expect(remoteData(drive)).toBe('v7');
  });

  it('a rotation failure does not fail the sync', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    drive.beforeCall = (op) => {
      if (op.startsWith('list:')) throw new Error('list failed');
    };
    expect(await a.sync.syncNow()).toBe('uploaded');
  });
});

describe('offline', () => {
  it('queues silently and uploads when the network is back', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    await a.sync.syncNow();
    a.write('offline edit');
    drive.offline = true;

    expect(await a.sync.syncNow()).toBe('offline');
    expect(a.sync.status()).toMatchObject({ phase: 'offline', error: null });

    drive.offline = false;
    expect(await a.sync.syncNow()).toBe('uploaded');
    expect(remoteData(drive)).toBe('offline edit');
  });

  it('peek and restore report offline instead of failing', async () => {
    const drive = new FakeDrive();
    const b = await connected(drive, 'Phone B');
    drive.offline = true;
    expect(await b.sync.peekRemote()).toEqual({ kind: 'offline' });
    expect(await b.sync.restoreFromDrive()).toEqual({ kind: 'offline' });
  });
});

describe('errors', () => {
  it('an import failure keeps the old base and reports an app error', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    const b = await connected(drive, 'Phone B');
    await a.sync.syncNow();
    b.app.synced = b.app.data; // B has nothing new
    b.adapter.importSnapshot = async () => {
      throw new Error('bad snapshot');
    };

    expect(await b.sync.syncNow()).toBe('error');
    expect(b.sync.status()).toMatchObject({ phase: 'error', error: { code: 'app', message: 'bad snapshot' } });
  });

  it('a Drive auth failure is an auth error', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    a.auth.signedIn = null;
    drive.beforeCall = () => {
      throw new DriveError('auth', 'revoked');
    };
    expect(await a.sync.syncNow()).toBe('error');
    expect(a.sync.status().error?.code).toBe('auth');
  });
});

describe('triggers', () => {
  it('debounces changes into one sync', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    await a.sync.syncNow();

    a.write('x');
    a.sync.notifyChange();
    a.sync.notifyChange();
    a.sync.notifyChange();
    expect(a.timers.pending()).toBe(1);
    a.timers.fire();
    await settle();
    expect(remoteMeta(drive)?.rev).toBe(2);
  });

  it('flush cancels the debounce and syncs now', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    a.sync.notifyChange();
    expect(await a.sync.flush()).toBe('uploaded');
    expect(a.timers.pending()).toBe(0);
  });

  it('ignores changes while disconnected', async () => {
    const drive = new FakeDrive();
    const a = makeDevice(drive, 'Phone A');
    await a.sync.start();
    a.sync.notifyChange();
    expect(a.timers.pending()).toBe(0);
  });

  it('concurrent syncNow calls share one run', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    const first = a.sync.syncNow();
    const second = a.sync.syncNow();
    const third = a.sync.syncNow();
    expect(await Promise.all([first, second, third])).toEqual(['uploaded', 'uploaded', 'uploaded']);
    expect(drive.names().filter((n) => n.includes('snapshot'))).toHaveLength(1);
  });
});

describe('connection lifecycle', () => {
  it('start() restores the session and syncs', async () => {
    const drive = new FakeDrive();
    const storage = createMemoryStorage();
    const first = await connected(drive, 'Phone A', { storage });
    await first.sync.syncNow();

    // App restart: same storage, new engine.
    const again = makeDevice(drive, 'Phone A', { storage });
    again.auth.signedIn = { email: 'reader@example.com' };
    again.app.synced = again.app.data;
    again.app.data = 'edited before restart';
    await again.sync.start();

    expect(again.auth.calls).toContain('restore');
    expect(remoteMeta(drive)?.rev).toBe(2);
    expect(remoteData(drive)).toBe('edited before restart');
  });

  it('start() without a saved Google session asks to reconnect', async () => {
    const drive = new FakeDrive();
    const storage = createMemoryStorage();
    await connected(drive, 'Phone A', { storage });
    const again = makeDevice(drive, 'Phone A', { storage });
    await again.sync.start();
    expect(again.sync.status()).toMatchObject({ phase: 'error', error: { code: 'auth' } });
  });

  it('disconnect signs out, stops syncing and keeps Drive data', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    await a.sync.syncNow();
    await a.sync.disconnect();

    expect(a.auth.calls).toContain('signOut');
    expect(a.sync.status()).toMatchObject({ phase: 'disconnected', account: null });
    a.write('later');
    expect(await a.sync.syncNow()).toBe('disconnected');
    expect(remoteMeta(drive)?.rev).toBe(1);
  });

  it('reconnecting the same account keeps the base (no false conflict)', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    await a.sync.syncNow();
    await a.sync.disconnect();
    await a.sync.connect({ sync: false });
    expect(await a.sync.syncNow()).toBe('unchanged');
  });

  it('another account forgets the base', async () => {
    const drive = new FakeDrive();
    const a = await connected(drive, 'Phone A');
    await a.sync.syncNow();
    await a.sync.disconnect();
    a.auth.email = 'other@example.com';
    await a.sync.connect({ sync: false });
    expect(a.sync.status()).toMatchObject({ account: 'other@example.com', lastSyncedAt: null });
  });

  it('keeps the device id across restarts', async () => {
    const drive = new FakeDrive();
    const storage = createMemoryStorage();
    const a = await connected(drive, 'Phone A', { storage });
    await a.sync.syncNow();
    const saved = JSON.parse(storage.data.get(`drive-sync:${APP}`) ?? '{}') as { deviceId?: string };
    expect(saved.deviceId).toBe('id-Phone A');
  });

  it('notifies subscribers on every status change', async () => {
    const drive = new FakeDrive();
    const a = makeDevice(drive, 'Phone A');
    const phases: string[] = [];
    a.sync.subscribe(() => phases.push(a.sync.status().phase));
    await a.sync.connect({ sync: false });
    await a.sync.syncNow();
    expect(phases).toEqual(expect.arrayContaining(['idle', 'syncing']));
    expect(phases.at(-1)).toBe('idle');
  });
});
