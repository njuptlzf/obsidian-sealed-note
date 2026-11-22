/**
 * Encryption service: converting between plaintext and payloads.
 *
 * No Obsidian UI here, no editor access. Everything takes/returns strings so it
 * is trivially testable and has exactly one implementation of "encrypt this".
 */

import {
  findFencedBlocks,
  findInlinePayloads,
  openInline,
  openNote,
  parseNoteEnvelope,
  sealInline,
  sealNote,
  wrapFenced,
} from "../core/format";
import { log } from "../util/log";

export interface InlineEncryptResult {
  payload: string;
  /** ready to drop into a note */
  snippet: string;
}

export class EncryptionService {
  private readonly log = log.child("encryption");

  constructor(private readonly vaultId: () => string) {}

  /* ---------------- note level ---------------- */

  async encryptNote(dek: Uint8Array, kid: string, plaintext: string): Promise<string> {
    return sealNote(dek, this.vaultId(), kid, plaintext);
  }

  async decryptNote(dek: Uint8Array, envelopeText: string): Promise<string> {
    const envelope = parseNoteEnvelope(envelopeText);
    if (!envelope) throw new Error("文件不是有效的加密笔记");
    return openNote(dek, this.vaultId(), envelope);
  }

  isEncryptedNote(text: string): boolean {
    return parseNoteEnvelope(text) !== null;
  }

  /* ---------------- inline ---------------- */

  async encryptInline(dek: Uint8Array, plaintext: string, as: "fence" | "inline"): Promise<InlineEncryptResult> {
    const payload = await sealInline(dek, this.vaultId(), plaintext);
    return {
      payload,
      snippet: as === "fence" ? wrapFenced(payload) : "`" + payload + "`",
    };
  }

  async decryptInline(dek: Uint8Array, payload: string): Promise<string> {
    return openInline(dek, this.vaultId(), payload);
  }

  /**
   * Decrypt every encrypted block/payload in a document.
   * Returns the rewritten text and a count, so the caller can report honestly.
   *
   * Two passes because fences and inline payloads need different regexes. Going
   * back to front keeps earlier offsets valid. A fence that failed to decrypt is
   * replaced by a sentinel before the inline pass so the inline scanner cannot
   * count the same payload a second time.
   */
  async decryptAll(
    dek: Uint8Array,
    source: string,
  ): Promise<{ text: string; fenced: number; inline: number; failed: number }> {
    let text = source;
    let failed = 0;

    const fences = findFencedBlocks(text);
    for (const block of [...fences].sort((a, b) => b.start - a.start)) {
      try {
        if (!block.payload.startsWith("sn1.")) {
          failed++;
          continue;
        }
        const plain = await openInline(dek, this.vaultId(), block.payload);
        text = text.slice(0, block.start) + plain + text.slice(block.end);
      } catch {
        failed++;
        // Keep the block byte for byte: a failed decrypt must never destroy data
        // the user may still be able to open elsewhere. Bracketing it keeps the
        // inline pass from re-discovering the same payload.
        const kept = text.slice(block.start, block.end);
        text = text.slice(0, block.start) + "\u0000" + kept + "\u0000" + text.slice(block.end);
      }
    }

    // Inline scan must ignore anything already handled (fences, successful or
    // not), otherwise failed fences get counted twice.
    const inlineHits = findInlinePayloads(text).filter(
      (item) => !this.insideMarker(text, item.start),
    );
    for (const item of [...inlineHits].sort((a, b) => b.start - a.start)) {
      try {
        const plain = await openInline(dek, this.vaultId(), item.payload);
        text = text.slice(0, item.start) + plain + text.slice(item.end);
      } catch {
        failed++;
      }
    }

    // Drop the sentinels we added, leaving the original ciphertext untouched.
    text = text.replace(/\u0000/g, "");

    this.log.info("decrypt_all", { fenced: fences.length, inline: inlineHits.length, failed });
    return { text, fenced: fences.length, inline: inlineHits.length, failed };
  }

  /** Is this offset inside a region already processed by the fence pass? */
  private insideMarker(text: string, offset: number): boolean {
    const before = text.lastIndexOf("\u0000", offset);
    if (before < 0) return false;
    const after = text.indexOf("\u0000", before + 1);
    return after > offset;
  }

  countEncrypted(source: string): { fenced: number; inline: number } {
    return {
      fenced: findFencedBlocks(source).length,
      inline: findInlinePayloads(source).length,
    };
  }
}