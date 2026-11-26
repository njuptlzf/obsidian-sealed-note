/**
 * Refresh the key copies embedded in private notes.
 *
 * Called after a password change or recovery-key rotation.
 *
 * Crucially, this does NOT re-encrypt note contents. It rewrites only the
 * `keys` field of the envelope and copies `salt`/`iv`/`data` through verbatim.
 * Consequences:
 *
 *   - 1 PBKDF2 for the password change, then N small AES wraps (not N PBKDF2)
 *   - an interrupted run leaves stale key copies, never corrupted content
 *   - re-running is idempotent: notes already at the current epoch are skipped
 *
 * Only files that are actually encrypted notes (and carry a copy) are touched.
 * Normal markdown files are never opened or modified.
 */

import { App, TFile } from "obsidian";
import { KeyringData, keyCopyFromKeyringData, parseKeyring } from "../core/keyring";
import { keyCopiesEqual, noteBodyState } from "../core/format";
import { SealedNoteStore } from "../storage/sealed-note-store";
import { log } from "../util/log";

export interface RefreshResult {
  /** notes that already had the current key copy */
  current: number;
  /** notes whose key copy was updated */
  updated: number;
  /** notes that failed (kept as-is, safe to retry) */
  failed: number;
  /** sealed notes without a key copy - old-format notes */
  withoutCopy: number;
  failures: string[];
}

export class KeyCopyRefreshService {
  private readonly log = log.child("key-copy-refresh");

  constructor(
    private readonly app: App,
    private readonly notes: SealedNoteStore,
  ) {}

  /**
   * Bring every encrypted note's embedded key copy up to the keyring's epoch.
   * Safe to interrupt and re-run: already-current notes are skipped.
   */
  async refreshAll(
    keyring: KeyringData,
    shouldContinue: () => boolean = () => true,
  ): Promise<RefreshResult> {
    const copy = keyCopyFromKeyringData(keyring);
    const result: RefreshResult = {
      current: 0,
      updated: 0,
      failed: 0,
      withoutCopy: 0,
      failures: [],
    };

    // Only files that look like our notes are considered. Other markdown is
    // never read, let alone written.
    const files = this.app.vault
      .getFiles()
      .filter((f) => this.notes.isKeySourcePath(f.path));

    for (const file of files) {
      if (!shouldContinue()) break;

      try {
        // A locked note's body IS the envelope; unlocked plaintext is not a
        // key source.
        if (this.notes.isSealedPath(file.path)) {
          const noteRaw = await this.app.vault.read(file).catch(() => "");
          if (noteBodyState(noteRaw) !== "sealed") continue;
        }
        const envelope = await this.notes.tryReadEnvelope(file);
        if (!envelope) {
          result.failed++;
          result.failures.push(`${file.path}: 不是有效的加密笔记`);
          continue;
        }
        if (!envelope.keys) {
          // A note from before key copies existed. Leave it alone: it still
          // works via the keyring, and rewriting it is a separate migration.
          result.withoutCopy++;
          continue;
        }
        // Never roll a newer note copy back. Equal epoch does not mean equal
        // content though: older versions dropped the TOTP slot from notes.
        if (envelope.keys.epoch > copy.epoch || keyCopiesEqual(envelope.keys, copy)) {
          result.current++;
          continue;
        }

        await this.notes.updateKeyCopy(file, envelope, copy);
        result.updated++;
        this.log.info("key_copy_refreshed", { path: file.path, from: envelope.keys.epoch, to: copy.epoch });
      } catch (error) {
        result.failed++;
        result.failures.push(`${file.path}: ${String(error)}`);
        this.log.warn("key_copy_refresh_failed", { path: file.path, error: String(error) });
      }
    }

    this.log.info("key_copy_refresh_done", {
      current: result.current,
      updated: result.updated,
      failed: result.failed,
      withoutCopy: result.withoutCopy,
    });
    return result;
  }

  /** How many notes would be changed right now? Cheap preview for the UI. */
  async countStale(keyring: KeyringData): Promise<number> {
    const copy = keyCopyFromKeyringData(keyring);
    let stale = 0;
    for (const file of this.app.vault.getFiles()) {
      if (!this.notes.isKeySourcePath(file.path)) continue;
      try {
        if (this.notes.isSealedPath(file.path)) {
          const noteRaw = await this.app.vault.read(file).catch(() => "");
          if (noteBodyState(noteRaw) !== "sealed") continue;
        }
        const env = await this.notes.tryReadEnvelope(file);
        if (env?.keys && !keyCopiesEqual(env.keys, copy) && env.keys.epoch <= copy.epoch) stale++;
      } catch {
        /* unreadable files will be reported by refreshAll */
      }
    }
    return stale;
  }
}