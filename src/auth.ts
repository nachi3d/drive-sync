import type { TokenSource } from './drive';

/** A signed-in Google account. */
export interface AuthAccount {
  email: string;
}

/** Google sign-in, abstracted so the engine can be tested without the native module. */
export interface DriveAuth extends TokenSource {
  /** Interactive sign-in asking for drive.appdata; null if the user cancelled. */
  signIn(): Promise<AuthAccount | null>;
  /** Silent sign-in from a previous session; null if there is none. */
  restore(): Promise<AuthAccount | null>;
  signOut(): Promise<void>;
}

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/** Sign-in failed for a reason other than the user cancelling. */
export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}
