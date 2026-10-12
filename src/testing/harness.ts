import { DriveError, metaFileName, parseAttachmentName, parseMeta, snapshotPrefix, snapshotRev, type DriveFile, type DriveStore } from '../drive';
import { createSyncEngine, DEFAULT_DEBOUNCE_MS, type DriveSync } from '../engine';
import { sha256Hex } from '../sha256';
import type {
  AttachmentOptions,
  ConflictChoice,
  ConflictCopies,
  ConflictInfo,
  KeyValueStorage,
  RemoteMeta,
  Snapshot,
  SnapshotEncoding,
  SyncAdapter,
  SyncResult,
} from '../types';
import { VirtualClock } from './clock';
import { createMemoryStorage, FakeAuth, FakeDrive } from './fakes';
import { createMemoryApp } from './memoryApp';

/** What a device gives the app it runs. */
export interface AppDeviceContext {
  deviceName: string;
  /** The device's sync state storage (the app may keep its own sync markers there). */
  storage: KeyValueStorage;
  /** The world's clock, UTC ISO. */
  now(): string;
}

/** One app install on one simulated device, with the app's real adapter. */
export interface AppUnderTest {
  adapter: SyncAdapter;
  /** One local change as a user would make it; `label` is unique per call. */
  edit(label: string): void | Promise<void>;
  /**
   * For apps with attachments: gives the item `label` this attachment (e.g.
   * the book `label` gets this cover), creating the item if needed. The app
   * stores the bytes under their sha256 key.
   */
  setAttachment?(label: string, bytes: Uint8Array, ext: string): void | Promise<void>;
  /** The app's data in a JSON-comparable form: equal on two devices = same data. */
  read(): unknown | Promise<unknown>;
}

export type AppFactory = (context: AppDeviceContext) => AppUnderTest | Promise<AppUnderTest>;

export interface SyncWorldOptions {
  /** The app on every device unless a device says otherwise. Default: createMemoryApp(). */
  app?: AppFactory;
  debounceMs?: number;
  keepSnapshots?: number;
  /** Real-time delay of every Drive call, in ms. */
  latencyMs?: number;
  /** Start time of the virtual clock. */
  start?: string;
  /** Attachment options of every device (Wi-Fi is the device's `wifi` switch). */
  attachments?: Omit<AttachmentOptions, 'isWifi'>;
}

export interface DeviceOptions {
  /** Another app on this device (e.g. a second app sharing the Cloud project). */
  app?: AppFactory;
  /** Added to the app's schemaVersion: +1 plays a newer app version. */
  schemaVersionDelta?: number;
  /** Google account; default the world's one. */
  email?: string;
}

/**
 * One device's view of the shared Drive: its own network switch and hook,
 * then the shared FakeDrive.
 */
export class DeviceDrive implements DriveStore {
  online = true;
  /** Runs before each of this device's calls (e.g. to let another device write first). */
  beforeCall: ((op: string) => void | Promise<void>) | null = null;

  constructor(private readonly shared: FakeDrive) {}

  private async enter(op: string): Promise<void> {
    if (this.beforeCall) await this.beforeCall(op);
    if (!this.online) throw new DriveError('offline', 'Network request failed');
  }

  async findFile(name: string): Promise<DriveFile | null> {
    await this.enter(`find:${name}`);
    return this.shared.findFile(name);
  }

  async listFiles(prefix: string): Promise<DriveFile[]> {
    await this.enter(`list:${prefix}`);
    return this.shared.listFiles(prefix);
  }

  async createFile(name: string, content: Snapshot): Promise<DriveFile> {
    await this.enter(`create:${name}`);
    return this.shared.createFile(name, content);
  }

  async updateFile(id: string, content: Snapshot): Promise<void> {
    await this.enter(`update:${id}`);
    return this.shared.updateFile(id, content);
  }

  async readFile(id: string, encoding: SnapshotEncoding): Promise<Snapshot> {
    await this.enter(`read:${id}`);
    return this.shared.readFile(id, encoding);
  }

  async deleteFile(id: string): Promise<void> {
    await this.enter(`delete:${id}`);
    return this.shared.deleteFile(id);
  }
}

export interface SimulatedDevice {
  readonly name: string;
  readonly app: AppUnderTest;
  /** The adapter the engine sees (the app's, recorded). */
  readonly adapter: SyncAdapter;
  readonly sync: DriveSync;
  readonly auth: FakeAuth;
  readonly storage: KeyValueStorage;
  readonly drive: DeviceDrive;
  /** Network on/off for this device only. */
  online: boolean;
  /** On Wi-Fi (for `wifiOnlyDownloads`). Default true. */
  wifi: boolean;
  /** What the conflict handler answers; null = decide later. */
  conflictAnswer: ConflictChoice | null;
  /** Every onConflict call. */
  readonly conflicts: ConflictInfo[];
  /** Every importSnapshot. */
  readonly imports: RemoteMeta[];
  /** Every beforeImport (the app's safety backup). */
  readonly safetyBackups: RemoteMeta[];
  readonly conflictCopies: ConflictCopies[];
  /** Every writeAttachment (downloaded attachment keys). */
  readonly attachmentWrites: string[];
  /** A local change, then notifyChange() as the app does after a write. */
  edit(label: string): Promise<void>;
  /** app.setAttachment(), then notifyChange(). Returns the attachment key. */
  attach(label: string, bytes: Uint8Array, ext?: string): Promise<string>;
  /** The attachment's bytes on this device, or null. */
  attachment(key: string): Promise<Uint8Array | null>;
  read(): Promise<unknown>;
  /** Interactive sign-in without the automatic first sync. */
  connect(): Promise<void>;
  /** The app comes to the foreground: a sync. */
  foreground(): Promise<SyncResult>;
  /** The app goes to the background: the pending sync runs now. */
  background(): Promise<SyncResult>;
}

export interface SyncWorld {
  /** The shared appDataFolder. */
  readonly drive: FakeDrive;
  readonly clock: VirtualClock;
  readonly debounceMs: number;
  readonly devices: SimulatedDevice[];
  device(name: string, options?: DeviceOptions): Promise<SimulatedDevice>;
  /** Waits until no sync work is running on any device. */
  settle(): Promise<void>;
  /** Moves the clock (firing debounced syncs), then settles. */
  advance(ms: number): Promise<void>;
  /** meta.json of `appId` on Drive, or null. */
  remoteMeta(appId: string): RemoteMeta | null;
  /** The snapshot meta.json of `appId` points to, as text. */
  remoteSnapshot(appId: string): string | null;
  /** Revs of the `appId` snapshot files on Drive, ascending. */
  snapshotRevs(appId: string): number[];
  /** Keys of the `appId` attachment files on Drive, sorted (a key twice = two files). */
  remoteAttachments(appId: string): string[];
  dispose(): void;
}

function snapshotText(data: Snapshot): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

/** Lets one macrotask turn pass (every pending microtask runs first). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One fake Drive app folder and any number of simulated devices running the
 * real sync engine. Uses real timers for its own waiting: do not combine with
 * jest fake timers.
 */
export function createSyncWorld(options: SyncWorldOptions = {}): SyncWorld {
  const drive = new FakeDrive();
  drive.latencyMs = options.latencyMs ?? 0;
  const clock = new VirtualClock(options.start);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const defaultApp = options.app ?? createMemoryApp();
  const devices: SimulatedDevice[] = [];
  let busy = 0;

  /** Counts a device operation as running, for settle(). */
  function track<T>(promise: Promise<T>): Promise<T> {
    busy++;
    return promise.finally(() => {
      busy--;
    });
  }

  async function settle(): Promise<void> {
    let quiet = 0;
    for (let i = 0; i < 10_000; i++) {
      await tick();
      const transferring = devices.some((d) => d.sync.status().attachments.transferring);
      quiet = busy === 0 && drive.inFlight === 0 && !transferring ? quiet + 1 : 0;
      if (quiet >= 3) return;
    }
    throw new Error('settle(): sync work still running after 10000 turns');
  }

  function remoteMeta(appId: string): RemoteMeta | null {
    const text = drive.text(metaFileName(appId));
    return text === null ? null : parseMeta(text, appId);
  }

  async function device(name: string, deviceOptions: DeviceOptions = {}): Promise<SimulatedDevice> {
    const storage = createMemoryStorage();
    const app = await (deviceOptions.app ?? defaultApp)({ deviceName: name, storage, now: () => clock.now() });
    const real = app.adapter;
    const conflicts: ConflictInfo[] = [];
    const imports: RemoteMeta[] = [];
    const safetyBackups: RemoteMeta[] = [];
    const conflictCopies: ConflictCopies[] = [];
    const attachmentWrites: string[] = [];
    const realAttachments = real.attachments;

    // The app's adapter, recorded. Methods are called on `real` so class-based adapters work.
    const adapter: SyncAdapter = {
      appId: real.appId,
      deviceName: real.deviceName,
      appVersion: real.appVersion,
      schemaVersion: real.schemaVersion + (deviceOptions.schemaVersionDelta ?? 0),
      exportSnapshot: () => real.exportSnapshot(),
      async importSnapshot(data, meta) {
        imports.push(meta);
        await real.importSnapshot(data, meta);
      },
      isDirtySince: (rev) => real.isDirtySince(rev),
      markSynced: (rev) => real.markSynced(rev),
      async beforeImport(meta) {
        safetyBackups.push(meta);
        await real.beforeImport?.(meta);
      },
      async saveConflictCopies(copies) {
        conflictCopies.push(copies);
        await real.saveConflictCopies?.(copies);
      },
      attachments: realAttachments && {
        listLocalAttachments: () => realAttachments.listLocalAttachments(),
        readAttachment: (key) => realAttachments.readAttachment(key),
        async writeAttachment(key, bytes, ext) {
          attachmentWrites.push(key);
          await realAttachments.writeAttachment(key, bytes, ext);
        },
        referencedKeys: (snapshot) => realAttachments.referencedKeys(snapshot),
      },
    };

    const auth = new FakeAuth(deviceOptions.email ?? 'reader@example.com');
    const deviceDrive = new DeviceDrive(drive);
    const engine = createSyncEngine({
      adapter,
      auth,
      drive: deviceDrive,
      storage,
      debounceMs,
      keepSnapshots: options.keepSnapshots,
      attachments: { ...options.attachments, isWifi: () => simulated.wifi },
      now: () => clock.now(),
      newDeviceId: () => `device-${name}`,
      timers: clock,
      onConflict: async (info) => {
        conflicts.push(info);
        return simulated.conflictAnswer;
      },
    });

    // Every engine call is tracked, so settle() waits for it.
    const sync: DriveSync = {
      ...engine,
      start: () => track(engine.start()),
      connect: (o) => track(engine.connect(o)),
      disconnect: () => track(engine.disconnect()),
      syncNow: () => track(engine.syncNow()),
      flush: () => track(engine.flush()),
      peekRemote: () => track(engine.peekRemote()),
      fetchAttachments: () => track(engine.fetchAttachments()),
      restoreFromDrive: () => track(engine.restoreFromDrive()),
      resolveConflict: (choice) => track(engine.resolveConflict(choice)),
    };

    const simulated: SimulatedDevice = {
      name,
      app,
      adapter,
      sync,
      auth,
      storage,
      drive: deviceDrive,
      get online() {
        return deviceDrive.online;
      },
      set online(value: boolean) {
        deviceDrive.online = value;
      },
      wifi: true,
      conflictAnswer: null,
      conflicts,
      imports,
      safetyBackups,
      conflictCopies,
      attachmentWrites,
      async edit(label) {
        await app.edit(label);
        engine.notifyChange();
      },
      async attach(label, bytes, ext = 'jpg') {
        if (app.setAttachment === undefined) throw new Error(`${name}: the app has no setAttachment()`);
        await app.setAttachment(label, bytes, ext);
        engine.notifyChange();
        return sha256Hex(bytes);
      },
      async attachment(key) {
        if (realAttachments === undefined) return null;
        const local = await realAttachments.listLocalAttachments();
        return local.some((a) => a.key === key) ? realAttachments.readAttachment(key) : null;
      },
      async read() {
        return app.read();
      },
      async connect() {
        if (!(await sync.connect({ sync: false }))) throw new Error(`${name}: sign-in cancelled`);
      },
      foreground: () => sync.syncNow(),
      background: () => sync.flush(),
    };
    devices.push(simulated);
    return simulated;
  }

  return {
    drive,
    clock,
    debounceMs,
    devices,
    device,
    settle,
    async advance(ms) {
      clock.advance(ms);
      await settle();
    },
    remoteMeta,
    remoteSnapshot(appId) {
      const meta = remoteMeta(appId);
      const file = meta === null ? undefined : drive.files.get(meta.snapshotFileId);
      return file === undefined ? null : snapshotText(file.content);
    },
    snapshotRevs(appId) {
      return [...drive.files.values()]
        .filter((f) => f.name.startsWith(snapshotPrefix(appId)))
        .map((f) => snapshotRev(appId, f.name))
        .filter((rev): rev is number => rev !== null)
        .sort((a, b) => a - b);
    },
    remoteAttachments(appId) {
      return [...drive.files.values()]
        .map((f) => parseAttachmentName(appId, f.name)?.key)
        .filter((key): key is string => key !== undefined)
        .sort();
    },
    dispose() {
      for (const d of devices) d.sync.dispose();
    },
  };
}
