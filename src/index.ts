import { AppState } from 'react-native';

import { createRestDrive } from './drive';
import { createSyncEngine, type DriveSync, type SyncEngineOptions } from './engine';
import { createGoogleAuth } from './google';
import { attachAppStateTriggers } from './triggers';

export * from './types';
export { AuthError, DRIVE_APPDATA_SCOPE, type AuthAccount, type DriveAuth } from './auth';
export { decide, type Decision, type DecideInput } from './decide';
export {
  createRestDrive,
  DriveError,
  metaFileName,
  snapshotFileName,
  type DriveFile,
  type DriveStore,
  type TokenSource,
} from './drive';
export {
  createSyncEngine,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_KEEP_SNAPSHOTS,
  type ConnectOptions,
  type DriveSync,
  type PeekResult,
  type SyncEngineOptions,
  type Timers,
} from './engine';
export { createGoogleAuth, type GoogleAuthOptions } from './google';
export { useSyncStatus } from './react';
export { attachAppStateTriggers, type AppStateLike } from './triggers';

export interface DriveSyncOptions extends Omit<SyncEngineOptions, 'auth' | 'drive'> {
  /** OAuth "Web application" client ID (public). */
  webClientId: string;
}

/**
 * The usual setup: Google sign-in + Drive REST + foreground/background
 * triggers. Call start() once the app's data is ready.
 */
export function createDriveSync({ webClientId, ...options }: DriveSyncOptions): DriveSync {
  const auth = createGoogleAuth({ webClientId });
  const sync = createSyncEngine({ ...options, auth, drive: createRestDrive(auth) });
  const detach = attachAppStateTriggers(sync, AppState);
  return {
    ...sync,
    dispose() {
      detach();
      sync.dispose();
    },
  };
}
