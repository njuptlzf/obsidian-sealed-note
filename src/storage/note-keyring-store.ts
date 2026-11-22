/**
 * Keyring WITHOUT a keyring file.
 *
 * There is no keyring.json any more. The wrapped vault key lives in the `keys`
 * field of every .sealed note, and those notes are ordinary vault files that
 * every sync tool handles (unlike `.obsidian/`, which Remotely Save excludes by
 * default and which a plugin reinstall wipes).
 *
 * Consequences of this design:
 *
 *   - no single point of failure: losing one note loses that note, not the key
 *   - no hidden config file, no special sync settings
 *   - unlocking reads the newest key copy from any private note
 *   - changing a credential rewrites only the `keys` field of encrypted notes;
 *     the ciphertext is copied through byte for byte
 *
 * The interface mirrors the old KeyringStore so the service layer does not need
 * to know where the key material actually lives.
 */

import { App, TFile, normalizePath } from "obsidian";
import { KeyCopy, NoteEnvelope, parseNoteEnvelope } from "../core/format";
import {
  KeyringData,
  KeyringSlot,
  SlotId,
  formatKeyringFromCopy,
  keyCopyFromKeyringData,
} from "../core/keyring";
import { SealedNoteStore } from "../storage/sealed-note-store";
import { log } from "../util/log";
import { Err } from "../util/errors";

export interface NoteKeyringSource {
  file: TFile;
  envelope: NoteEnvelope;
  keyCopy: KeyCopy;
}

export class NoteKeyringStore {
  private readonly log = log.child("note-keyring");

  constructor(
    private readonly app: App,
    private readonly notes: SealedNoteStore,
  ) {}

  /* ------------------------------------------------------------------ */
  /* read                                                               */
  /* ------------------------------------------------------------------ */

  /** Every file that carries a key copy, newest generation first. */
  async sources(): Promise<NoteKeyringSource[]> {
    const out: NoteKeyringSource[] = [];
    for (const file of this.app.vault.getFiles()) {
      if (!this.notes.isSealedPath(file.path)) continue;
      try {
        const raw = await this.app.vault.read(file);
        const envelope = parseNoteEnvelope(raw);
        if (!envelope?.keys) continue;
        out.push({ file, envelope, keyCopy: envelope.keys });
      } catch {
        /* unreadable notes are not key sources */
      }
    }
    out.sort((a, b) => b.keyCopy.epoch - a.keyCopy.epoch);
    return out;
  }

  async exists(): Promise<boolean> {
    return (await this.sources()).length > 0;
  }

  /**
   * Load the keyring from the newest key copy found in any note.
   * Returns null when no private notes exist yet (first-run state).
   */
  async load(): Promise<KeyringData | null> {
    const sources = await this.sources();
    if (sources.length === 0) return null;
    const newest = sources[0].keyCopy;
    const kr = formatKeyringFromCopy(newest);
    this.log.info("keyring_loaded_from_note", {
      path: sources[0].file.path,
      epoch: newest.epoch,
      sources: sources.length,
    });
    return kr;
  }

  async require(): Promise<KeyringData> {
    const kr = await this.load();
    if (!kr) throw Err.notInitialized();
    return kr;
  }

  /* ------------------------------------------------------------------ */
  /* write - update the keys field of every note                        */
  /* ------------------------------------------------------------------ */

  /**
   * Persist a keyring by writing its wrapped slots into every note that already
   * carries a key copy. Only the `keys` field changes: salt, iv and ciphertext
   * are copied through unchanged.
   *
   * Idempotent and resumable: a note at the same or newer epoch is skipped.
   */
  async save(keyring: KeyringData, opts: { force?: boolean } = {}): Promise<void> {
    const copy = keyCopyFromKeyringData(keyring);
    const sources = await this.sources();

    let updated = 0;
    let skipped = 0;
    for (const source of sources) {
      // Device-local metadata (the seeded totp.seedRef) can change without an
      // epoch bump: it is not part of the wrapped credential. When force is set
      // we rewrite those copies so a re-import actually persists on this device.
      if (!opts.force && source.keyCopy.epoch >= copy.epoch) {
        skipped++;
        continue;
      }
      try {
        await this.notes.updateKeyCopy(source.file, source.envelope, copy);
        updated++;
      } catch (error) {
        // A failed note is not fatal: the update is idempotent and can be
        // re-run later. Do not abort the rest of the batch.
        this.log.warn("keyring_note_update_failed", {
          path: source.file.path,
          error: String(error),
        });
      }
    }
    this.log.info("keyring_saved_to_notes", { updated, skipped, epoch: keyring.epoch });
  }

  /** Used after a user confirmed a legitimate key rotation / restore. */
  async acknowledgeRollback(_keyring: KeyringData): Promise<void> {
    // No device-side high-water mark in this design: there is no separate file
    // whose rollback could be detected. The newest epoch among notes is the only
    // state we have, and it travels with the notes.
    return;
  }

  async backupCurrent(): Promise<string | null> {
    // Per-note backups are already taken by SealedNoteStore before each write.
    return null;
  }

  /** Kept for API compatibility with the old store; no persistent cache. */
  invalidate(): void {
    return;
  }

  get rollbackWarning(): null {
    return null;
  }

  /** Used during first-run setup: write the initial key copy into the first note. */
  initialCopy(keyring: KeyringData): KeyCopy {
    return keyCopyFromKeyringData(keyring);
  }
}