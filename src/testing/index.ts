import type { AuthAccount, DriveAuth } from '../auth';
import { DriveError, type DriveFile, type DriveStore } from '../drive';
import type { KeyValueStorage, Snapshot, SnapshotEncoding } from '../types';

/**
 * In-memory Drive app folder for tests. Shared by several engines to play
 * several devices. `offline` makes every call fail like a dead network;
 * `beforeCall` runs before each operation (to inject a concurrent write).
 */
export class FakeDrive implements DriveStore {
  files = new Map<string, { name: string; content: Snapshot; modified: number }>();
  offline = false;
  calls: string[] = [];
  beforeCall: ((op: string) => void | Promise<void>) | null = null;
  private nextId = 1;
  private clock = 0;

  private async enter(op: string): Promise<void> {
    this.calls.push(op);
    if (this.beforeCall) await this.beforeCall(op);
    if (this.offline) throw new DriveError('offline', 'Network request failed');
  }

  /** Names of the files, sorted. */
  names(): string[] {
    return [...this.files.values()].map((f) => f.name).sort();
  }

  /** Direct write, bypassing hooks and offline mode (another device's upload). */
  put(name: string, content: Snapshot): DriveFile {
    const existing = [...this.files.entries()].find(([, f]) => f.name === name);
    if (existing) {
      existing[1].content = content;
      existing[1].modified = ++this.clock;
      return { id: existing[0], name };
    }
    const id = `f${this.nextId++}`;
    this.files.set(id, { name, content, modified: ++this.clock });
    return { id, name };
  }

  /** Text content of the newest file with this name. */
  text(name: string): string | null {
    const file = [...this.files.values()]
      .filter((f) => f.name === name)
      .sort((a, b) => b.modified - a.modified)[0];
    return file && typeof file.content === 'string' ? file.content : null;
  }

  async findFile(name: string): Promise<DriveFile | null> {
    await this.enter(`find:${name}`);
    const found = [...this.files.entries()]
      .filter(([, f]) => f.name === name)
      .sort(([, a], [, b]) => b.modified - a.modified)[0];
    return found ? { id: found[0], name } : null;
  }

  async listFiles(prefix: string): Promise<DriveFile[]> {
    await this.enter(`list:${prefix}`);
    return [...this.files.entries()]
      .filter(([, f]) => f.name.startsWith(prefix))
      .map(([id, f]) => ({ id, name: f.name }));
  }

  async createFile(name: string, content: Snapshot): Promise<DriveFile> {
    await this.enter(`create:${name}`);
    const id = `f${this.nextId++}`;
    this.files.set(id, { name, content, modified: ++this.clock });
    return { id, name };
  }

  async updateFile(id: string, content: Snapshot): Promise<void> {
    await this.enter(`update:${id}`);
    const file = this.files.get(id);
    if (!file) throw new DriveError('http', 'Not found', 404);
    file.content = content;
    file.modified = ++this.clock;
  }

  async readFile(id: string, encoding: SnapshotEncoding): Promise<Snapshot> {
    await this.enter(`read:${id}`);
    const file = this.files.get(id);
    if (!file) throw new DriveError('http', 'Not found', 404);
    if (encoding === 'text') {
      return typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content);
    }
    return typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content;
  }

  async deleteFile(id: string): Promise<void> {
    await this.enter(`delete:${id}`);
    this.files.delete(id);
  }
}

/** Signs in as `email` (null = the user cancels). Tokens are fake. */
export class FakeAuth implements DriveAuth {
  signedIn: AuthAccount | null = null;
  calls: string[] = [];

  constructor(public email: string | null = 'reader@example.com') {}

  async signIn(): Promise<AuthAccount | null> {
    this.calls.push('signIn');
    this.signedIn = this.email === null ? null : { email: this.email };
    return this.signedIn;
  }

  async restore(): Promise<AuthAccount | null> {
    this.calls.push('restore');
    return this.signedIn;
  }

  async signOut(): Promise<void> {
    this.calls.push('signOut');
    this.signedIn = null;
  }

  async getAccessToken(): Promise<string> {
    if (this.signedIn === null) throw new DriveError('auth', 'Not signed in');
    return 'token';
  }

  async invalidateToken(): Promise<void> {}
}

/** KeyValueStorage in memory. */
export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}
