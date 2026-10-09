import { DriveError } from '../drive';
import { createMemoryApp, createSyncWorld, syncScenarios, VirtualClock } from '../testing';

describe('two-device scenarios (memory app)', () => {
  it.each(syncScenarios.map((s) => [s.id, s.title, s] as const))('%s %s', async (_id, _title, scenario) => {
    await scenario.run(createMemoryApp());
  });
});

describe('two-device scenarios with Drive latency', () => {
  it.each(syncScenarios.map((s) => [s.id, s.title, s] as const))('%s %s', async (_id, _title, scenario) => {
    await scenario.run(createMemoryApp(), { latencyMs: 1 });
  });
});

describe('harness', () => {
  it('fires debounced syncs when the clock advances', async () => {
    const world = createSyncWorld({ latencyMs: 1 });
    const a = await world.device('Phone A');
    await a.connect();
    await a.edit('one');
    await world.advance(world.debounceMs - 1);
    expect(world.remoteMeta('memoryapp')).toBeNull();
    await world.advance(1);
    expect(world.remoteMeta('memoryapp')).toMatchObject({ rev: 1, deviceName: 'Phone A' });
    world.dispose();
  });

  it('injects a Drive failure: error, then the next sync recovers', async () => {
    const world = createSyncWorld();
    const a = await world.device('Phone A');
    await a.connect();
    await a.edit('one');
    world.drive.failWhen = (op) => (op.startsWith('create:') ? new DriveError('http', 'Drive 500', 500) : null);
    expect(await a.background()).toBe('error');
    expect(a.sync.status().error).toMatchObject({ code: 'drive' });
    expect(world.remoteMeta('memoryapp')).toBeNull();
    world.drive.failWhen = null;
    expect(await a.foreground()).toBe('uploaded');
    world.dispose();
  });

  it('takes one device offline without the others', async () => {
    const world = createSyncWorld();
    const a = await world.device('Phone A');
    const b = await world.device('Phone B');
    await a.connect();
    await b.connect();
    b.online = false;
    expect(await a.background()).toBe('uploaded');
    expect(await b.foreground()).toBe('offline');
    world.dispose();
  });

  it('reports a broken expectation with what differed', async () => {
    const broken = createMemoryApp();
    const app = (context: Parameters<typeof broken>[0]) => {
      const made = broken(context) as Awaited<ReturnType<typeof broken>>;
      // An app whose import loses the data.
      return { ...made, adapter: { ...made.adapter, importSnapshot: async () => undefined } };
    };
    const handoff = syncScenarios.find((s) => s.id === 'T-SYNC-02');
    await expect(handoff?.run(app)).rejects.toThrow(/Phone B has Phone A's data/);
  });
});

describe('VirtualClock', () => {
  it('fires due timers in time order and moves now()', () => {
    const clock = new VirtualClock('2026-01-01T00:00:00.000Z');
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 200);
    clock.setTimeout(() => fired.push('a'), 100);
    const cancelled = clock.setTimeout(() => fired.push('x'), 50);
    clock.clearTimeout(cancelled);
    clock.advance(150);
    expect(fired).toEqual(['a']);
    expect(clock.now()).toBe('2026-01-01T00:00:00.150Z');
    clock.advance(50);
    expect(fired).toEqual(['a', 'b']);
    expect(clock.pending()).toBe(0);
  });
});
