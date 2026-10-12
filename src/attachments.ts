import {
  attachmentFileName,
  attachmentPrefix,
  isAttachmentKey,
  isOfflineError,
  parseAttachmentName,
  DriveError,
  type DriveFile,
  type DriveStore,
} from './drive';
import type { Timers } from './engine';
import { sha256Hex } from './sha256';
import type {
  AttachmentAdapter,
  AttachmentFetchResult,
  AttachmentInfo,
  AttachmentOptions,
  AttachmentStatus,
  KeyValueStorage,
  Snapshot,
  SnapshotEncoding,
} from './types';

export const DEFAULT_MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const DEFAULT_ATTACHMENT_CONCURRENCY = 3;
export const DEFAULT_ATTACHMENT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Waits before the download pass runs again after failed downloads (then: next sync). */
export const ATTACHMENT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

export const NO_ATTACHMENTS: AttachmentStatus = { missing: 0, unsent: 0, tooLarge: 0, transferring: false };

/** What the package remembers about attachments on the device. */
interface AttachmentState {
  /** Referenced by the local data, not on this device yet. */
  missing: string[];
  /** Referenced by this device's last upload and on the device, not confirmed on Drive. */
  unsent: string[];
  lastGcAt: string | null;
}

export interface AttachmentSyncOptions extends AttachmentOptions {
  adapter: AttachmentAdapter;
  appId: string;
  drive: DriveStore;
  storage: KeyValueStorage;
  timers: Timers;
  now: () => string;
  /** False once disconnected or disposed: transfers stop. */
  active: () => boolean;
  onStatus: (status: AttachmentStatus) => void;
}

export interface GarbageInput {
  /** Snapshot files left on Drive after rotation. */
  kept: DriveFile[];
  /** Encoding of the snapshots (the current meta's). */
  encoding: SnapshotEncoding;
  /** Re-reads meta.json: false if another device uploaded since (then nothing is deleted). */
  stillCurrent: () => Promise<boolean>;
}

/**
 * Attachment transfers. None of them fails a sync: what did not go through
 * stays in `missing` / `unsent` and is tried again on the next sync.
 */
export interface AttachmentSync {
  status(): AttachmentStatus;
  /** This device uploaded `data` as snapshot file `fileId`: sends its attachments missing on Drive. */
  afterUpload(data: Snapshot, fileId: string): Promise<void>;
  /** `data` was imported: starts fetching the attachments missing here, in the background. */
  afterImport(data: Snapshot, fileId: string): Promise<void>;
  /** Sends what is still unsent; fetches what is still missing (background). */
  resume(): Promise<void>;
  /** Download pass now (joins a running one). */
  fetchMissing(): Promise<AttachmentFetchResult>;
  /** Deletes Drive attachments that no kept snapshot references (at most once per gcIntervalMs). */
  collectGarbage(input: GarbageInput): Promise<void>;
  /** Another account: forgets everything. */
  reset(): Promise<void>;
  /** Cancels a scheduled retry. */
  cancel(): void;
}

interface RemoteAttachment {
  key: string;
  ext: string;
  file: DriveFile;
}

function unique(keys: Iterable<string>): string[] {
  return [...new Set(keys)];
}

/** Runs `fn` on every item, `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function createAttachmentSync(options: AttachmentSyncOptions): AttachmentSync {
  const { adapter, appId, drive, storage, timers, now, active } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_ATTACHMENT_CONCURRENCY);
  const gcIntervalMs = options.gcIntervalMs ?? DEFAULT_ATTACHMENT_GC_INTERVAL_MS;
  const storageKey = `drive-sync:${appId}:attachments`;
  if (options.wifiOnlyDownloads !== undefined && options.isWifi === undefined) {
    throw new Error('drive-sync: attachments.wifiOnlyDownloads needs attachments.isWifi');
  }

  let cached: AttachmentState | null = null;
  let loading: Promise<AttachmentState> | null = null;
  let transfers = 0;
  /** Over maxBytes on this device (upload) / on Drive (download). */
  const tooLargeUp = new Set<string>();
  const tooLargeDown = new Set<string>();
  /** Keys referenced by each snapshot file. Snapshot files are never modified. */
  const refsBySnapshot = new Map<string, string[]>();

  let fetching: Promise<AttachmentFetchResult> | null = null;
  let fetchAgain = false;
  let retryTimer: unknown = null;
  let attempt = 0;

  function status(): AttachmentStatus {
    return {
      missing: cached?.missing.length ?? 0,
      unsent: cached?.unsent.length ?? 0,
      tooLarge: new Set([...tooLargeUp, ...tooLargeDown]).size,
      transferring: transfers > 0,
    };
  }

  function emit(): void {
    options.onStatus(status());
  }

  function state(): Promise<AttachmentState> {
    if (cached !== null) return Promise.resolve(cached);
    loading ??= (async () => {
      let raw: Partial<AttachmentState> = {};
      try {
        raw = JSON.parse((await storage.getItem(storageKey)) ?? '{}') as Partial<AttachmentState>;
      } catch {
        // Unreadable: start over (the next upload or import rebuilds it).
      }
      const keys = (value: unknown) =>
        Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string' && isAttachmentKey(k)) : [];
      cached ??= {
        missing: keys(raw.missing),
        unsent: keys(raw.unsent),
        lastGcAt: typeof raw.lastGcAt === 'string' ? raw.lastGcAt : null,
      };
      emit();
      return cached;
    })();
    return loading;
  }

  async function save(patch: Partial<AttachmentState>): Promise<void> {
    cached = { ...(await state()), ...patch };
    emit();
    await storage.setItem(storageKey, JSON.stringify(cached));
  }

  async function referenced(data: Snapshot, fileId: string): Promise<string[]> {
    const keys = unique((await adapter.referencedKeys(data)).filter(isAttachmentKey));
    refsBySnapshot.set(fileId, keys);
    return keys;
  }

  async function localAttachments(): Promise<Map<string, AttachmentInfo>> {
    return new Map((await adapter.listLocalAttachments()).map((info) => [info.key, info]));
  }

  async function remoteAttachments(): Promise<RemoteAttachment[]> {
    const files = await drive.listFiles(attachmentPrefix(appId));
    const found: RemoteAttachment[] = [];
    for (const file of files) {
      const parsed = parseAttachmentName(appId, file.name);
      if (parsed !== null) found.push({ ...parsed, file });
    }
    return found;
  }

  // ------------------------------------------------------------ upload

  async function uploadPass(): Promise<void> {
    const s = await state();
    if (s.unsent.length === 0 || !active()) return;
    transfers++;
    emit();
    const settled = new Set<string>();
    try {
      const local = await localAttachments();
      const onDrive = new Set((await remoteAttachments()).map((a) => a.key));
      const todo: AttachmentInfo[] = [];
      for (const key of s.unsent) {
        const info = local.get(key);
        // Gone from the device, or already on Drive: nothing to send.
        if (info === undefined || onDrive.has(key)) settled.add(key);
        else if (info.size > maxBytes) {
          tooLargeUp.add(key);
          settled.add(key);
        } else todo.push(info);
      }
      let offline = false;
      await pool(todo, concurrency, async (info) => {
        if (offline || !active()) return;
        try {
          const bytes = await adapter.readAttachment(info.key);
          if (bytes.length > maxBytes) tooLargeUp.add(info.key);
          else await drive.createFile(attachmentFileName(appId, info.key, info.ext), bytes);
          settled.add(info.key);
        } catch (error) {
          if (isOfflineError(error)) offline = true;
          // The app could not read its own file: drop it rather than retry forever.
          else if (!(error instanceof DriveError)) settled.add(info.key);
        }
      });
    } catch {
      // Listing failed (offline…): everything stays unsent.
    } finally {
      transfers--;
      const current = await state();
      await save({ unsent: current.unsent.filter((key) => !settled.has(key)) });
    }
  }

  // ------------------------------------------------------------ download

  async function wifiBlocked(): Promise<boolean> {
    const setting = options.wifiOnlyDownloads;
    const wifiOnly = typeof setting === 'function' ? setting() : setting === true;
    return wifiOnly && !(await options.isWifi?.());
  }

  function scheduleRetry(): void {
    if (retryTimer !== null || attempt >= ATTACHMENT_RETRY_DELAYS_MS.length) return;
    const delay = ATTACHMENT_RETRY_DELAYS_MS[attempt++] ?? 0;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void fetchMissing();
    }, delay);
  }

  async function downloadPass(): Promise<AttachmentFetchResult> {
    if (!active()) return 'disconnected';
    const s = await state();
    if (s.missing.length === 0) return 'done';
    if (await wifiBlocked()) return 'waitingForWifi';
    const done = new Set<string>();
    let offline = false;
    let failed = false;
    try {
      const local = await localAttachments();
      for (const key of s.missing) if (local.has(key)) done.add(key);
      const onDrive = new Map((await remoteAttachments()).map((a) => [a.key, a]));
      tooLargeDown.clear();
      await pool(
        s.missing.filter((key) => !done.has(key)),
        concurrency,
        async (key) => {
          const remote = onDrive.get(key);
          // Not uploaded yet by the other device: the next pass looks again.
          if (offline || !active() || remote === undefined) return;
          if (remote.file.size !== undefined && remote.file.size > maxBytes) {
            tooLargeDown.add(key);
            return;
          }
          try {
            const data = await drive.readFile(remote.file.id, 'binary');
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            if (bytes.length > maxBytes) {
              tooLargeDown.add(key);
              return;
            }
            if (sha256Hex(bytes) !== key) throw new Error(`Attachment ${key} does not match its key`);
            await adapter.writeAttachment(key, bytes, remote.ext);
            done.add(key);
          } catch (error) {
            if (isOfflineError(error)) offline = true;
            else failed = true;
          }
        },
      );
    } catch (error) {
      if (isOfflineError(error)) offline = true;
      else failed = true;
    }
    // The missing list may have been replaced meanwhile (a newer import): only remove what arrived.
    const current = await state();
    const missing = current.missing.filter((key) => !done.has(key));
    await save({ missing });
    if (offline) return 'offline';
    if (failed) scheduleRetry();
    else attempt = 0;
    return missing.length === 0 ? 'done' : 'pending';
  }

  function fetchMissing(): Promise<AttachmentFetchResult> {
    if (fetching !== null) {
      fetchAgain = true;
      return fetching;
    }
    transfers++;
    emit();
    fetching = (async () => {
      let result: AttachmentFetchResult;
      do {
        fetchAgain = false;
        result = await downloadPass().catch((): AttachmentFetchResult => 'pending');
      } while (fetchAgain && result !== 'offline' && result !== 'disconnected');
      return result;
    })().finally(() => {
      fetching = null;
      transfers--;
      emit();
    });
    return fetching;
  }

  function fetchInBackground(): void {
    void fetchMissing();
  }

  // ------------------------------------------------------------ GC

  async function collectGarbage({ kept, encoding, stillCurrent }: GarbageInput): Promise<void> {
    const s = await state();
    if (s.lastGcAt !== null && Date.parse(now()) - Date.parse(s.lastGcAt) < gcIntervalMs) return;
    const remote = await remoteAttachments();
    if (remote.length > 0) {
      // Any snapshot that cannot be read aborts the clean-up: never delete on a guess.
      const keep = new Set<string>();
      for (const file of kept) {
        let keys = refsBySnapshot.get(file.id);
        if (keys === undefined) keys = await referenced(await drive.readFile(file.id, encoding), file.id);
        for (const key of keys) keep.add(key);
      }
      for (const id of [...refsBySnapshot.keys()]) {
        if (!kept.some((file) => file.id === id)) refsBySnapshot.delete(id);
      }
      const seen = new Set<string>();
      const doomed: DriveFile[] = [];
      for (const { key, file } of [...remote].sort((a, b) => a.file.id.localeCompare(b.file.id))) {
        // Unreferenced, or a second copy (two devices uploaded the same key at once).
        if (!keep.has(key) || seen.has(key)) doomed.push(file);
        seen.add(key);
      }
      if (doomed.length > 0) {
        if (!(await stillCurrent())) return;
        for (const file of doomed) await drive.deleteFile(file.id);
      }
    }
    await save({ lastGcAt: now() });
  }

  function cancel(): void {
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    attempt = 0;
  }

  return {
    status,

    async afterUpload(data, fileId) {
      const keys = await referenced(data, fileId);
      const local = await localAttachments();
      const s = await state();
      tooLargeUp.clear();
      await save({
        unsent: unique([...keys.filter((k) => local.has(k)), ...s.unsent.filter((k) => keys.includes(k))]),
        missing: keys.filter((k) => !local.has(k)),
      });
      await uploadPass();
      if ((await state()).missing.length > 0) fetchInBackground();
    },

    async afterImport(data, fileId) {
      const keys = await referenced(data, fileId);
      const local = await localAttachments();
      const s = await state();
      tooLargeUp.clear();
      tooLargeDown.clear();
      attempt = 0;
      await save({
        missing: keys.filter((k) => !local.has(k)),
        // Still ours to send if the imported data references it (we were its only source).
        unsent: s.unsent.filter((k) => keys.includes(k) && local.has(k)),
      });
      fetchInBackground();
    },

    async resume() {
      await uploadPass();
      if ((await state()).missing.length > 0) fetchInBackground();
    },

    fetchMissing,
    collectGarbage,

    async reset() {
      cancel();
      tooLargeUp.clear();
      tooLargeDown.clear();
      refsBySnapshot.clear();
      await save({ missing: [], unsent: [], lastGcAt: null });
    },

    cancel,
  };
}
