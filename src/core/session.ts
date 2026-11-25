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

export interface SessionEntry {
  dek: Uint8Array;
  filePath: string;
  providerId: string;
  /**
   * Key copy captured at unlock time. In the single-file layout an unlocked
   * note's body is plaintext, so the vault key copy is no longer on disk while
   * the note is open. Locking this very note must still be able to write the
   * `keys` field back, hence the in-memory copy for the session's lifetime.
   */
  keyring?: import("./keyring").KeyringData;
}

export class SessionStore {
  private readonly entries = new Map<string, SessionEntry>();

  /**
   * Store a COPY of the DEK. Callers (unlock service, tests) keep using the
   * same array after put(); lock() wipes the buffer in place as a hygiene
   * measure, so storing a borrowed reference would silently zero the caller's
   * key material.
   */
  put(
    filePath: string,
    dek: Uint8Array,
    providerId: string,
    keyring?: import("./keyring").KeyringData,
  ): void {
    this.entries.set(filePath, { dek: dek.slice(0), filePath, providerId, keyring });
  }

  get(filePath: string): SessionEntry | null {
    return this.entries.get(filePath) ?? null;
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