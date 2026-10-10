import type { DriveSync } from './engine';

export type AppStateStatusLike = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

/** The part of React Native's AppState used here (injectable for tests). */
export interface AppStateLike {
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatusLike) => void,
  ): { remove(): void };
}

/**
 * Syncs when the app comes to the foreground and flushes pending changes when
 * it goes to the background. Pass React Native's AppState. Returns a detach
 * function. The startup sync is DriveSync.start().
 */
export function attachAppStateTriggers(sync: DriveSync, appState: AppStateLike): () => void {
  const subscription = appState.addEventListener('change', (state) => {
    if (state === 'active') void sync.syncNow();
    else if (state === 'background') void sync.flush();
  });
  return () => subscription.remove();
}
