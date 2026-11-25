/**
 * Core tests. They run against the real Web Crypto implementation, not mocks --
 * crypto that passes against a mock proves nothing.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DecryptError,
  fromBase32,
  fromBase64,
  open,
  randomBytes,
  seal,
  toBase32,
  toBase64,
  deriveKeyFromSecret,
  hkdfBytes,
} from "../src/core/crypto";
import {
  createKeyring,
  emptyKeyring,
  keyFingerprint,
  newDek,
  parseKeyring,
  serializeKeyring,
  setSlot,
  unlockWithPassword,
  unlockWithRecovery,
  UnlockError,
  SLOT_PASSWORD,
  SLOT_RECOVERY,
  registerFailure,
  registerSuccess,
  guardRemainingMs,
  FREE_ATTEMPTS,
  normalizeRecovery,
  MIN_ITERATIONS,
  checkEpoch,
  recordEpoch,
  EpochStore,
} from "../src/core/keyring";

function memEpochStore(): EpochStore {
  const map = new Map<string, number>();
  return {
    read: (vaultId) => map.get(vaultId) ?? null,
    write: (vaultId, epoch) => {
      map.set(vaultId, epoch);
    },
  };
}
import {
  findFencedBlocks,
  findInlinePayloads,
  openInline,
  openNote,
  parseNoteEnvelope,
  sealInline,
  sealNote,
  wrapFenced,
} from "../src/core/format";
import { generateRecoveryKey, recoverySecret, assertRecoveryKey, groupRecovery } from "../src/core/recovery";
import { totpCode, verifyTotp, generateTotpSecret } from "../src/core/totp";
import { SessionStore } from "../src/core/session";

// PBKDF2 at 600k is too slow for a unit test suite; the production default is
// asserted separately. Everything else is the real deal.
const FAST = { iterations: 1000 };

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

test("base64 and base32 round trip arbitrary bytes", () => {
  for (const len of [1, 2, 3, 15, 16, 17, 32, 513]) {
    const bytes = randomBytes(len);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes, `base64 len ${len}`);
    const b32 = toBase32(bytes);
    assert.match(b32, /^[A-Z2-7]+$/);
    assert.deepEqual(fromBase32(b32), bytes, `base32 len ${len}`);
  }
});

test("AES-GCM refuses a modified ciphertext or a wrong key", async () => {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const box = await seal(key, new TextEncoder().encode("top secret"));
  const tampered = { iv: box.iv, data: new Uint8Array(box.data) };
  tampered.data[0] ^= 0xff;
  await assert.rejects(() => open(key, tampered), DecryptError);

  const other = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await assert.rejects(() => open(other, box), DecryptError);
});

test("AAD mismatch is rejected", async () => {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const box = await seal(key, new TextEncoder().encode("x"), "context-a");
  await assert.rejects(() => open(key, box, "context-b"), DecryptError);
  const ok = await open(key, box, "context-a");
  assert.equal(new TextDecoder().decode(ok), "x");
});

test("HKDF is deterministic and domain separated", async () => {
  const base = randomBytes(32);
  const salt = randomBytes(16);
  const a = await hkdfBytes(base, salt, "one", 32);
  const b = await hkdfBytes(base, salt, "one", 32);
  const c = await hkdfBytes(base, salt, "two", 32);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

/* ------------------------------------------------------------------ */
/* keyring                                                             */
/* ------------------------------------------------------------------ */

const VAULT = "11111111-2222-4333-8444-555555555555";

test("keyring: password unlock returns the same DEK every time", async () => {
  const { keyring, dek } = await createKeyring(VAULT, "correct horse battery", "RECOVERYKEY", {
    iterations: FAST.iterations,
  });
  const a = await unlockWithPassword(keyring, "correct horse battery");
  const b = await unlockWithPassword(keyring, "correct horse battery");
  assert.deepEqual(a, dek);
  assert.deepEqual(b, dek);
});

test("keyring: wrong password throws, does not return a key", async () => {
  const { keyring } = await createKeyring(VAULT, "right", "REC", { iterations: FAST.iterations });
  await assert.rejects(() => unlockWithPassword(keyring, "wrong"), UnlockError);
});

test("keyring: recovery key unlocks the same DEK as the password", async () => {
  const { keyring, dek } = await createKeyring(VAULT, "pw", "MY-RECOVERY-SECRET", {
    iterations: FAST.iterations,
  });
  assert.deepEqual(await unlockWithRecovery(keyring, "MY-RECOVERY-SECRET"), dek);
  // formatting differences must not matter
  assert.deepEqual(await unlockWithRecovery(keyring, "my recovery secret"), dek);
});

test("keyring: password reset keeps the DEK, so no note needs rewriting", async () => {
  const { keyring, dek } = await createKeyring(VAULT, "old-password", "REC", {
    iterations: FAST.iterations,
  });
  const cipherBefore = await sealNote(dek, VAULT, "kid-1", "note body");
  const passwordGenBefore = keyring.slots.password!.gen;
  const recoveryGenBefore = keyring.slots.recovery!.gen;

  // reset: we hold the DEK (obtained via recovery key), set a new password
  await setSlot(keyring, dek, SLOT_PASSWORD, `sn-pwd|new-password`);

  assert.equal(keyring.slots.password!.gen, passwordGenBefore + 1, "password gen bumped");
  assert.equal(keyring.slots.recovery!.gen, recoveryGenBefore, "recovery untouched");

  await assert.rejects(() => unlockWithPassword(keyring, "old-password"));
  assert.deepEqual(await unlockWithPassword(keyring, "new-password"), dek);

  // the old ciphertext still opens with the same DEK
  const reopened = await openNote(dek, VAULT, parseNoteEnvelope(cipherBefore)!);
  assert.equal(reopened, "note body");
});

test("keyring: a wrapped DEK cannot be transplanted to another slot", async () => {
  // "PW" is chosen so recovery normalization is a no-op: the rejection below can
  // then only come from the AAD naming the slot, not from a differing secret.
  const { keyring } = await createKeyring(VAULT, "PW", "REC", { iterations: FAST.iterations });
  keyring.slots.recovery = { ...keyring.slots.password! };
  await assert.rejects(() => unlockWithRecovery(keyring, "PW"), UnlockError);
});

test("keyring: tampering a cell's generation field breaks it", async () => {
  const { keyring } = await createKeyring(VAULT, "pw", "REC", { iterations: FAST.iterations });
  const cell = { ...keyring.slots.password! };
  // The AAD covers the generation, so editing the number in the file makes the
  // cell stop unwrapping. (Restoring a whole untouched old cell is a different
  // attack - that one is only detectable via the device epoch, see below.)
  keyring.slots.password = { ...cell, gen: cell.gen + 1 };
  await assert.rejects(() => unlockWithPassword(keyring, "pw"), UnlockError);
});

test("keyring: per-slot generation does NOT stop a whole-cell restore", async () => {
  // Documenting the real limit rather than pretending the defence is complete:
  // an attacker who keeps a copy of an old cell can put it back verbatim,
  // because the generation it was wrapped under travels with it.
  const { keyring, dek } = await createKeyring(VAULT, "pw", "REC", { iterations: FAST.iterations });
  const oldCell = JSON.parse(JSON.stringify(keyring.slots.password));
  await setSlot(keyring, dek, SLOT_PASSWORD, `sn-pwd|pw2`);
  keyring.slots.password = oldCell;
  assert.deepEqual(await unlockWithPassword(keyring, "pw"), dek, "old secret works again");
});

test("keyring: a whole-file rollback is caught by the device epoch", () => {
  const store = memEpochStore();
  const kr = emptyKeyring(VAULT);
  kr.epoch = 5;
  recordEpoch(kr, store);
  assert.equal(store.read(VAULT), 5);

  const restored = { ...emptyKeyring(VAULT), epoch: 3 };
  assert.equal(checkEpoch(restored, store).ok, false, "older epoch must be refused");

  const newer = { ...emptyKeyring(VAULT), epoch: 6 };
  assert.equal(checkEpoch(newer, store).ok, true);
  // a fresh device has no memory, which is the documented limit
  assert.equal(checkEpoch(restored, memEpochStore()).ok, true);
});

test("keyring: a different vault id cannot open the wrapped DEK", async () => {
  const { keyring } = await createKeyring(VAULT, "pw", "REC", { iterations: FAST.iterations });
  const moved = { ...keyring, vaultId: "99999999-2222-4333-8444-555555555555" };
  await assert.rejects(() => unlockWithPassword(moved, "pw"), UnlockError);
});

test("keyring: serialization round trips and rejects junk", async () => {
  // Use a real iteration count: the floor is deliberately enforced on load, so
  // a test fixture below it could not round trip.
  const { keyring } = await createKeyring(VAULT, "pw", "REC", { iterations: MIN_ITERATIONS });
  const parsed = parseKeyring(serializeKeyring(keyring));
  assert.equal(parsed.vaultId, VAULT);
  assert.equal(parsed.kdf.hash, "SHA-512");
  assert.equal(parsed.kdf.iterations, MIN_ITERATIONS);
  assert.equal(parsed.epoch, keyring.epoch);
  assert.throws(() => parseKeyring("{}"));
  assert.throws(() => parseKeyring("not json"));
});

test("keyring: a downgraded iteration count is refused at load", async () => {
  // Tampering the stored iterations down is the cheapest attack on a stolen
  // keyring, so anything below MIN_ITERATIONS must be treated as hostile.
  const { keyring } = await createKeyring(VAULT, "pw", "REC", { iterations: FAST.iterations });
  const downgraded = { ...keyring, kdf: { ...keyring.kdf, iterations: 1000 } };
  assert.throws(() => parseKeyring(JSON.stringify(downgraded)), /invalid KDF/);
  const atFloor = { ...keyring, kdf: { ...keyring.kdf, iterations: MIN_ITERATIONS } };
  assert.doesNotThrow(() => parseKeyring(JSON.stringify(atFloor)));
  const badHash = { ...keyring, kdf: { ...keyring.kdf, hash: "MD5" } };
  assert.throws(() => parseKeyring(JSON.stringify(badHash)), /invalid KDF/);
});

test("keyring: fingerprint is stable per DEK and differs across DEKs", async () => {
  const a = await keyFingerprint(newDek());
  const b = await keyFingerprint(newDek());
  assert.match(a, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  assert.notEqual(a, b);
  const same = new Uint8Array(32).fill(7);
  assert.equal(await keyFingerprint(same), await keyFingerprint(new Uint8Array(32).fill(7)));
});

test("guard backs off after repeated failures and resets on success", () => {
  const guard = { failCount: 0, lockedUntil: null as number | null };
  for (let i = 0; i < FREE_ATTEMPTS; i++) {
    registerFailure(guard, 1000);
    assert.equal(guardRemainingMs(guard, 1000), 0, "no penalty within allowance");
  }
  registerFailure(guard, 1000);
  assert.ok(guardRemainingMs(guard, 1000) > 0, "penalty after exceeding allowance");
  registerSuccess(guard);
  assert.equal(guardRemainingMs(guard, 1000), 0);
});

/* ------------------------------------------------------------------ */
/* note envelope                                                       */
/* ------------------------------------------------------------------ */

test("note: round trip, and the file contains no plaintext", async () => {
  const dek = newDek();
  const body = "# 标题\n\n正文内容 secret-token-abc123\n";
  const text = await sealNote(dek, VAULT, "kid-1", body);
  assert.ok(!text.includes("secret-token"), "plaintext must not be in the envelope");
  assert.ok(!text.includes("正文"));
  const env = parseNoteEnvelope(text);
  assert.ok(env);
  assert.equal(await openNote(dek, VAULT, env!), body);
});

test("note: envelope hides in a Markdown comment, legacy bare JSON still opens", async () => {
  const dek = newDek();
  const body = "# 标题\n\n正文\n";
  const text = await sealNote(dek, VAULT, "kid-1", body);
  assert.match(text, /^<!-- sealed-note\/note\/1/, "rendered Markdown hides the keys");
  assert.ok(text.includes("-->"), "comment is closed");
  assert.equal(await openNote(dek, VAULT, parseNoteEnvelope(text)!), body);

  // Notes written before the comment wrapper must remain readable.
  const legacy = JSON.stringify(parseNoteEnvelope(text)!);
  assert.equal(await openNote(dek, VAULT, parseNoteEnvelope(legacy)!), body);
});

test("note: empty content and unicode survive", async () => {
  const dek = newDek();
  for (const body of ["", "a", "🔒 中文 emoji 🎉", "\r\n\r\n"]) {
    const env = parseNoteEnvelope(await sealNote(dek, VAULT, "kid", body))!;
    assert.equal(await openNote(dek, VAULT, env), body);
  }
});

test("note: wrong key or wrong vault is rejected", async () => {
  const dek = newDek();
  const text = await sealNote(dek, VAULT, "kid", "body");
  const env = parseNoteEnvelope(text)!;
  await assert.rejects(() => openNote(newDek(), VAULT, env), DecryptError);
  await assert.rejects(() => openNote(dek, "other-vault", env), DecryptError);
});

test("note: parse rejects foreign payloads", () => {
  assert.equal(parseNoteEnvelope("just markdown"), null);
  assert.equal(parseNoteEnvelope("{}"), null);
  assert.equal(parseNoteEnvelope(JSON.stringify({ format: "other/1" })), null);
});

test("note: every seal uses a fresh salt and iv", async () => {
  const dek = newDek();
  const a = parseNoteEnvelope(await sealNote(dek, VAULT, "k", "same"))!;
  const b = parseNoteEnvelope(await sealNote(dek, VAULT, "k", "same"))!;
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

/* ------------------------------------------------------------------ */
/* inline payloads                                                     */
/* ------------------------------------------------------------------ */

test("inline: round trip, and wrong vault is rejected", async () => {
  const dek = newDek();
  const payload = await sealInline(dek, VAULT, "api_key = sk-123");
  assert.match(payload, /^sn1\.[A-Za-z0-9+/=]+$/);
  assert.ok(!payload.includes("sk-123"));
  assert.equal(await openInline(dek, VAULT, payload), "api_key = sk-123");
  await assert.rejects(() => openInline(dek, "other", payload));
});

test("inline: whitespace and line wrapping inside the payload are tolerated", async () => {
  const dek = newDek();
  const payload = await sealInline(dek, VAULT, "wrapped");
  const messy = payload.slice(0, 20) + "\n  " + payload.slice(20);
  assert.equal(await openInline(dek, VAULT, messy), "wrapped");
});

test("inline: scanner finds fenced blocks and payloads with exact offsets", async () => {
  const src = [
    "before",
    "```encrypted_txt",
    "sn1.AAAA",
    "```",
    "middle `sn1.BBBB` tail",
    "```txt_encrypted",
    "sn1.CCCC",
    "```",
    "```js",
    "not encrypted",
    "```",
  ].join("\n");

  const fenced = findFencedBlocks(src);
  assert.equal(fenced.length, 2, "only encrypted fences, not plain code blocks");
  assert.equal(fenced[0].lang, "encrypted_txt");
  assert.equal(fenced[0].payload, "sn1.AAAA");
  assert.equal(src.slice(fenced[0].start, fenced[0].end), fenced[0].whole);
  assert.equal(fenced[1].lang, "txt_encrypted");

  const inline = findInlinePayloads(src);
  assert.equal(inline.length, 1);
  assert.equal(inline[0].payload, "sn1.BBBB");
});

test("inline: wrapFenced produces something the scanner reads back", () => {
  const wrapped = wrapFenced("sn1.XXXX");
  const found = findFencedBlocks("a\n" + wrapped + "\nb");
  assert.equal(found.length, 1);
  assert.equal(found[0].payload, "sn1.XXXX");
});

/* ------------------------------------------------------------------ */
/* recovery key                                                        */
/* ------------------------------------------------------------------ */

test("recovery key: shape, uniqueness, normalization", () => {
  const keys = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const key = generateRecoveryKey();
    assert.match(key, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){9}(-[A-Z2-7]{2})$/);
    assert.equal(normalizeRecovery(key).length, 52);
    assert.doesNotThrow(() => assertRecoveryKey(key));
    keys.add(key);
  }
  assert.equal(keys.size, 50, "no collisions");
  assert.equal(recoverySecret("ABCDE-FGHIJ"), "ABCDEFGHIJ");
  assert.equal(recoverySecret(" k7qm-3xpd "), "K7QM3XPD");
  assert.equal(groupRecovery("ABCDEFGHIJ"), "ABCDE-FGHIJ");
});

test("recovery key: bad input is refused", () => {
  assert.throws(() => assertRecoveryKey("too-short"), /长度不正确/);
  // Characters outside the base32 alphabet are stripped by normalization, so a
  // string made only of them collapses to zero length and is refused.
  assert.throws(() => assertRecoveryKey("1".repeat(52)), /长度不正确/);
  // 52 valid base32 chars but not a multiple of 8 at the bit level still decodes,
  // so the length gate is what protects us here.
  assert.doesNotThrow(() => assertRecoveryKey("A".repeat(52)));
  assert.equal(recoverySecret("A".repeat(52)).length, 52);
});

/* ------------------------------------------------------------------ */
/* TOTP                                                                */
/* ------------------------------------------------------------------ */

test("TOTP matches the RFC 6238 appendix B vectors (SHA-1)", async () => {
  // The RFC vector secret is "12345678901234567890" in ASCII.
  const secret = toBase32(new TextEncoder().encode("12345678901234567890"));
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  for (const [seconds, expected] of vectors) {
    const code = await totpCode(secret, { now: seconds * 1000 });
    assert.equal(code, expected, `t=${seconds}`);
  }
});

test("TOTP verification allows one step of drift and rejects the rest", async () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const current = await totpCode(secret, { now });
  assert.ok(await verifyTotp(secret, current, { now }));
  assert.ok(await verifyTotp(secret, await totpCode(secret, { now: now - 30_000 }), { now }));
  assert.ok(await verifyTotp(secret, await totpCode(secret, { now: now + 30_000 }), { now }));
  assert.ok(!(await verifyTotp(secret, await totpCode(secret, { now: now - 120_000 }), { now })));
  assert.ok(!(await verifyTotp(secret, "000000", { now })) || current === "000000");
  assert.ok(!(await verifyTotp(secret, "abc", { now })));
});

/* ------------------------------------------------------------------ */
/* sessions                                                            */
/* ------------------------------------------------------------------ */

test("session: lock forgets the entry and never touches the caller's buffer", () => {
  const store = new SessionStore();
  const dek = new Uint8Array(32).fill(9);
  store.put("a.sealed", dek, "password");
  assert.ok(store.has("a.sealed"));
  // The session stores a COPY; mutating through the entry must not alias the
  // caller's array. (Earlier builds shared the reference and lock() wiped it,
  // silently zeroing the vault's single DEK and corrupting every later
  // encrypt - the data-loss bug this assertion now guards.)
  assert.notEqual(store.get("a.sealed")!.dek, dek, "session holds its own copy");
  assert.ok(store.lock("a.sealed"));
  assert.ok(!store.has("a.sealed"));
  assert.deepEqual([...dek], new Array(32).fill(9), "caller's buffer untouched by lock");
});

test("session: leaving a note locks it, so coming back asks again", () => {
  const store = new SessionStore();
  store.put("a.sealed", new Uint8Array(32), "password");
  store.put("b.sealed", new Uint8Array(32), "password");
  const locked = store.lockExcept("b.sealed");
  assert.deepEqual(locked, ["a.sealed"]);
  assert.ok(store.has("b.sealed"));
});

test("session: lockAll clears everything", () => {
  const store = new SessionStore();
  store.put("a", new Uint8Array(32), "password");
  store.put("b", new Uint8Array(32), "totp");
  assert.equal(store.lockAll(), 2);
  assert.equal(store.size, 0);
});

/* ------------------------------------------------------------------ */
/* production parameters                                               */
/* ------------------------------------------------------------------ */

test("production KDF parameters are at least 600k iterations of SHA-512", async () => {
  const { DEFAULT_KDF } = await import("../src/core/crypto");
  assert.ok(DEFAULT_KDF.iterations >= 600_000);
  assert.equal(DEFAULT_KDF.hash, "SHA-512");
  // sanity: a real derive with production params works (slow, one call only)
  const key = await deriveKeyFromSecret("pw", randomBytes(16), DEFAULT_KDF);
  assert.equal(key.algorithm.name, "AES-GCM");
});

test("emptyKeyring has no slots and is not usable", async () => {
  const kr = emptyKeyring(VAULT);
  assert.deepEqual(kr.slots, {});
  assert.equal(kr.totp.enabled, false);
  await assert.rejects(() => unlockWithPassword(kr, "anything"), UnlockError);
});
/* ------------------------------------------------------------------ */
/* TOTP as a first class credential                                    */
/* ------------------------------------------------------------------ */

test("three unlock modes: password only, totp only, and combined", async () => {
  const {
    createKeyring,
    SLOT_PASSWORD,
    SLOT_TOTP,
    SLOT_PASSWORD_TOTP,
    credentialFor,
    unlockFromCredential,
    UnlockError,
  } = await import("../src/core/keyring");

  const password = "a-strong-password-123";
  const seed = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const { keyring, dek } = await createKeyring(VAULT, password, "REC", { iterations: FAST.iterations });

  // Derive each slot with its own domain-separated credential.
  await setSlot(keyring, dek, SLOT_PASSWORD, credentialFor(SLOT_PASSWORD, { password }));
  await setSlot(keyring, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));
  await setSlot(
    keyring,
    dek,
    SLOT_PASSWORD_TOTP,
    credentialFor(SLOT_PASSWORD_TOTP, { password, totpSeed: seed }),
  );

  // Each mode opens the same DEK.
  assert.deepEqual(
    await unlockFromCredential(keyring, credentialFor(SLOT_PASSWORD, { password })),
    dek,
  );
  assert.deepEqual(
    await unlockFromCredential(keyring, credentialFor(SLOT_TOTP, { totpSeed: seed })),
    dek,
  );
  assert.deepEqual(
    await unlockFromCredential(
      keyring,
      credentialFor(SLOT_PASSWORD_TOTP, { password, totpSeed: seed }),
    ),
    dek,
  );
});

test("combined mode really needs BOTH secrets", async () => {
  const {
    createKeyring,
    SLOT_PASSWORD_TOTP,
    credentialFor,
    unlockFromCredential,
  } = await import("../src/core/keyring");

  const { keyring, dek } = await createKeyring(VAULT, "pw", "REC", { iterations: FAST.iterations });
  // Isolate just the combined slot so the fallback cannot find another one.
  const combinedOnly = { ...keyring, slots: {} as any };
  await setSlot(
    combinedOnly,
    dek,
    SLOT_PASSWORD_TOTP,
    credentialFor(SLOT_PASSWORD_TOTP, { password: "right-pw", totpSeed: "JBSWY3DPEHPK3PXP" }),
  );

  // correct pair
  assert.deepEqual(
    await unlockFromCredential(
      combinedOnly,
      credentialFor(SLOT_PASSWORD_TOTP, { password: "right-pw", totpSeed: "JBSWY3DPEHPK3PXP" }),
    ),
    dek,
  );
  // right password, wrong seed
  await assert.rejects(() =>
    unlockFromCredential(
      combinedOnly,
      credentialFor(SLOT_PASSWORD_TOTP, { password: "right-pw", totpSeed: "AAAAAAAAAAAAAAAA" }),
    ),
  );
  // wrong password, right seed
  await assert.rejects(() =>
    unlockFromCredential(
      combinedOnly,
      credentialFor(SLOT_PASSWORD_TOTP, { password: "wrong-pw", totpSeed: "JBSWY3DPEHPK3PXP" }),
    ),
  );
});

test("domain separation: a password cannot masquerade as a TOTP seed", async () => {
  const { createKeyring, SLOT_PASSWORD, SLOT_TOTP, credentialFor, unlockFromCredential } =
    await import("../src/core/keyring");

  const secret = "SAME-SECRET-VALUE";
  const { keyring, dek } = await createKeyring(VAULT, secret, "REC", { iterations: FAST.iterations });
  const isolated = { ...keyring, slots: {} as any };
  await setSlot(isolated, dek, SLOT_PASSWORD, credentialFor(SLOT_PASSWORD, { password: secret }));

  // Same literal secret, but framed as a TOTP seed: must NOT open the password slot.
  await assert.rejects(() =>
    unlockFromCredential(isolated, credentialFor(SLOT_TOTP, { totpSeed: secret })),
  );
});

test("TOTP code is NOT the key: the seed unwraps, and the code is only verified", async () => {
  const { createKeyring, SLOT_TOTP, credentialFor, unlockFromCredential } =
    await import("../src/core/keyring");
  const seed = generateTotpSecret();
  const { keyring, dek } = await createKeyring(VAULT, "pw", "REC", { iterations: FAST.iterations });
  const isolated = { ...keyring, slots: {} as any };
  await setSlot(isolated, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));

  // The 6 digit code alone cannot unwrap: it is not the credential.
  const code = await totpCode(seed, { now: 1_700_000_000_000 });
  await assert.rejects(() =>
    unlockFromCredential(isolated, credentialFor(SLOT_TOTP, { totpSeed: code })),
  );
  // The seed can.
  assert.deepEqual(
    await unlockFromCredential(isolated, credentialFor(SLOT_TOTP, { totpSeed: seed })),
    dek,
  );
});

/* ------------------------------------------------------------------ */
/* i18n                                                                */
/* ------------------------------------------------------------------ */

test("i18n: both dictionaries have the same keys", async () => {
  // Read the source so the test does not depend on bundle internals.
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const src = readFileSync(resolve(process.cwd(), "src/i18n.ts"), "utf8");
  const extract = (name: string): Set<string> => {
    const start = src.indexOf(`const ${name}: Record<string, string> = {`);
    const end = src.indexOf("\n};", start);
    const block = src.slice(start, end);
    return new Set([...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  };
  const enKeys = extract("en");
  const zhKeys = extract("zh");
  assert.ok(enKeys.size > 100, "a meaningful number of keys");
  const missing = [...enKeys].filter((k) => !zhKeys.has(k));
  const extra = [...zhKeys].filter((k) => !enKeys.has(k));
  assert.deepEqual(missing, [], "every English key has a Chinese translation");
  assert.deepEqual(extra, [], "no orphan Chinese keys");
});

test("i18n: t() interpolates variables", async () => {
  const { setLanguage, t } = await import("../src/i18n");
  setLanguage("en");
  assert.match(t("prompt.unlockTitle", { name: "MyNote" }), /MyNote/);
  assert.ok(!t("prompt.unlockTitle", { name: "MyNote" }).includes("{name}"));
  assert.match(t("notice.lockedCount", { n: 3 }), /3/);
});

test("i18n: switching language changes the output", async () => {
  const { setLanguage, t, currentLanguage } = await import("../src/i18n");
  setLanguage("en");
  const en = t("cmd.new.name");
  const enLang = currentLanguage();
  setLanguage("zh");
  const zh = t("cmd.new.name");
  assert.equal(enLang, "en");
  assert.equal(currentLanguage(), "zh");
  assert.notEqual(en, zh, "the two languages produce different text");
  assert.match(zh, /[\u4e00-\u9fff]/, "Chinese output contains Chinese characters");
  setLanguage("auto");
});

test("i18n: unknown key falls back to the key itself, never throws", async () => {
  const { setLanguage, t } = await import("../src/i18n");
  setLanguage("en");
  assert.equal(t("this.key.does.not.exist"), "this.key.does.not.exist");
  assert.equal(t("notice.created", { unused: "x" }), t("notice.created"));
});
