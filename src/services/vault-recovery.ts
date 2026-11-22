/**
 * Rebuild a lost keyring from a note that carries a key copy.
 *
 * The scenario this exists for is mundane, not exotic: `.obsidian/` excluded
 * from the sync tool, or the plugin reinstalled, and suddenly 200 notes are
 * noise. Because every note embeds a wrapped copy of the same vault key, any one
 * of them is enough.
 *
 * Nothing is invented here - we copy the wrapped slots verbatim and then verify
 * that the user's secret actually unwraps the DEK before declaring success.
 */

import { App, TFile, normalizePath } from "obsidian";
import { KeyCopy, NoteEnvelope, parseNoteEnvelope } from "../core/format";
import { KeyringData, KeyringSlot, SlotId, parseKeyring, unlockWithRecovery, unlockWithPassword } from "../core/keyring";
import { FORMAT_KEYRING } from "../core/format";
import { log } from "../util/log";
import { Err } from "../util/errors";

export interface RecoveryCandidate {
  file: TFile;
  envelope: NoteEnvelope;
  keyCopy: KeyCopy;
}

export interface RecoveryResult {
  keyring: KeyringData;
  /** the note we recovered from */
  source: string;
  /** vault id taken from the key copy */
  vaultId: string;
  /** which slot the supplied secret matched */
  slot: string;
}

export class VaultRecoveryService {
  private readonly log = log.child("recovery-service");

  constructor(
    private readonly app: App,
    private readonly notes: import("../storage/sealed-note-store").SealedNoteStore,
  ) {}

  /** Find every sealed note that carries a key copy, newest epoch first. */
  async findCandidates(): Promise<RecoveryCandidate[]> {
    const files = this.app.vault.getFiles();
    const out: RecoveryCandidate[] = [];

    for (const file of files) {
      // file.extension is "md" for a compound ".sealed.md" name, so use the
      // full path (the store owns this rule).
      if (!this.notes.isSealedPath(file.path)) continue;
      try {
        const raw = await this.app.vault.read(file);
        const envelope = parseNoteEnvelope(raw);
        if (!envelope?.keys) continue;
        out.push({ file, envelope, keyCopy: envelope.keys });
      } catch {
        // An unreadable file is not a recovery candidate; keep looking.
      }
    }

    out.sort((a, b) => b.keyCopy.epoch - a.keyCopy.epoch);
    this.log.info("recovery_candidates", { count: out.length });
    return out;
  }

  /**
   * Turn a note's key copy back into a keyring, verifying the supplied secret
   * against it first. A wrong secret must fail here, loudly, before we write
   * anything.
   */
  async rebuild(
    candidate: RecoveryCandidate,
    secret: string,
  ): Promise<RecoveryResult> {
    const copy = candidate.keyCopy;
    const slots: Partial<Record<SlotId, KeyringSlot>> = {};

    for (const [name, cell] of Object.entries(copy.slots)) {
      slots[name as SlotId] = {
        gen: cell.gen,
        salt: cell.salt,
        wrap: cell.wrap,
        updatedAt: new Date().toISOString(),
      };
    }

    const keyring: KeyringData = {
      format: FORMAT_KEYRING,
      vaultId: copy.vaultId,
      kdf: { hash: copy.kdf.hash as "SHA-256" | "SHA-512", iterations: copy.kdf.iterations },
      epoch: copy.epoch,
      slots,
      totp: { enabled: false, digits: 6, period: 30, mode: "password" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      guard: { failCount: 0, lockedUntil: null },
    };

    // Prove the rebuild is usable before we let the caller persist it.
    const matched = await this.tryUnlock(keyring, secret);
    this.log.info("recovery_rebuilt", {
      source: candidate.file.path,
      epoch: copy.epoch,
      slot: matched,
    });

    return { keyring, source: candidate.file.path, vaultId: copy.vaultId, slot: matched };
  }

  private async tryUnlock(keyring: KeyringData, secret: string): Promise<string> {
    // Try recovery formatting first (the literal secret we hand the user), then
    // the password slot. Both are cheap enough to attempt on a single note.
    if (keyring.slots.recovery) {
      try {
        await unlockWithRecovery(keyring, secret);
        return "recovery";
      } catch {
        /* try the next slot */
      }
    }
    if (keyring.slots.password) {
      try {
        await unlockWithPassword(keyring, secret);
        return "password";
      } catch {
        /* fall through */
      }
    }
    throw Err.wrongSecret();
  }

  /** Validate an existing keyring file against a candidate, to pick the right one. */
  async describeCandidate(candidate: RecoveryCandidate): Promise<string> {
    const slots = Object.keys(candidate.keyCopy.slots);
    return `${candidate.file.path}（第 ${candidate.keyCopy.epoch} 代，含 ${slots.join(" / ")} 槽）`;
  }

  static isKeyringPath(path: string): boolean {
    return normalizePath(path).endsWith("/keyring.json");
  }

  static parseExistingKeyring(raw: string): KeyringData {
    return parseKeyring(raw);
  }
}