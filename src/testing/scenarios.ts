import { DEFAULT_KEEP_SNAPSHOTS } from '../engine';
import type { Snapshot } from '../types';
import { createSyncWorld, type AppFactory, type SimulatedDevice, type SyncWorld, type SyncWorldOptions } from './harness';
import { createMemoryApp } from './memoryApp';

/**
 * A two-device sync scenario, named after its manual test case (T-SYNC-nn in
 * the apps' docs/TESTING.md). `run` throws on the first broken expectation.
 */
export interface SyncScenario {
  id: string;
  title: string;
  /** `world` options other than the app, e.g. `{ latencyMs: 5 }`. */
  run(app: AppFactory, world?: Omit<SyncWorldOptions, 'app'>): Promise<void>;
}

class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ScenarioError(message);
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function same(actual: unknown, expected: unknown, message: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}\n  got:      ${show(actual)}\n  expected: ${show(expected)}`);
}

function text(data: Snapshot): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

/** Runs `body` in a fresh world and always disposes it. */
async function inWorld(
  app: AppFactory,
  options: Omit<SyncWorldOptions, 'app'> | undefined,
  body: (world: SyncWorld) => Promise<void>,
): Promise<void> {
  const world = createSyncWorld({ ...options, app });
  try {
    await body(world);
  } finally {
    world.dispose();
  }
}

/** Phone A uploads its data; Phone B restores it (T-SYNC-02). Both end in sync. */
async function handoff(world: SyncWorld): Promise<{ a: SimulatedDevice; b: SimulatedDevice; appId: string }> {
  const a = await world.device('Phone A');
  const appId = a.adapter.appId;
  await a.connect();
  await a.edit('A: first change');
  same(await a.background(), 'uploaded', 'Phone A uploads its data');
  same(world.remoteMeta(appId)?.deviceName, 'Phone A', 'meta.json names Phone A');

  const b = await world.device('Phone B');
  await b.connect();
  const peek = await b.sync.peekRemote();
  check(peek.kind === 'found' && peek.meta.deviceName === 'Phone A', `Phone B sees Phone A's library (${show(peek)})`);
  const restored = await b.sync.restoreFromDrive();
  same(restored.kind, 'restored', 'Phone B restores from Drive');
  same(await b.read(), await a.read(), "Phone B has Phone A's data");
  same(b.sync.status().lastSyncedFrom, 'Phone A', 'Phone B: synced from Phone A');
  same(await b.foreground(), 'unchanged', 'Phone B has nothing more to sync');
  same(await a.foreground(), 'unchanged', 'Phone A has nothing more to sync');
  return { a, b, appId };
}

/**
 * Both phones synced; B edits offline while A uploads; B comes back online:
 * conflict. Checks that nothing was overwritten and that sync is paused.
 */
async function conflict(world: SyncWorld) {
  const { a, b, appId } = await handoff(world);
  b.online = false;
  await b.edit('B: offline change');
  await world.advance(world.debounceMs);
  same(b.sync.status().phase, 'offline', 'Phone B is offline');

  await a.edit('A: change');
  await world.advance(world.debounceMs);
  same(world.remoteMeta(appId)?.deviceName, 'Phone A', "Drive holds Phone A's change");

  b.online = true;
  const bBefore = await b.read();
  const metaBefore = world.remoteMeta(appId);
  same(await b.foreground(), 'conflict', 'Phone B: both sides changed → conflict');
  await world.settle();
  same(b.conflicts.length, 1, 'onConflict is called once');
  same(b.conflicts[0]?.remote.deviceName, 'Phone A', "onConflict names Phone A's version");
  same(b.sync.status().phase, 'conflict', 'Phone B is in conflict');
  same(await b.read(), bBefore, "Phone B's data is not overwritten");
  same(b.imports.length, 1, 'Phone B imported nothing since the restore');
  same(world.remoteMeta(appId), metaBefore, 'Drive is not overwritten');

  // Paused: further changes and syncs write nothing until the user chooses.
  await b.edit('B: change during the conflict');
  await world.advance(world.debounceMs);
  same(await b.foreground(), 'conflict', 'Phone B stays in conflict');
  same(world.remoteMeta(appId), metaBefore, 'Drive is still not overwritten');
  same(a.conflicts.length, 0, 'Phone A is not asked anything');
  return { a, b, appId, metaBefore };
}

export const syncScenarios: readonly SyncScenario[] = [
  {
    id: 'T-SYNC-02',
    title: 'handoff A → B: B restores exactly what A uploaded',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        await handoff(world);
      }),
  },
  {
    id: 'T-SYNC-03',
    title: 'back B → A: B’s change reaches A on foreground, no prompt, safety backup first',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId } = await handoff(world);
        await b.edit('B: change');
        same(world.remoteMeta(appId)?.rev, 1, 'nothing uploaded before the debounce');
        await world.advance(world.debounceMs);
        same(world.remoteMeta(appId)?.deviceName, 'Phone B', 'Phone B uploaded after the debounce');

        same(await a.foreground(), 'imported', "Phone A imports Phone B's change");
        same(await a.read(), await b.read(), 'Phone A has the same data as Phone B');
        same(a.conflicts.length, 0, 'no conflict prompt on Phone A');
        same(a.safetyBackups.length, 1, 'Phone A took a safety backup before the import');
        same(a.sync.status().lastSyncedFrom, 'Phone B', 'Phone A: synced from Phone B');
        same(await a.foreground(), 'unchanged', 'Phone A is in sync');
      }),
  },
  {
    id: 'T-SYNC-04',
    title: 'conflict: onConflict fired, nothing overwritten, sync paused',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        await conflict(world);
      }),
  },
  {
    id: 'T-SYNC-04',
    title: 'conflict → keep local: B’s data goes up, A gets it',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId, metaBefore } = await conflict(world);
        same(await b.sync.resolveConflict('keepLocal'), 'uploaded', 'Phone B uploads its version');
        same(world.remoteMeta(appId)?.rev, (metaBefore?.rev ?? 0) + 1, 'a new rev on Drive');
        same(world.remoteMeta(appId)?.deviceName, 'Phone B', 'from Phone B');
        same(b.imports.length, 1, 'Phone B imported nothing since the restore');
        same(await a.foreground(), 'imported', "Phone A gets Phone B's version");
        same(await a.read(), await b.read(), 'both phones have the same data');
        same(b.sync.status().phase, 'idle', 'Phone B is no longer in conflict');
      }),
  },
  {
    id: 'T-SYNC-04',
    title: 'conflict → keep remote (handler answer): B gets A’s data after a safety backup',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId, metaBefore } = await conflict(world);
        // The user answers the prompt this time.
        b.conflictAnswer = 'keepRemote';
        const asked = b.conflicts.length;
        same(await b.foreground(), 'conflict', 'the next sync asks again');
        await world.settle();
        same(b.conflicts.length, asked + 1, 'onConflict asked again');
        same(b.sync.status().phase, 'idle', 'the conflict is resolved');
        same(await b.read(), await a.read(), "Phone B now has Phone A's data");
        same(b.safetyBackups.length, 2, 'Phone B took a safety backup before the import (restore + this one)');
        same(world.remoteMeta(appId), metaBefore, 'Drive is unchanged');
        same(await b.foreground(), 'unchanged', 'Phone B is in sync');
      }),
  },
  {
    id: 'T-SYNC-04',
    title: 'conflict → export both: both copies kept on B, still in conflict until a choice',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId, metaBefore } = await conflict(world);
        const bBefore = await b.read();
        same(await b.sync.resolveConflict('exportBoth'), 'conflict', 'still in conflict after export both');
        same(b.conflictCopies.length, 1, 'saveConflictCopies called once');
        const copies = b.conflictCopies[0];
        check(copies !== undefined, 'conflict copies saved');
        same(text(copies.remote), world.remoteSnapshot(appId), "the remote copy is Drive's snapshot");
        check(text(copies.local) !== text(copies.remote), 'the local copy is Phone B’s own version');
        same(await b.read(), bBefore, "Phone B's data is not overwritten");
        same(world.remoteMeta(appId), metaBefore, 'Drive is not overwritten');
        same(b.sync.status().phase, 'conflict', 'Phone B is still in conflict');

        same(await b.sync.resolveConflict('keepRemote'), 'imported', 'then a choice resolves it');
        same(await b.read(), await a.read(), "Phone B has Phone A's data");
      }),
  },
  {
    id: 'T-SYNC-05',
    title: 'offline: the change stays queued, then goes up when back online',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId } = await handoff(world);
        a.online = false;
        await a.edit('A: offline change');
        await world.advance(world.debounceMs);
        same(a.sync.status().phase, 'offline', 'Phone A shows offline');
        same(a.sync.status().error, null, 'offline is not an error');
        same(await a.foreground(), 'offline', 'a sync while offline reports offline');
        same(world.remoteMeta(appId)?.rev, 1, 'nothing reached Drive');

        a.online = true;
        same(await a.background(), 'uploaded', 'back online: the queued change goes up');
        same(await b.foreground(), 'imported', 'Phone B gets it');
        same(await b.read(), await a.read(), 'both phones have the same data');
      }),
  },
  {
    id: 'T-SYNC-07',
    title: 'disconnect: the device’s changes never reach Drive until it reconnects',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId } = await handoff(world);
        await a.sync.disconnect();
        same(a.sync.status().phase, 'disconnected', 'Phone A is disconnected');
        const metaBefore = world.remoteMeta(appId);
        const bBefore = await b.read();
        const callsBefore = world.drive.calls.length;

        await a.edit('A: change while disconnected');
        await world.advance(world.debounceMs);
        same(await a.foreground(), 'disconnected', 'Phone A does not sync');
        same(await a.background(), 'disconnected', 'not on background either');
        same(world.drive.calls.length, callsBefore, 'Phone A made no Drive call');
        same(world.remoteMeta(appId), metaBefore, 'Drive is unchanged');
        same(await b.foreground(), 'unchanged', 'Phone B gets nothing');
        same(await b.read(), bBefore, "Phone B's data is unchanged");

        await a.connect();
        same(await a.foreground(), 'uploaded', 'after reconnecting, the change goes up');
        same(await b.foreground(), 'imported', 'and reaches Phone B');
        same(await b.read(), await a.read(), 'both phones have the same data');
      }),
  },
  {
    id: 'T-SYNC-11',
    title: 'upload race: B uploads between A’s meta re-check and write → B sees a conflict on its next sync',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const { a, b, appId } = await handoff(world);
        await a.edit('A: change');
        await b.edit('B: change');

        // Known gap: Drive has no compare-and-swap. B writes right after A's
        // last meta.json read, then A's write replaces B's.
        a.drive.beforeCall = async (op) => {
          if (!op.startsWith('update:')) return;
          a.drive.beforeCall = null;
          same(await b.background(), 'uploaded', 'Phone B uploads inside the window');
        };
        same(await a.background(), 'uploaded', 'Phone A does not see B’s write (no compare-and-swap)');
        same(world.remoteMeta(appId)?.deviceName, 'Phone A', "Drive's meta.json is Phone A's");
        same(await a.foreground(), 'unchanged', 'Phone A is in sync with Drive');

        // B's own upload was replaced: detected, never silently dropped.
        same(await b.foreground(), 'conflict', 'Phone B detects that its upload was overwritten');
        await world.settle();
        same(b.conflicts[0]?.remote.deviceName, 'Phone A', 'onConflict names Phone A');
        const bData = await b.read();
        same(b.imports.length, 1, 'Phone B imported nothing since the restore');

        same(await b.sync.resolveConflict('keepLocal'), 'uploaded', 'keep local: Phone B uploads again');
        same(await a.foreground(), 'imported', "Phone A gets Phone B's version");
        same(await a.read(), bData, 'both phones have Phone B’s version');
      }),
  },
  {
    id: 'T-SYNC-12',
    title: 'newer remote schemaVersion: refused, local data untouched',
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const newer = await world.device('Phone A (newer app)', { schemaVersionDelta: 1 });
        const appId = newer.adapter.appId;
        await newer.connect();
        await newer.edit('A: change in the newer app');
        same(await newer.background(), 'uploaded', 'the newer app uploads');
        const metaBefore = world.remoteMeta(appId);

        const old = await world.device('Phone B (older app)');
        await old.connect();
        await old.edit('B: local change');
        const before = await old.read();
        same(await old.foreground(), 'needsAppUpdate', 'the older app refuses the newer data');
        same(old.sync.status().phase, 'needsAppUpdate', 'phase needsAppUpdate');
        same(old.sync.status().remote?.schemaVersion, newer.adapter.schemaVersion, 'status names the newer schema');
        const restore = await old.sync.restoreFromDrive();
        same(restore.kind, 'needsAppUpdate', 'restoreFromDrive refuses too');
        same(await old.read(), before, 'local data untouched');
        same(old.imports.length + old.safetyBackups.length, 0, 'no import, no backup');
        same(world.remoteMeta(appId), metaBefore, 'Drive untouched');
      }),
  },
  {
    id: 'T-SYNC-13',
    title: `rotation keeps the newest ${DEFAULT_KEEP_SNAPSHOTS} per appId; another appId’s files are never touched`,
    run: (app, options) =>
      inWorld(app, options, async (world) => {
        const a = await world.device('Phone A');
        const appId = a.adapter.appId;
        const otherId = `neighbour-${appId}`;
        const other = await world.device('Phone A (other app)', { app: createMemoryApp({ appId: otherId }) });
        await other.connect();
        for (let i = 1; i <= 2; i++) {
          await other.edit(`other ${i}`);
          same(await other.background(), 'uploaded', 'the other app uploads');
        }
        const otherFiles = () =>
          [...world.drive.files.entries()]
            .filter(([, f]) => f.name.startsWith(`${otherId}.`))
            .map(([id, f]) => [id, f.name, text(f.content)]);
        const otherBefore = otherFiles();

        await a.connect();
        const uploads = DEFAULT_KEEP_SNAPSHOTS + 2;
        for (let i = 1; i <= uploads; i++) {
          await a.edit(`A: change ${i}`);
          same(await a.background(), 'uploaded', `upload ${i}`);
        }
        const expected = Array.from({ length: DEFAULT_KEEP_SNAPSHOTS }, (_, i) => uploads - DEFAULT_KEEP_SNAPSHOTS + 1 + i);
        same(world.snapshotRevs(appId), expected, `the newest ${DEFAULT_KEEP_SNAPSHOTS} snapshots are kept`);
        same(world.remoteMeta(appId)?.rev, uploads, 'meta.json points to the last upload');
        same(otherFiles(), otherBefore, "the other app's files are untouched");
        same(await other.foreground(), 'unchanged', 'the other app is still in sync');

        const b = await world.device('Phone B');
        await b.connect();
        same((await b.sync.restoreFromDrive()).kind, 'restored', 'Phone B restores');
        same(await b.read(), await a.read(), "Phone B has Phone A's latest data");
      }),
  },
];
