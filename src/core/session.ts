/**
 * In memory unlock sessions.
 *
 * Rules taken straight from the PRD:
 *   - opening an encrypted note always asks for the secret
 *   - switching away locks it again, so switching back asks again
 *   - nothing derived from the plaintext is written anywhere
 *
 * The DEK is kept as raw bytes only for the duration of a session. On lock we
 * overwrite the buffer before dropping it, which is best effort (JS strings and
 * copies cannot be scrubbed) but removes the obvious long lived copy.
 */

export interface SessionOptions {
  /** ms of idle tolerance before auto lock; 0 means lock the moment you leave */
  keepMs: number;
}

export interface SessionEntry {
  dek: Uint8Array;
  filePath: string;
  providerId: string;
  unlockedAt: number;
  lastUsedAt: number;
}

export class SessionStore {
  private readonly entries = new Map<string, SessionEntry>();
  private options: SessionOptions = { keepMs: 0 };

  constructor(options: SessionOptions = { keepMs: 0 }) {
    this.options = options;
  }

  setOptions(options: Partial<SessionOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.options.keepMs === 0) return;
  }

  get keepMs(): number {
    return this.options.keepMs;
  }

  put(filePath: string, dek: Uint8Array, providerId: string): void {
    this.entries.set(filePath, {
      dek,
      filePath,
      providerId,
      unlockedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
  }

  get(filePath: string): SessionEntry | null {
    const entry = this.entries.get(filePath);
    if (!entry) return null;
    if (this.options.keepMs > 0 && Date.now() - entry.lastUsedAt > this.options.keepMs) {
      this.lock(filePath);
      return null;
    }
    entry.lastUsedAt = Date.now();
    return entry;
  }

  has(filePath: string): boolean {
    return this.get(filePath) !== null;
  }

  lock(filePath: string): boolean {
    const entry = this.entries.get(filePath);
    if (!entry) return false;
    wipe(entry.dek);
    this.entries.delete(filePath);
    return true;
  }

  lockAll(): number {
    const count = this.entries.size;
    for (const key of [...this.entries.keys()]) this.lock(key);
    return count;
  }

  /** Lock everything except one path - used when the active leaf changes. */
  lockExcept(filePath: string | null): string[] {
    if (this.options.keepMs > 0) return [];
    const locked: string[] = [];
    for (const key of [...this.entries.keys()]) {
      if (key === filePath) continue;
      if (this.lock(key)) locked.push(key);
    }
    return locked;
  }

  unlockedPaths(): string[] {
    return [...this.entries.keys()].filter((p) => this.get(p) !== null);
  }

  get size(): number {
    return this.entries.size;
  }
}

export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}