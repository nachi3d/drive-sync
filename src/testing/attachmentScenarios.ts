import { ATTACHMENT_RETRY_DELAYS_MS, DEFAULT_ATTACHMENT_GC_INTERVAL_MS } from '../attachments';
import { attachmentFileName, attachmentPrefix, DriveError } from '../drive';
import { DEFAULT_KEEP_SNAPSHOTS } from '../engine';
import { sha256Hex } from '../sha256';
import type { SimulatedDevice, SyncWorld, SyncWorldOptions } from './harness';
import { check, handoff, inWorld, same, type SyncScenario } from './scenarios';

/** Deterministic test bytes ("an image"), `size` long. */
export function testBytes(seed: string, size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  let x = Number.parseInt(sha256Hex(seed).slice(0, 8), 16) || 1;
  for (let i = 0; i < size; i++) {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

function equalBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  return a !== null && a.length === b.length && a.every((value, i) => value === b[i]);
}

function requireAttachments(device: SimulatedDevice): void {
  check(device.adapter.attachments !== undefined, 'the adapter has `attachments`');
  check(device.app.setAttachment !== undefined, 'the app under test has `setAttachment(label, bytes, ext)`');
}

async function hasCover(device: SimulatedDevice, key: string, bytes: Uint8Array, message: string): Promise<void> {
  check(equalBytes(await device.attachment(key), bytes), message);
}

/** Drive file id of an attachment. */
function attachmentFileId(world: SyncWorld, appId: string, key: string): string {
  const entry = [...world.drive.files.entries()].find(([, f]) => f.name.startsWith(`${attachmentPrefix(appId)}${key}.`));
  check(entry !== undefined, `attachment ${key.slice(0, 8)}… is on Drive`);
  return entry[0];
}

function attachmentUploads(world: SyncWorld, appId: string): number {
  return world.drive.calls.filter((op) => op.startsWith(`create:${attachmentPrefix(appId)}`)).length;
}

function withAttachments(
  options: Omit<SyncWorldOptions, 'app'> | undefined,
  attachments: NonNullable<SyncWorldOptions['attachments']>,
): Omit<SyncWorldOptions, 'app'> {
  return { ...options, attachments: { ...options?.attachments, ...attachments } };
}

/**
 * Phone B is in conflict: it changed offline while Phone A uploaded a new
 * cover. Returns the cover A added.
 */
async function coverConflict(world: SyncWorld) {
  const { a, b, appId } = await handoff(world);
  requireAttachments(a);
  b.online = false;
  const bCover = testBytes('B: offline cover');
  const bKey = await b.attach('B: offline book', bCover);
  await world.advance(world.debounceMs);
  same(b.sync.status().phase, 'offline', 'Phone B is offline');

  const aCover = testBytes('A: cover');
  const aKey = await a.attach('A: book', aCover);
  same(await a.background(), 'uploaded', 'Phone A uploads its new book');
  same(world.remoteAttachments(appId), [aKey], "Drive has Phone A's cover only");

  b.online = true;
  same(await b.foreground(), 'conflict', 'Phone B: both sides changed → conflict');
  await world.settle();
  same(await b.attachment(aKey), null, 'Phone B has not fetched anything during the conflict');
  return { a, b, appId, aCover, aKey, bCover, bKey };
}

/** Scenarios for apps with attachments (`adapter.attachments` + `setAttachment`). */
export const attachmentScenarios: readonly SyncScenario[] = [
  {
    id: 'T-ATT-01',
    title: 'A adds a cover → B receives it (fallback until it is there)',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const a = await world.device('Phone A');
        requireAttachments(a);
        const appId = a.adapter.appId;
        await a.connect();
        const cover = testBytes('cover of book 1');
        const key = await a.attach('Book 1', cover, 'jpg');
        same(key, sha256Hex(cover), 'the key is the sha256 of the bytes');
        same(await a.background(), 'uploaded', 'Phone A uploads');
        same(world.remoteAttachments(appId), [key], 'the cover is on Drive');
        check(
          world.drive.names().includes(attachmentFileName(appId, key, 'jpg')),
          'named <appId>.att.<sha256>.<ext> in the app folder',
        );
        same(a.sync.status().attachments.unsent, 0, 'nothing left to send on Phone A');

        const b = await world.device('Phone B');
        await b.connect();
        // Hold the cover download to see what the app shows meanwhile.
        const coverId = attachmentFileId(world, appId, key);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        b.drive.beforeCall = async (op) => {
          if (op === `read:${coverId}`) await gate;
        };
        same((await b.sync.restoreFromDrive()).kind, 'restored', 'Phone B restores');
        same(await b.read(), await a.read(), "Phone B has Phone A's data, which references the cover");
        same(await b.attachment(key), null, 'the cover is not there yet: the app shows its fallback');
        same(b.sync.status().attachments.missing, 1, 'status: one attachment missing');
        same(b.sync.status().phase, 'idle', 'the restore itself is done');

        release();
        await world.settle();
        await hasCover(b, key, cover, 'the cover arrives in the background, byte for byte');
        same(
          b.sync.status().attachments,
          { missing: 0, unsent: 0, tooLarge: 0, transferring: false },
          'status: nothing missing',
        );
        same(b.attachmentWrites, [key], 'downloaded once');
        same(await b.foreground(), 'unchanged', 'Phone B is in sync');
        same(await a.foreground(), 'unchanged', 'Phone A is in sync');
        same(attachmentUploads(world, appId), 1, 'uploaded once');
      }),
  },
  {
    id: 'T-ATT-02',
    title: 'the same cover on two books is stored once, and never uploaded again',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const a = await world.device('Phone A');
        requireAttachments(a);
        const appId = a.adapter.appId;
        await a.connect();
        const cover = testBytes('shared cover');
        const key = await a.attach('Book 1', cover);
        same(await a.attach('Book 2', cover), key, 'same bytes, same key');
        same(await a.background(), 'uploaded', 'Phone A uploads');
        same(world.remoteAttachments(appId), [key], 'one file on Drive');
        same(attachmentUploads(world, appId), 1, 'one upload');

        await a.edit('A: another change');
        same(await a.background(), 'uploaded', 'Phone A uploads again');
        same(attachmentUploads(world, appId), 1, 'the cover is not uploaded again');

        const b = await world.device('Phone B');
        await b.connect();
        same((await b.sync.restoreFromDrive()).kind, 'restored', 'Phone B restores');
        await world.settle();
        await hasCover(b, key, cover, 'Phone B has the cover');
        same(b.attachmentWrites, [key], 'Phone B downloaded it once');

        same(await b.attach('Book 3', cover), key, 'Phone B uses it for a third book');
        same(await b.background(), 'uploaded', 'Phone B uploads');
        same(attachmentUploads(world, appId), 1, 'still one upload in total');
        same(world.remoteAttachments(appId), [key], 'still one file on Drive');
        same(await a.foreground(), 'imported', 'Phone A gets the third book');
        same(a.attachmentWrites, [], 'Phone A already had the cover');
      }),
  },
  {
    id: 'T-ATT-03',
    title: 'conflict → keep remote: B fetches the covers it lacks',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, aCover, aKey } = await coverConflict(world);
        same(await b.sync.resolveConflict('keepRemote'), 'imported', 'keep remote');
        same(await b.read(), await a.read(), "Phone B has Phone A's data");
        await world.settle();
        await hasCover(b, aKey, aCover, "Phone B fetched Phone A's cover");
        same(b.sync.status().attachments.missing, 0, 'nothing missing on Phone B');
      }),
  },
  {
    id: 'T-ATT-03',
    title: 'conflict → keep local: B’s cover goes up, A fetches it',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId, aKey, bCover, bKey } = await coverConflict(world);
        same(await b.sync.resolveConflict('keepLocal'), 'uploaded', 'keep local');
        same(world.remoteAttachments(appId), [aKey, bKey].sort(), "Phone B's cover is on Drive too");
        same(await a.foreground(), 'imported', "Phone A gets Phone B's version");
        await world.settle();
        await hasCover(a, bKey, bCover, "Phone A fetched Phone B's cover");
        same(await a.read(), await b.read(), 'both phones have the same data');
      }),
  },
  {
    id: 'T-ATT-04',
    title: `GC: a cover stays on Drive while any of the ${DEFAULT_KEEP_SNAPSHOTS} kept snapshots references it`,
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const day = DEFAULT_ATTACHMENT_GC_INTERVAL_MS;
        const a = await world.device('Phone A');
        requireAttachments(a);
        const appId = a.adapter.appId;
        await a.connect();
        // Another app's attachment, and a leftover copy of nothing (an orphan of this app).
        const neighbour = world.drive.put(attachmentFileName(`neighbour-${appId}`, sha256Hex('x'), 'jpg'), testBytes('x'));
        const orphanKey = sha256Hex(testBytes('orphan'));
        world.drive.put(attachmentFileName(appId, orphanKey, 'png'), testBytes('orphan'));

        const oldCover = testBytes('old cover');
        const oldKey = await a.attach('Book 1', oldCover);
        same(await a.background(), 'uploaded', 'rev 1: the old cover');
        same(world.remoteAttachments(appId), [oldKey], 'the orphan is cleaned up, the old cover kept');

        const newCover = testBytes('new cover');
        await world.advance(day); // past the clean-up interval
        const newKey = await a.attach('Book 1', newCover);
        same(await a.background(), 'uploaded', 'rev 2: the cover is replaced');
        same(world.remoteAttachments(appId), [newKey, oldKey].sort(), 'rev 1 is kept and references the old cover: kept');

        for (let rev = 3; rev <= DEFAULT_KEEP_SNAPSHOTS + 1; rev++) {
          await world.advance(day);
          await a.edit(`A: change ${rev}`);
          same(await a.background(), 'uploaded', `rev ${rev}`);
          const kept = world.snapshotRevs(appId);
          if (kept.includes(1)) same(world.remoteAttachments(appId), [newKey, oldKey].sort(), `rev ${rev}: old cover still referenced by rev 1`);
          else same(world.remoteAttachments(appId), [newKey], `rev ${rev}: rev 1 rotated out → the old cover is deleted`);
        }
        same(world.snapshotRevs(appId).includes(1), false, 'rev 1 was rotated out');
        check(world.drive.files.has(neighbour.id), "another app's attachment is never touched");

        const b = await world.device('Phone B');
        await b.connect();
        same((await b.sync.restoreFromDrive()).kind, 'restored', 'Phone B restores');
        await world.settle();
        await hasCover(b, newKey, newCover, 'Phone B gets the current cover');
        same(b.sync.status().attachments.missing, 0, 'nothing missing');
      }),
  },
  {
    id: 'T-ATT-05',
    title: 'offline: a cover added offline goes up with the next upload',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId } = await handoff(world);
        requireAttachments(a);
        a.online = false;
        const cover = testBytes('offline cover');
        const key = await a.attach('Book 1', cover);
        await world.advance(world.debounceMs);
        same(a.sync.status().phase, 'offline', 'Phone A is offline');
        same(world.remoteAttachments(appId), [], 'nothing reached Drive');

        a.online = true;
        same(await a.background(), 'uploaded', 'back online: the change goes up');
        same(world.remoteAttachments(appId), [key], 'with its cover');
        same(await b.foreground(), 'imported', 'Phone B gets it');
        await world.settle();
        await hasCover(b, key, cover, 'Phone B has the cover');
      }),
  },
  {
    id: 'T-ATT-05',
    title: 'network lost after the snapshot upload: the cover is sent on the next sync, B gets it then',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId } = await handoff(world);
        requireAttachments(a);
        const cover = testBytes('late cover');
        const key = await a.attach('Book 1', cover);
        world.drive.failWhen = (op) =>
          op.startsWith(`create:${attachmentPrefix(appId)}`) ? new DriveError('offline', 'Network request failed') : null;
        same(await a.background(), 'uploaded', 'the snapshot goes up (the sync itself succeeds)');
        same(world.remoteAttachments(appId), [], 'the cover did not');
        same(a.sync.status().attachments.unsent, 1, 'Phone A: one attachment unsent');

        same(await b.foreground(), 'imported', 'Phone B imports the snapshot');
        await world.settle();
        same(await b.attachment(key), null, 'Phone B: cover not on Drive yet → fallback');
        same(b.sync.status().attachments.missing, 1, 'Phone B: one attachment missing');

        world.drive.failWhen = null;
        same(await a.foreground(), 'unchanged', 'Phone A: nothing new to upload…');
        same(world.remoteAttachments(appId), [key], '…but the queued cover goes up');
        same(a.sync.status().attachments.unsent, 0, 'Phone A: nothing unsent');
        same(await b.foreground(), 'unchanged', 'Phone B: the next sync…');
        await world.settle();
        await hasCover(b, key, cover, '…fetches the cover');
      }),
  },
  {
    id: 'T-ATT-06',
    title: 'a failed download is retried in the background',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const a = await world.device('Phone A');
        requireAttachments(a);
        const appId = a.adapter.appId;
        await a.connect();
        const cover = testBytes('flaky cover');
        const key = await a.attach('Book 1', cover);
        same(await a.background(), 'uploaded', 'Phone A uploads');

        const b = await world.device('Phone B');
        await b.connect();
        const coverId = attachmentFileId(world, appId, key);
        let failures = 2;
        b.drive.beforeCall = (op) => {
          if (op === `read:${coverId}` && failures-- > 0) throw new DriveError('http', 'Drive 503', 503);
        };
        same((await b.sync.restoreFromDrive()).kind, 'restored', 'Phone B restores');
        await world.settle();
        same(await b.attachment(key), null, 'the first download failed');
        same(b.sync.status().phase, 'idle', 'not a sync error');
        await world.advance(ATTACHMENT_RETRY_DELAYS_MS[0] ?? 0);
        same(await b.attachment(key), null, 'the first retry failed too');
        await world.advance(ATTACHMENT_RETRY_DELAYS_MS[1] ?? 0);
        await hasCover(b, key, cover, 'the second retry gets it');
      }),
  },
  {
    id: 'T-ATT-07',
    title: 'Wi-Fi only: downloads wait for Wi-Fi; uploads do not',
    run: (app, options) =>
      inWorld(app, withAttachments(options, { wifiOnlyDownloads: true }), async (world) => {
        const a = await world.device('Phone A');
        requireAttachments(a);
        const appId = a.adapter.appId;
        a.wifi = false;
        await a.connect();
        const cover = testBytes('cover on mobile data');
        const key = await a.attach('Book 1', cover);
        same(await a.background(), 'uploaded', 'Phone A uploads on mobile data');
        same(world.remoteAttachments(appId), [key], 'the cover too');

        const b = await world.device('Phone B');
        b.wifi = false;
        await b.connect();
        same((await b.sync.restoreFromDrive()).kind, 'restored', 'Phone B restores the snapshot on mobile data');
        await world.settle();
        same(await b.attachment(key), null, 'but not the cover');
        same(await b.foreground(), 'unchanged', 'a sync…');
        await world.settle();
        same(await b.attachment(key), null, '…still does not download it');
        same(await b.sync.fetchAttachments(), 'waitingForWifi', 'fetchAttachments() says why');

        b.wifi = true;
        same(await b.sync.fetchAttachments(), 'done', 'on Wi-Fi it downloads');
        await hasCover(b, key, cover, 'Phone B has the cover');
      }),
  },
  {
    id: 'T-ATT-08',
    title: 'a cover over maxBytes stays on its device; the rest syncs',
    run: (app, options) =>
      inWorld(app, withAttachments(options, { maxBytes: 4096 }), async (world) => {
        const a = await world.device('Phone A');
        requireAttachments(a);
        const appId = a.adapter.appId;
        await a.connect();
        const small = testBytes('small', 4096);
        const big = testBytes('big', 4097);
        const smallKey = await a.attach('Book 1', small);
        const bigKey = await a.attach('Book 2', big);
        same(await a.background(), 'uploaded', 'Phone A uploads');
        same(world.remoteAttachments(appId), [smallKey], 'only the small cover is on Drive');
        same(a.sync.status().attachments.tooLarge, 1, 'Phone A: one attachment too large');
        same(a.sync.status().attachments.unsent, 0, 'not retried');

        const b = await world.device('Phone B');
        await b.connect();
        same((await b.sync.restoreFromDrive()).kind, 'restored', 'Phone B restores');
        await world.settle();
        await hasCover(b, smallKey, small, 'Phone B has the small cover');
        same(await b.attachment(bigKey), null, 'the big one shows the fallback');
      }),
  },
];
