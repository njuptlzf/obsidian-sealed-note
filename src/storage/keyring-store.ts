/**
 * Vault storage for the keyring.
 *
 * The keyring is a single small file in the plugin directory, deliberately NOT
 * a note: it must not be indexed, must not show up in search, and must be
 * written atomically.
 *
 * Atomic write = write to a temp file, then rename over the target. A crash
 * therefore leaves either the old or the new keyring, never half of one. Since
 * a half written keyring would strand every private note, this matters.
 */

import { App, normalizePath } from "obsidian";
import { KeyringData, parseKeyring, serializeKeyring, EpochStore, checkEpoch, recordEpoch } from "../core/keyring";
import { log } from "../util/log";
import { Err } from "../util/errors";

export class KeyringStore implements EpochStore {
  private readonly log = log.child("keyring-store");
  private cache: KeyringData | null = null;
  private lastRollback: { fileEpoch: number; deviceEpoch: number; detectedAt: string } | null = null;

  constructor(
    private readonly app: App,
    private readonly dir: string,
    private readonly vaultName: string,
  ) {}

  get keyringPath(): string {
    return normalizePath(`${this.dir}/keyring.json`);
  }

  get epochPath(): string {
    return normalizePath(`${this.dir}/device-epoch.json`);
  }

  /* ---------------- epoch (device local, not synced with the keyring) ------- */

  read(vaultId: string): number | null {
    try {
      const raw = window.localStorage.getItem(this.epochKey(vaultId));
      if (!raw) return null;
      const value = Number.parseInt(raw, 10);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  write(vaultId: string, epoch: number): void {
    try {
      window.localStorage.setItem(this.epochKey(vaultId), String(epoch));
    } catch {
      /* storage full or disabled: rollback protection degrades, nothing breaks */
    }
  }

  private epochKey(vaultId: string): string {
    return `sealed-note:epoch:${this.vaultName}:${vaultId}`;
  }

  /* ---------------- read / write ------------------------------------------ */

  async exists(): Promise<boolean> {
    return this.app.vault.adapter.exists(this.keyringPath);
  }

  /**
   * Load the keyring.
   *
   * Rollback handling is deliberately NOT "throw and refuse to work". Refusing
   * to load would lock the user out of their own notes, and the most common
   * cause of an epoch regression is innocent: two devices syncing, one of them
   * pushing a keyring the other had already superseded. A hostile rollback is
   * possible too, but an attacker who can rewrite files in the vault can do far
   * worse than this check, so refusing to work buys almost nothing and costs
   * everything when it fires on a sync hiccup.
   *
   * What we do instead: keep the conflict file for inspection, warn loudly and
   * persistently in the UI, and let the user decide. See docs/CRYPTO.md.
   */
  async load(force = false): Promise<KeyringData | null> {
    if (this.cache && !force) return this.cache;
    if (!(await this.exists())) {
      this.cache = null;
      return null;
    }
    const raw = await this.app.vault.adapter.read(this.keyringPath);
    let parsed: KeyringData;
    try {
      parsed = parseKeyring(raw);
    } catch (error) {
      this.log.error("keyring_parse_failed", { error: String(error) });
      throw Err.keyringMissing();
    }

    const rollback = checkEpoch(parsed, this);
    if (!rollback.ok) {
      this.log.warn("keyring_epoch_regression", {
        fileEpoch: parsed.epoch,
        deviceEpoch: rollback.seen,
        /** how many generations we appear to have gone back */
        behindBy: (rollback.seen ?? 0) - parsed.epoch,
      });
      await this.quarantineRolledBackKeyring(raw);
      this.lastRollback = {
        fileEpoch: parsed.epoch,
        deviceEpoch: rollback.seen ?? 0,
        detectedAt: new Date().toISOString(),
      };
      // Fall through: usable, but flagged.
    } else {
      this.lastRollback = null;
    }

    this.cache = parsed;
    return parsed;
  }

  /**
   * Keep a copy of the rolled back keyring next to it, so the user (or a future
   * version) can tell which slots were lost. Best effort: never block loading.
   */
  private async quarantineRolledBackKeyring(raw: string): Promise<void> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = normalizePath(`${this.dir}/backups`);
      if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
      await this.app.vault.adapter.write(
        normalizePath(`${dir}/keyring-rollback-${stamp}.json`),
        raw,
      );
    } catch (error) {
      this.log.warn("quarantine_failed", { error: String(error) });
    }
  }

  /** The most recent rollback, for the settings UI to surface. Null when clean. */
  get rollbackWarning(): { fileEpoch: number; deviceEpoch: number; detectedAt: string } | null {
    return this.lastRollback;
  }

  /**
   * Explicit user acknowledgement that going backwards was intentional (they
   * restored a backup). This is the ONLY place the device high water mark is
   * lowered, and it must be user initiated.
   */
  async acknowledgeRollback(keyring: KeyringData): Promise<void> {
    this.write(keyring.vaultId, keyring.epoch);
    this.cache = keyring;
    this.lastRollback = null;
    this.log.info("rollback_acknowledged", { epoch: keyring.epoch });
  }

  async save(keyring: KeyringData): Promise<void> {
    const target = this.keyringPath;
    const temp = `${target}.tmp`;
    const body = serializeKeyring(keyring);
    await this.ensureDir();
    await this.app.vault.adapter.write(temp, body);
    await this.app.vault.adapter.rename(temp, target);
    this.cache = keyring;
    recordEpoch(keyring, this);
    this.log.info("keyring_saved", { epoch: keyring.epoch, slots: Object.keys(keyring.slots) });
  }

  /** Drop the cached copy so the next load re-reads from disk. */
  invalidate(): void {
    this.cache = null;
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.dir))) {
      await this.app.vault.adapter.mkdir(this.dir);
    }
  }

  /* ---------------- rotation backups -------------------------------------- */

  async backupCurrent(): Promise<string | null> {
    if (!(await this.exists())) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = normalizePath(`${this.dir}/backups/keyring-${stamp}.json`);
    await this.ensureBackupDir();
    await this.app.vault.adapter.write(backup, await this.app.vault.adapter.read(this.keyringPath));
    this.log.info("keyring_backed_up", { backup });
    return backup;
  }

  private async ensureBackupDir(): Promise<void> {
    const dir = normalizePath(`${this.dir}/backups`);
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }
}