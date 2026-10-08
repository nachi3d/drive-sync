import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { createSyncEngine, type DriveSync } from '../engine';
import { useSyncStatus } from '../react';
import { createMemoryStorage, FakeAuth, FakeDrive } from '../testing';
import { attachAppStateTriggers, type AppStateLike, type AppStateStatusLike } from '../triggers';
import type { SyncAdapter } from '../types';

function fakeAppState() {
  let listener: ((state: AppStateStatusLike) => void) | null = null;
  const appState: AppStateLike = {
    addEventListener(_type, fn) {
      listener = fn;
      return {
        remove: () => {
          listener = null;
        },
      };
    },
  };
  return {
    appState,
    emit: (state: AppStateStatusLike) => listener?.(state),
    attached: () => listener !== null,
  };
}

function fakeSync() {
  const calls: string[] = [];
  const sync = {
    syncNow: async () => {
      calls.push('syncNow');
      return 'unchanged' as const;
    },
    flush: async () => {
      calls.push('flush');
      return 'unchanged' as const;
    },
  } as unknown as DriveSync;
  return { sync, calls };
}

describe('attachAppStateTriggers', () => {
  it('syncs on foreground and flushes on background', () => {
    const { appState, emit } = fakeAppState();
    const { sync, calls } = fakeSync();
    attachAppStateTriggers(sync, appState);

    emit('active');
    emit('inactive');
    emit('background');
    expect(calls).toEqual(['syncNow', 'flush']);
  });

  it('detaches', () => {
    const { appState, attached } = fakeAppState();
    const detach = attachAppStateTriggers(fakeSync().sync, appState);
    expect(attached()).toBe(true);
    detach();
    expect(attached()).toBe(false);
  });
});

describe('useSyncStatus', () => {
  it('renders the current status', async () => {
    const adapter: SyncAdapter = {
      appId: 'app',
      deviceName: 'Phone',
      appVersion: '1.0.0',
      schemaVersion: 1,
      exportSnapshot: async () => 'data',
      importSnapshot: async () => undefined,
      isDirtySince: () => true,
      markSynced: () => undefined,
    };
    const sync = createSyncEngine({
      adapter,
      auth: new FakeAuth(),
      drive: new FakeDrive(),
      storage: createMemoryStorage(),
    });
    await sync.connect({ sync: false });

    function Status() {
      const status = useSyncStatus(sync);
      return createElement('span', null, `${status.phase} ${status.account ?? ''}`);
    }
    expect(renderToStaticMarkup(createElement(Status))).toBe('<span>idle reader@example.com</span>');
    sync.dispose();
  });
});
