import { attachmentExt } from '../drive';
import { sha256Hex } from '../sha256';
import type { AttachmentAdapter } from '../types';
import { testBytes } from './attachmentScenarios';
import type { AppUnderTest, SimulatedDevice } from './harness';
import { check, inWorld, same, type SyncScenario } from './scenarios';

function parts(device: SimulatedDevice): {
  attachments: AttachmentAdapter;
  setAttachment: NonNullable<AppUnderTest['setAttachment']>;
} {
  const attachments = device.app.adapter.attachments;
  const setAttachment = device.app.setAttachment;
  check(attachments !== undefined, 'the adapter has `attachments`');
  check(setAttachment !== undefined, 'the app under test has `setAttachment(label, bytes, ext)`');
  return { attachments, setAttachment: setAttachment.bind(device.app) };
}

function sameBytes(actual: Uint8Array, expected: Uint8Array, message: string): void {
  check(
    actual instanceof Uint8Array && actual.length === expected.length && actual.every((v, i) => v === expected[i]),
    `${message} (got ${actual?.length ?? 'nothing'} bytes, expected ${expected.length})`,
  );
}

/**
 * Checks of an app's attachment adapter on its own, without Drive. Run them
 * with the app's real adapter next to the scenarios.
 */
export const attachmentContract: readonly SyncScenario[] = [
  {
    id: 'ADAPTER-ATT-01',
    title: 'a stored attachment is listed under the sha256 of its bytes, with its size and extension',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const device = await world.device('Phone A');
        const { attachments, setAttachment } = parts(device);
        same(await attachments.listLocalAttachments(), [], 'a fresh install has no attachments');
        const bytes = testBytes('contract cover');
        await setAttachment('Book 1', bytes, 'jpg');
        const listed = await attachments.listLocalAttachments();
        const key = sha256Hex(bytes);
        const info = listed.find((a) => a.key === key);
        check(info !== undefined, `listLocalAttachments() lists the key sha256(bytes) = ${key} (got ${JSON.stringify(listed)})`);
        same(info.size, bytes.length, 'size is the byte length');
        same(attachmentExt(info.ext), info.ext.toLowerCase().replace(/^\./, ''), 'ext is a plain extension (letters/digits)');
        sameBytes(await attachments.readAttachment(key), bytes, 'readAttachment(key) returns the same bytes');
      }),
  },
  {
    id: 'ADAPTER-ATT-02',
    title: 'referencedKeys() of an exported snapshot lists its attachments; once per key locally',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const device = await world.device('Phone A');
        const { attachments, setAttachment } = parts(device);
        same(
          await attachments.referencedKeys(await device.adapter.exportSnapshot()),
          [],
          'an empty library references nothing',
        );
        const bytes = testBytes('shared contract cover');
        await setAttachment('Book 1', bytes, 'jpg');
        await setAttachment('Book 2', bytes, 'jpg');
        const key = sha256Hex(bytes);
        const keys = await attachments.referencedKeys(await device.adapter.exportSnapshot());
        same([...new Set(keys)], [key], 'the snapshot references the key');
        same(
          (await attachments.listLocalAttachments()).filter((a) => a.key === key).length,
          1,
          'the same bytes on two items are listed once',
        );
      }),
  },
  {
    id: 'ADAPTER-ATT-03',
    title: 'another install imports the snapshot before the attachment, then writeAttachment() completes it',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const a = await world.device('Phone A');
        const b = await world.device('Phone B');
        const { setAttachment } = parts(a);
        const { attachments } = parts(b);
        const bytes = testBytes('imported contract cover');
        await setAttachment('Book 1', bytes, 'png');
        const key = sha256Hex(bytes);
        const snapshot = await a.adapter.exportSnapshot();
        const meta = {
          format: 'drive-sync-meta' as const,
          appId: a.adapter.appId,
          rev: 1,
          deviceId: 'device-Phone A',
          deviceName: 'Phone A',
          savedAt: world.clock.now(),
          appVersion: a.adapter.appVersion,
          schemaVersion: a.adapter.schemaVersion,
          snapshotFileId: 'contract',
          encoding: typeof snapshot === 'string' ? ('text' as const) : ('binary' as const),
        };
        await b.adapter.importSnapshot(snapshot, meta);
        same(await b.read(), await a.read(), 'the import works without the attachment (the app shows a fallback)');
        same(
          [...new Set(await attachments.referencedKeys(snapshot))],
          [key],
          "Phone B's referencedKeys() reads Phone A's snapshot",
        );
        check(
          !(await attachments.listLocalAttachments()).some((x) => x.key === key),
          'Phone B does not list an attachment it does not have',
        );
        await attachments.writeAttachment(key, bytes, 'png');
        const info = (await attachments.listLocalAttachments()).find((x) => x.key === key);
        check(info !== undefined, 'after writeAttachment() it is listed');
        same(info.size, bytes.length, 'with its size');
        sameBytes(await attachments.readAttachment(key), bytes, 'and reads back the same bytes');
      }),
  },
];
