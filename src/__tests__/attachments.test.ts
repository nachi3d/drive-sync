import { ATTACHMENT_RETRY_DELAYS_MS, createAttachmentSync, type AttachmentSyncOptions } from '../attachments';
import {
  attachmentExt,
  attachmentFileName,
  createRestDrive,
  DriveError,
  parseAttachmentName,
  type DriveFile,
} from '../drive';
import { sha256Hex } from '../sha256';
import { createMemoryApp, createMemoryStorage, createSyncWorld, FakeDrive, testBytes, VirtualClock } from '../testing';
import type { AttachmentAdapter, AttachmentInfo, Snapshot } from '../types';

/** Reference: WebCrypto (Node's). */
async function nodeSha(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('sha256Hex', () => {
  it.each([0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000])('matches WebCrypto for %i bytes', async (size) => {
    const bytes = testBytes(`size ${size}`, size);
    expect(sha256Hex(bytes)).toBe(await nodeSha(bytes));
  });

  it('hashes a string as UTF-8, and a view into a larger buffer', async () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('é')).toBe(await nodeSha(new TextEncoder().encode('é')));
    const big = testBytes('buffer', 300);
    const view = big.subarray(7, 207);
    expect(sha256Hex(view)).toBe(await nodeSha(view));
  });
});

describe('attachment file names', () => {
  const key = sha256Hex('cover');

  it('round-trips <appId>.att.<sha256>.<ext>', () => {
    expect(attachmentFileName('booktrack', key, 'JPG')).toBe(`booktrack.att.${key}.jpg`);
    expect(parseAttachmentName('booktrack', `booktrack.att.${key}.jpg`)).toEqual({ key, ext: 'jpg' });
  });

  it('cleans the extension', () => {
    expect(attachmentExt('.png')).toBe('png');
    expect(attachmentExt('')).toBe('bin');
    expect(attachmentExt('j/p g')).toBe('bin');
  });

  it("never parses another appId's files or other files", () => {
    expect(parseAttachmentName('foo', `foo.att.att.${key}.jpg`)).toBeNull(); // app "foo.att"
    expect(parseAttachmentName('foo', 'foo.att.meta.json')).toBeNull();
    expect(parseAttachmentName('foo', `foo.att.${key}`)).toBeNull();
    expect(parseAttachmentName('foo', `foo.att.${key.toUpperCase()}.jpg`)).toBeNull();
    expect(parseAttachmentName('foo', `foobar.att.${key}.jpg`)).toBeNull();
  });
});

describe('createRestDrive listing', () => {
  it('asks for sizes and returns them as numbers', async () => {
    const urls: string[] = [];
    const drive = createRestDrive(
      { getAccessToken: async () => 't', invalidateToken: async () => undefined },
      async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ files: [{ id: 'a1', name: 'app.att.x.jpg', size: '2048' }, { id: 'a2', name: 'app.att.y' }] }));
      },
    );
    expect(await drive.listFiles('app.att.')).toEqual([
      { id: 'a1', name: 'app.att.x.jpg', size: 2048 },
      { id: 'a2', name: 'app.att.y' },
    ]);
    expect(new URL(urls[0] ?? '').searchParams.get('fields')).toBe('nextPageToken, files(id, name, size)');
  });
});

// ---------------------------------------------------------------- module

interface Rig {
  drive: FakeDrive;
  clock: VirtualClock;
  local: Map<string, Uint8Array>;
  sync: ReturnType<typeof createAttachmentSync>;
  active: { value: boolean };
}

/** Snapshot = JSON list of keys. */
function rig(options: Partial<AttachmentSyncOptions> = {}): Rig {
  const drive = new FakeDrive();
  const clock = new VirtualClock();
  const local = new Map<string, Uint8Array>();
  const active = { value: true };
  const adapter: AttachmentAdapter = {
    listLocalAttachments: (): AttachmentInfo[] => [...local].map(([key, b]) => ({ key, ext: 'jpg', size: b.length })),
    readAttachment: async (key) => local.get(key) ?? new Uint8Array(),
    writeAttachment: async (key, bytes) => {
      local.set(key, bytes);
    },
    referencedKeys: (data: Snapshot) => JSON.parse(String(data)) as string[],
  };
  const sync = createAttachmentSync({
    adapter,
    appId: 'app',
    drive,
    storage: createMemoryStorage(),
    timers: clock,
    now: () => clock.now(),
    active: () => active.value,
    onStatus: () => undefined,
    ...options,
  });
  return { drive, clock, local, sync, active };
}

function putRemote(drive: FakeDrive, bytes: Uint8Array): { key: string; file: DriveFile } {
  const key = sha256Hex(bytes);
  return { key, file: drive.put(attachmentFileName('app', key, 'jpg'), bytes) };
}

/** Lets background passes finish (they only wait on microtasks here). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('download pass', () => {
  it('rejects a file whose bytes do not match its key, and retries later', async () => {
    const { drive, clock, local, sync } = rig();
    const bytes = testBytes('cover');
    const key = sha256Hex(bytes);
    const file = drive.put(attachmentFileName('app', key, 'jpg'), testBytes('corrupted'));
    await sync.afterImport(JSON.stringify([key]), 'snap1');
    expect(await sync.fetchMissing()).toBe('pending');
    expect(local.has(key)).toBe(false);
    expect(sync.status().missing).toBe(1);

    drive.files.get(file.id)!.content = bytes; // repaired on Drive
    clock.advance(ATTACHMENT_RETRY_DELAYS_MS[0] ?? 0);
    await flush();
    expect(local.get(key)).toEqual(bytes);
    expect(sync.status().missing).toBe(0);
  });

  it('stops when disconnected: no retry fires', async () => {
    const { drive, clock, local, sync, active } = rig();
    const { key } = putRemote(drive, testBytes('cover'));
    drive.failWhen = (op) => (op.startsWith('read:') ? new DriveError('http', '500', 500) : null);
    await sync.afterImport(JSON.stringify([key]), 'snap1');
    await sync.fetchMissing();
    drive.failWhen = null;
    active.value = false;
    sync.cancel();
    clock.advance(10 * 60_000);
    await flush();
    expect(local.has(key)).toBe(false);
    expect(await sync.fetchMissing()).toBe('disconnected');
  });

  it('skips files over maxBytes on Drive', async () => {
    const { drive, local, sync } = rig({ maxBytes: 100 });
    const { key } = putRemote(drive, testBytes('big', 101));
    await sync.afterImport(JSON.stringify([key]), 'snap1');
    expect(await sync.fetchMissing()).toBe('pending');
    expect(local.has(key)).toBe(false);
    expect(sync.status()).toMatchObject({ missing: 1, tooLarge: 1 });
    expect(drive.calls.some((op) => op.startsWith('read:'))).toBe(false);
  });

  it('downloads at most `concurrency` files at once', async () => {
    const { drive, sync } = rig({ concurrency: 3 });
    drive.latencyMs = 2;
    const keys = Array.from({ length: 8 }, (_, i) => putRemote(drive, testBytes(`c${i}`)).key);
    let peak = 0;
    drive.beforeCall = () => {
      peak = Math.max(peak, drive.inFlight);
    };
    await sync.afterImport(JSON.stringify(keys), 'snap1');
    expect(await sync.fetchMissing()).toBe('done');
    expect(peak).toBe(3);
  });

  it('needs isWifi for wifiOnlyDownloads', () => {
    expect(() => rig({ wifiOnlyDownloads: true })).toThrow(/isWifi/);
  });
});

describe('collectGarbage', () => {
  async function setup() {
    const r = rig();
    const keep = putRemote(r.drive, testBytes('kept'));
    const drop = putRemote(r.drive, testBytes('dropped'));
    const snapshot = r.drive.put('app.snapshot-1.json', JSON.stringify([keep.key]));
    return { ...r, keep, drop, snapshot };
  }

  it('deletes unreferenced attachments and duplicate copies', async () => {
    const { drive, sync, keep, drop, snapshot } = await setup();
    const copy = drive.createFile(attachmentFileName('app', keep.key, 'jpg'), testBytes('kept'));
    await sync.collectGarbage({ kept: [snapshot], encoding: 'text', stillCurrent: async () => true });
    const left = [...drive.files.keys()];
    expect(left).toContain(keep.file.id);
    expect(left).not.toContain(drop.file.id);
    expect(left).not.toContain((await copy).id);
  });

  it('deletes nothing if another device uploaded meanwhile', async () => {
    const { drive, sync, drop, snapshot } = await setup();
    await sync.collectGarbage({ kept: [snapshot], encoding: 'text', stillCurrent: async () => false });
    expect(drive.files.has(drop.file.id)).toBe(true);
  });

  it('deletes nothing if a kept snapshot cannot be read', async () => {
    const { drive, sync, drop, snapshot } = await setup();
    const gone: DriveFile = { id: 'missing', name: 'app.snapshot-2.json' };
    await expect(
      sync.collectGarbage({ kept: [snapshot, gone], encoding: 'text', stillCurrent: async () => true }),
    ).rejects.toThrow(DriveError);
    expect(drive.files.has(drop.file.id)).toBe(true);
  });

  it('runs at most once per gcIntervalMs', async () => {
    const { drive, clock, sync, snapshot } = await setup();
    await sync.collectGarbage({ kept: [snapshot], encoding: 'text', stillCurrent: async () => true });
    const late = putRemote(drive, testBytes('late orphan'));
    await sync.collectGarbage({ kept: [snapshot], encoding: 'text', stillCurrent: async () => true });
    expect(drive.files.has(late.file.id)).toBe(true);
    clock.advance(24 * 60 * 60 * 1000);
    await sync.collectGarbage({ kept: [snapshot], encoding: 'text', stillCurrent: async () => true });
    expect(drive.files.has(late.file.id)).toBe(false);
  });

  it('reads each kept snapshot once (they never change)', async () => {
    const { drive, clock, sync, snapshot } = await setup();
    const gc = () => sync.collectGarbage({ kept: [snapshot], encoding: 'text', stillCurrent: async () => true });
    await gc();
    clock.advance(24 * 60 * 60 * 1000);
    await gc();
    expect(drive.calls.filter((op) => op === `read:${snapshot.id}`)).toHaveLength(1);
  });
});

describe('engine with attachments', () => {
  it('a sync without attachments costs one attachment listing a day at most', async () => {
    const world = createSyncWorld({ app: createMemoryApp() });
    const a = await world.device('Phone A');
    await a.connect();
    for (let i = 0; i < 3; i++) {
      await a.edit(`change ${i}`);
      expect(await a.background()).toBe('uploaded');
    }
    expect(world.drive.calls.filter((op) => op.startsWith('list:memoryapp.att.'))).toHaveLength(1);
    world.dispose();
  });

  it('a new account forgets the pending attachments of the old one', async () => {
    const world = createSyncWorld();
    const a = await world.device('Phone A');
    await a.connect();
    await a.attach('Book', testBytes('cover'));
    world.drive.failWhen = (op) => (op.startsWith('create:memoryapp.att.') ? new DriveError('offline', 'down') : null);
    expect(await a.background()).toBe('uploaded');
    expect(a.sync.status().attachments.unsent).toBe(1);
    world.drive.failWhen = null;
    await a.sync.disconnect();
    a.auth.email = 'other@example.com';
    await a.connect();
    expect(a.sync.status().attachments.unsent).toBe(0);
    world.dispose();
  });
});
