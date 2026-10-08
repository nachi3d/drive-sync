import { createRestDrive, DriveError, parseMeta, snapshotRev, type TokenSource } from '../drive';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected request ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchFn };
}

function tokens(): TokenSource & { invalidated: string[] } {
  let n = 0;
  const invalidated: string[] = [];
  return {
    invalidated,
    getAccessToken: async () => `token-${++n}`,
    invalidateToken: async (token) => {
      invalidated.push(token);
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createRestDrive', () => {
  it('finds a file by exact name in the app folder, with a bearer token', async () => {
    const { calls, fetchFn } = fakeFetch([json({ files: [{ id: 'm1', name: 'app.meta.json' }] })]);
    const drive = createRestDrive(tokens(), fetchFn);

    expect(await drive.findFile("app.meta.json")).toEqual({ id: 'm1', name: 'app.meta.json' });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(url.searchParams.get('spaces')).toBe('appDataFolder');
    expect(url.searchParams.get('q')).toBe("name = 'app.meta.json' and trashed = false");
    expect(url.searchParams.get('orderBy')).toBe('modifiedTime desc');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer token-1');
  });

  it('escapes quotes in queries', async () => {
    const { calls, fetchFn } = fakeFetch([json({ files: [] })]);
    await createRestDrive(tokens(), fetchFn).findFile("it's");
    expect(new URL(calls[0]?.url ?? '').searchParams.get('q')).toBe("name = 'it\\'s' and trashed = false");
  });

  it('lists every page and keeps exact prefix matches only', async () => {
    const { calls, fetchFn } = fakeFetch([
      json({ files: [{ id: 'a', name: 'app.snapshot-1.json' }], nextPageToken: 'p2' }),
      json({ files: [{ id: 'b', name: 'app.snapshot-2.json' }, { id: 'c', name: 'other app.snapshot-1.json' }] }),
    ]);
    const files = await createRestDrive(tokens(), fetchFn).listFiles('app.snapshot-');
    expect(files.map((f) => f.id)).toEqual(['a', 'b']);
    expect(new URL(calls[1]?.url ?? '').searchParams.get('pageToken')).toBe('p2');
  });

  it('creates a file in appDataFolder then uploads its content', async () => {
    const { calls, fetchFn } = fakeFetch([json({ id: 'new', name: 'app.snapshot-1.json' }), json({})]);
    const file = await createRestDrive(tokens(), fetchFn).createFile('app.snapshot-1.json', '{"a":1}');

    expect(file).toEqual({ id: 'new', name: 'app.snapshot-1.json' });
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ name: 'app.snapshot-1.json', parents: ['appDataFolder'] });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: 'https://www.googleapis.com/upload/drive/v3/files/new?uploadType=media',
      body: '{"a":1}',
    });
    expect(calls[1]?.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('uploads binary snapshots as octet-stream', async () => {
    const { calls, fetchFn } = fakeFetch([json({})]);
    await createRestDrive(tokens(), fetchFn).updateFile('f', new Uint8Array([1, 2, 3]));
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(calls[0]?.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('deletes the empty file when the content upload fails', async () => {
    const { calls, fetchFn } = fakeFetch([
      json({ id: 'new', name: 'x' }),
      new Response('boom', { status: 500 }),
      new Response(null, { status: 204 }),
    ]);
    await expect(createRestDrive(tokens(), fetchFn).createFile('x', 'data')).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
    expect(calls[2]).toMatchObject({ method: 'DELETE', url: 'https://www.googleapis.com/drive/v3/files/new' });
  });

  it('downloads text or bytes', async () => {
    const { fetchFn } = fakeFetch([new Response('hello'), new Response(new Uint8Array([7, 8]))]);
    const drive = createRestDrive(tokens(), fetchFn);
    expect(await drive.readFile('t', 'text')).toBe('hello');
    expect(await drive.readFile('b', 'binary')).toEqual(new Uint8Array([7, 8]));
  });

  it('ignores 404 on delete', async () => {
    const { fetchFn } = fakeFetch([new Response('gone', { status: 404 })]);
    await expect(createRestDrive(tokens(), fetchFn).deleteFile('x')).resolves.toBeUndefined();
  });

  it('refreshes the token once on 401', async () => {
    const source = tokens();
    const { calls, fetchFn } = fakeFetch([new Response('', { status: 401 }), json({ files: [] })]);
    await createRestDrive(source, fetchFn).findFile('x');
    expect(source.invalidated).toEqual(['token-1']);
    expect(calls[1]?.headers.get('Authorization')).toBe('Bearer token-2');
  });

  it('reports a second 401 or a 403 as an auth error', async () => {
    const { fetchFn } = fakeFetch([new Response('', { status: 401 }), new Response('', { status: 401 })]);
    await expect(createRestDrive(tokens(), fetchFn).findFile('x')).rejects.toMatchObject({ kind: 'auth' });
    const second = fakeFetch([new Response('', { status: 403 })]);
    await expect(createRestDrive(tokens(), second.fetchFn).findFile('x')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('reports a network failure as offline', async () => {
    const { fetchFn } = fakeFetch([new TypeError('Network request failed')]);
    const error: unknown = await createRestDrive(tokens(), fetchFn)
      .findFile('x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriveError);
    expect(error).toMatchObject({ kind: 'offline' });
  });
});

describe('snapshotRev', () => {
  it('reads the rev from a snapshot name of this app only', () => {
    expect(snapshotRev('app', 'app.snapshot-12.json')).toBe(12);
    expect(snapshotRev('app', 'app.snapshot-x.json')).toBeNull();
    expect(snapshotRev('app', 'other.snapshot-1.json')).toBeNull();
    expect(snapshotRev('app', 'app.meta.json')).toBeNull();
  });
});

describe('parseMeta', () => {
  const valid = {
    format: 'drive-sync-meta',
    appId: 'app',
    rev: 3,
    deviceId: 'd',
    deviceName: 'Phone',
    savedAt: '2026-10-08T10:00:00.000Z',
    appVersion: '1.0.0',
    schemaVersion: 2,
    snapshotFileId: 's',
    encoding: 'text',
  };

  it('accepts a valid meta', () => {
    expect(parseMeta(JSON.stringify(valid), 'app')).toEqual(valid);
  });

  it.each([
    ['not JSON', '{'],
    ['another app', JSON.stringify({ ...valid, appId: 'other' })],
    ['a bad rev', JSON.stringify({ ...valid, rev: 0 })],
    ['a missing field', JSON.stringify({ ...valid, snapshotFileId: undefined })],
    ['a bad encoding', JSON.stringify({ ...valid, encoding: 'zip' })],
  ])('rejects %s', (_label, text) => {
    expect(() => parseMeta(text, 'app')).toThrow(DriveError);
  });
});
