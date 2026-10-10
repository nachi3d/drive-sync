import { useSyncExternalStore } from 'react';

import type { DriveSync } from './engine';
import type { SyncStatus } from './types';

/** The sync status, re-rendering on every change. */
export function useSyncStatus(sync: DriveSync): SyncStatus {
  return useSyncExternalStore(sync.subscribe, sync.status, sync.status);
}
