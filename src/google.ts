import { GoogleSignin, isErrorWithCode, statusCodes } from '@react-native-google-signin/google-signin';

import { AuthError, DRIVE_APPDATA_SCOPE, type AuthAccount, type DriveAuth } from './auth';
import { DriveError } from './drive';

export interface GoogleAuthOptions {
  /**
   * OAuth client ID of type "Web application" from the Google Cloud project
   * (public). The Android client (package + signing SHA-1) only has to exist.
   */
  webClientId: string;
}

function toAuthError(error: unknown): AuthError {
  if (isErrorWithCode(error)) return new AuthError(error.code, error.message);
  return new AuthError('unknown', error instanceof Error ? error.message : String(error));
}

/** DriveAuth on @react-native-google-signin/google-signin, scope drive.appdata only. */
export function createGoogleAuth({ webClientId }: GoogleAuthOptions): DriveAuth {
  GoogleSignin.configure({ webClientId, scopes: [DRIVE_APPDATA_SCOPE], offlineAccess: false });

  async function ensureScope(scopes: string[]): Promise<boolean> {
    if (scopes.includes(DRIVE_APPDATA_SCOPE)) return true;
    // The user unticked Drive on the consent screen: ask once more.
    const added = await GoogleSignin.addScopes({ scopes: [DRIVE_APPDATA_SCOPE] });
    return added?.type === 'success' && added.data.scopes.includes(DRIVE_APPDATA_SCOPE);
  }

  return {
    async signIn(): Promise<AuthAccount | null> {
      try {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const response = await GoogleSignin.signIn();
        if (response.type !== 'success') return null;
        if (!(await ensureScope(response.data.scopes))) {
          await GoogleSignin.signOut();
          throw new AuthError('scope_denied', 'Google Drive access was not granted');
        }
        return { email: response.data.user.email };
      } catch (error) {
        if (isErrorWithCode(error) && error.code === statusCodes.SIGN_IN_CANCELLED) return null;
        if (error instanceof AuthError) throw error;
        throw toAuthError(error);
      }
    },

    async restore(): Promise<AuthAccount | null> {
      try {
        const response = await GoogleSignin.signInSilently();
        return response.type === 'success' ? { email: response.data.user.email } : null;
      } catch (error) {
        throw toAuthError(error);
      }
    },

    async signOut(): Promise<void> {
      await GoogleSignin.signOut();
    },

    async getAccessToken(): Promise<string> {
      try {
        if (GoogleSignin.getCurrentUser() === null) {
          const response = await GoogleSignin.signInSilently();
          if (response.type !== 'success') throw new DriveError('auth', 'Not signed in to Google');
        }
        return (await GoogleSignin.getTokens()).accessToken;
      } catch (error) {
        if (error instanceof DriveError) throw error;
        if (isErrorWithCode(error) && error.code === statusCodes.SIGN_IN_REQUIRED) {
          throw new DriveError('auth', 'Google sign-in required');
        }
        // Play services report a missing network as an error code; treat as offline.
        if (isErrorWithCode(error) && /network/i.test(`${error.code} ${error.message}`)) {
          throw new DriveError('offline', error.message);
        }
        throw new DriveError('auth', error instanceof Error ? error.message : String(error));
      }
    },

    async invalidateToken(token: string): Promise<void> {
      await GoogleSignin.clearCachedAccessToken(token);
    },
  };
}
