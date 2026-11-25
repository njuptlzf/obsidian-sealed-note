/**
 * Recover a note whose sealed-note:ref annotation was deleted.
 *
 * The annotation is the only pointer from a .sealed.md note to its payload. If
 * it is removed, the ciphertext still lives in sealed-data/ and its key copy
 * still carries a recovery-wrapped DEK. This service can enumerate every
 * payload, open it with the recovery key, and let the user pick the one that
 * belongs to the damaged note. Restoring creates a NEW id, re-seals the
 * plaintext with the same key copy, and writes a fresh annotation. The old
 * payload is intentionally kept - the whole operation is additive only.
 *
 * No Obsidian UI and no DOM here; everything is strings and buffers.
 */

import { App, TFile } from "obsidian";
import { KeyCopy, NoteEnvelope, openNote, parseNoteEnvelope, sealNote } from "../core/format";
import { formatKeyringFromCopy, unlockWithRecovery } from "../core/keyring";
import { randomUuid } from "../core/crypto";
import { log } from "../util/log";
import { Err } from "../util/errors";
import type { SealedNoteStore } from "../storage/sealed-note-store";

export interface RestoreCandidate {
  /** ref id (payload file name without extension) */
  ref: string;
  /** first non-empty line of the decrypted note, for the picker */
  title: string;
  /** short decrypted preview */
  preview: string;
  /** decrypted DEK, reused when re-sealing */
  dek: Uint8Array;
  envelope: NoteEnvelope;
}

export class RestoreService {
  private readonly log = log.child("restore");

  constructor(
    private readonly app: App,
    private readonly notes: SealedNoteStore,
  ) {}

  /**
   * Open every payload we can with the recovery key. Payloads that fail
   * (wrong key, damaged, no recovery slot) are skipped and counted.
   */
  async collectCandidates(recovery: string): Promise<{ candidates: RestoreCandidate[]; skipped: number }> {
    const candidates: RestoreCandidate[] = [];
    let skipped = 0;
    for (const file of this.app.vault.getFiles()) {
      if (!this.notes.isPayloadPath(file.path)) continue;
      try {
        const raw = await this.app.vault.read(file);
        const envelope = parseNoteEnvelope(raw);
        if (!envelope?.keys) {
          skipped++;
          continue;
        }
        const kr = formatKeyringFromCopy(envelope.keys);
        const dek = await unlockWithRecovery(kr, recovery);
        const plain = await openNote(dek, kr.vaultId, envelope);
        const lines = plain.split("\n").map((l) => l.trim()).filter(Boolean);
        candidates.push({
          ref: file.path.split("/").pop()!.replace(/\.[^.]+$/, ""),
          title: lines[0]?.replace(/^#+\s*/, "").slice(0, 80) || tUntitled(),
          preview: lines.slice(0, 3).join(" ").slice(0, 160),
          dek,
          envelope,
        });
      } catch {
        skipped++;
      }
    }
    candidates.sort((a, b) => a.title.localeCompare(b.title));
    this.log.info("restore_candidates", { found: candidates.length, skipped });
    return { candidates, skipped };
  }

  /**
   * Write the chosen plaintext back into a note that lost its annotation:
   * a new ref, a freshly sealed payload reusing the original key copy, and a
   * new annotation. The OLD payload is intentionally left in place.
   */
  async restore(noteFile: TFile, candidate: RestoreCandidate): Promise<{ newRef: string; vaultId: string }> {
    if (!this.notes.isSealedPath(noteFile.path)) throw Err.io("目标不是隐私笔记");
    const keyCopy: KeyCopy | undefined = candidate.envelope.keys;
    const vaultId = keyCopy?.vaultId ?? "";
    if (!vaultId || !keyCopy) throw Err.io("候选密文缺少密钥副本");

    const plain = await openNote(candidate.dek, vaultId, candidate.envelope);
    const kid = candidate.envelope.kid || vaultId;
    const sealed = parseNoteEnvelope(await sealNote(candidate.dek, vaultId, kid, plain, keyCopy));
    if (!sealed) throw Err.io("重新加密失败");
    const newRef = randomUuid();

    // Write the new payload first, then the annotation: a failed note write
    // leaves an orphan payload (recoverable), never a ref pointing at nothing.
    await this.notes.createPayload(newRef, JSON.stringify(sealed, null, 2) + "\n");
    await this.app.vault.adapter.write(noteFile.path, this.notes.placeholderWithRef(newRef));
    this.log.info("annotation_restored", { note: noteFile.path, newRef, from: candidate.ref });
    return { newRef, vaultId };
  }
}

/** Avoid importing i18n into a service; fallback label only. */
function tUntitled(): string {
  return "(untitled)";
}
