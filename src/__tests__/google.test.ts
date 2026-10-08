import { DRIVE_APPDATA_SCOPE } from '../auth';

const mockLoads = { count: 0 };

const user = (scopes: string[]) => ({
  type: 'success' as const,
  data: {
    user: { id: '1', name: null, email: 'reader@example.com', photo: null, familyName: null, givenName: null },
    scopes,
    idToken: null,
    serverAuthCode: null,
  },
});

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(async () => true),
  signIn: jest.fn(async () => user([DRIVE_APPDATA_SCOPE]) as unknown),
  addScopes: jest.fn(async () => null as unknown),
  signInSilently: jest.fn(async () => user([DRIVE_APPDATA_SCOPE]) as unknown),
  signOut: jest.fn(async () => null),
  getCurrentUser: jest.fn(() => null as unknown),
  getTokens: jest.fn(async () => ({ idToken: 'id', accessToken: 'access' })),
  clearCachedAccessToken: jest.fn(async () => null),
};

jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }), {
  virtual: true,
});

jest.mock('@react-native-google-signin/google-signin', () => {
  mockLoads.count++;
  return {
    GoogleSignin: mockGoogleSignin,
    statusCodes: { SIGN_IN_CANCELLED: '12501', SIGN_IN_REQUIRED: '4' },
    isErrorWithCode: (e: unknown) => typeof e === 'object' && e !== null && 'code' in e,
  };
});

beforeEach(() => jest.clearAllMocks());

describe('google sign-in loading', () => {
  it('importing the package does not load the native module (Expo Go)', () => {
    jest.isolateModules(() => {
      mockLoads.count = 0;
      require('../index');
      expect(mockLoads.count).toBe(0);
    });
  });
});

describe('createGoogleAuth', () => {
  // Required after the mocks are set up.
  const { createGoogleAuth } = require('../google') as typeof import('../google');

  it('asks for drive.appdata only, with the web client ID', () => {
    createGoogleAuth({ webClientId: 'web-id' });
    expect(mockGoogleSignin.configure).toHaveBeenCalledWith({
      webClientId: 'web-id',
      scopes: [DRIVE_APPDATA_SCOPE],
      offlineAccess: false,
    });
  });

  it('returns the account email, or null when cancelled', async () => {
    const auth = createGoogleAuth({ webClientId: 'web-id' });
    expect(await auth.signIn()).toEqual({ email: 'reader@example.com' });
    mockGoogleSignin.signIn.mockResolvedValueOnce({ type: 'cancelled', data: null });
    expect(await auth.signIn()).toBeNull();
  });

  it('asks again for Drive when the user unticked it, and fails if still refused', async () => {
    const auth = createGoogleAuth({ webClientId: 'web-id' });
    mockGoogleSignin.signIn.mockResolvedValueOnce(user([]));
    mockGoogleSignin.addScopes.mockResolvedValueOnce(user([DRIVE_APPDATA_SCOPE]));
    expect(await auth.signIn()).toEqual({ email: 'reader@example.com' });

    mockGoogleSignin.signIn.mockResolvedValueOnce(user([]));
    mockGoogleSignin.addScopes.mockResolvedValueOnce(null);
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'scope_denied' });
    expect(mockGoogleSignin.signOut).toHaveBeenCalled();
  });

  it('reports a sign-in error with its code', async () => {
    const auth = createGoogleAuth({ webClientId: 'web-id' });
    mockGoogleSignin.signIn.mockRejectedValueOnce(Object.assign(new Error('DEVELOPER_ERROR'), { code: '10' }));
    await expect(auth.signIn()).rejects.toMatchObject({ name: 'AuthError', code: '10' });
  });

  it('signs in silently before getting a token', async () => {
    const auth = createGoogleAuth({ webClientId: 'web-id' });
    expect(await auth.getAccessToken()).toBe('access');
    expect(mockGoogleSignin.signInSilently).toHaveBeenCalled();
  });

  it('turns a missing session into a Drive auth error', async () => {
    const auth = createGoogleAuth({ webClientId: 'web-id' });
    mockGoogleSignin.signInSilently.mockResolvedValueOnce({ type: 'noSavedCredentialFound', data: null });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ kind: 'auth' });
  });
});
