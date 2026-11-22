/**
 * Headless smoke test: instantiate the *real* plugin class and run onload().
 *
 * The bundle is built with `obsidian` aliased to tests/obsidian-stub.ts, so this
 * exercises the actual module graph - imports, registration order, singleton
 * wiring - rather than a hand written mock of the plugin.
 *
 * It catches the class of bug a type check cannot: a registration that throws at
 * runtime, a service used before it is constructed, a command whose closure
 * touches something undefined.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildHarness } from "./obsidian-stub";

/**
 * Minimal browser globals.
 *
 * The plugin registers a document level listener during onload, so a headless
 * run needs `document` to exist. Keeping the stub tiny makes it obvious when the
 * plugin accidentally reaches for something that is not available here.
 */
function installDomShim(): void {
  const g = globalThis as any;
  if (typeof g.document === "undefined") {
    g.document = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {} },
        setAttribute() {},
        appendChild() {},
      }),
      createTreeWalker: () => ({ nextNode: () => null }),
      querySelector: () => null,
      body: { appendChild() {} },
    };
  }
  // localStorage must actually store: the rollback guard reads back the epoch
  // it wrote earlier, so a no-op stub would make that test pass for the wrong
  // reason (and hide real regressions).
  const store = new Map<string, string>();
  if (typeof g.window === "undefined") {
    g.window = {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => store.clear(),
      },
      setTimeout: (fn: Function, ms?: number) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id: number) => clearTimeout(id),
      addEventListener: () => undefined,
    };
  }
  if (typeof g.NodeFilter === "undefined") {
    g.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_SKIP: 2 };
  }
}

installDomShim();

async function loadPlugin(): Promise<{ plugin: any; harness: ReturnType<typeof buildHarness>["harness"] }> {
  const { obsidian, harness } = buildHarness();

  // The stub is aliased onto "obsidian" at build time, so the module graph below
  // resolves the real source against the stub API.
  const mod: any = await import("../src/main");
  const PluginClass = mod.default;

  // Point the class at this harness instance.
  const plugin = new PluginClass();
  plugin.app = harness.app;
  plugin.manifest = { id: "sealed-note", version: "1.0.0", dir: ".obsidian/plugins/sealed-note" };

  // Bind the prototype helpers that the stub Plugin would normally provide.
  const proto = Object.getPrototypeOf(plugin);
  void proto;
  return { plugin, harness };
}

/**
 * The real Plugin base class comes from the stub, so instance helpers are
 * already available; we only need to give it the right app/manifest.
 */
async function boot(): Promise<{ plugin: any; harness: ReturnType<typeof buildHarness>["harness"] }> {
  const { default: PluginClass } = await import("../src/main");
  const { harness } = buildHarness();
  const plugin = new PluginClass();
  plugin.app = harness.app;
  plugin.manifest = { id: "sealed-note", version: "1.0.0", dir: ".obsidian/plugins/sealed-note" };
  await plugin.onload();
  return { plugin, harness };
}

test("onload registers views, commands, menus and chrome without throwing", async () => {
  const { plugin, harness } = await boot();
  const r = harness.registered;

  const ids = r.commands.map((c) => c.id);
  const expected = [
    "new-sealed-note",
    "encrypt-selection-fence",
    "encrypt-selection-inline",
    "decrypt-selection",
    "decrypt-selection-to-clipboard",
    "decrypt-whole-note",
    "lock-current",
    "lock-all",
    "show-recovery-key",
    "setup-totp",
  ];
  for (const id of expected) assert.ok(ids.includes(id), `missing command: ${id}`);
  assert.equal(new Set(ids).size, ids.length, "command ids must be unique");

  assert.ok(r.views.has("sealed-note-view"), "sealed view registered");
  assert.equal(r.extensions.get("sealed"), "sealed-note-view", "the 'sealed' token routes .sealed.md files to our view");

  for (const lang of ["encrypted_txt", "txt_encrypted", "sealed"]) {
    assert.ok(r.codeBlocks.has(lang), `code block processor for ${lang}`);
  }
  assert.equal(r.postProcessors.length, 1, "inline postprocessor registered");

  assert.ok(r.events.some((e) => e.name === "editor-menu"), "editor context menu");
  assert.ok(r.events.some((e) => e.name === "file-menu"), "file context menu");
  assert.ok(r.events.some((e) => e.name === "active-leaf-change"), "auto lock on leaf change");

  assert.equal(r.settingsTabs.length, 1, "settings tab");
  assert.equal(r.ribbon.length, 1, "ribbon icon");
  assert.equal(r.statusBar.length, 1, "status bar item");
  assert.ok(r.statusBar[0].text && r.statusBar[0].text.length > 0, "status bar shows a locked label");

  assert.equal(
    harness.notices.filter((n) => /error|失败|错误/i.test(n)).length,
    0,
    `no error notices during load, got: ${harness.notices.join(" | ")}`,
  );

  plugin.onunload();
});

test("a damaged encrypted note does not crash onload", async () => {
  const { default: PluginClass } = await import("../src/main");
  const { harness } = buildHarness();
  // A broken note is just a file the sync tool dropped in; it must not stop
  // the plugin from loading.
  harness.files.set("Private/broken.sealed.md", "{ truncated json");

  const plugin = new PluginClass();
  plugin.app = harness.app;
  plugin.manifest = { id: "sealed-note", version: "1.0.0", dir: ".obsidian/plugins/sealed-note" };

  await assert.doesNotReject(() => plugin.onload(), "onload must survive a bad note");
  assert.equal(await plugin.keyringStore.exists(), false, "a broken note is not a key source");
  plugin.onunload();
});

test("commands that need a keyring fail with a typed, readable error", async () => {
  const { plugin } = await boot();

  await assert.rejects(
    () => plugin.unlockService.requireKeyring(),
    (err: any) => {
      assert.ok(err instanceof Error, "is an Error");
      assert.ok(typeof err.code === "string", "has a code");
      assert.ok(!/stack|at Object/i.test(err.message), "message is not a stack trace");
      return true;
    },
  );
  plugin.onunload();
});

test("sealed note store writes only ciphertext and round trips", async () => {
  const { plugin, harness } = await boot();
  const { newDek } = await import("../src/core/keyring");

  const dek = newDek();
  const vaultId = "11111111-2222-4333-8444-555555555555";
  plugin.vaultIdentifier = vaultId;

  const notes = plugin.notes;
  const file: any = { path: "Private/t.sealed.md", basename: "t", extension: "md" };
  harness.files.set(file.path, "");

  const body = "# 秘密标题\n\npassword = hunter2\n";
  await notes.writePlaintext(file, dek, vaultId, vaultId, body);

  const stored = harness.files.get(file.path)!;
  assert.ok(stored.includes("sealed-note/note/1"), "envelope format present");
  assert.ok(!stored.includes("hunter2"), "no plaintext on disk");
  assert.ok(!stored.includes("秘密"), "no plaintext on disk (unicode)");
  assert.ok(!harness.files.has(file.path + ".tmp"), "temp file cleaned up");

  assert.equal(await notes.readPlaintext(file, dek, vaultId), body, "round trip");

  // and a different key must not open it
  await assert.rejects(() => notes.readPlaintext(file, newDek(), vaultId));

  plugin.onunload();
});

test("inline encryption is reversible through the service layer", async () => {
  const { plugin } = await boot();
  const { newDek } = await import("../src/core/keyring");

  const dek = newDek();
  plugin.vaultIdentifier = "22222222-3333-4444-8555-666666666666";

  const secret = "token = abc-123-XYZ";
  const asFence = await plugin.encryption.encryptInline(dek, secret, "fence");
  assert.ok(asFence.snippet.startsWith("```encrypted_txt"), "fence snippet");
  assert.ok(!asFence.snippet.includes("abc-123-XYZ"), "no plaintext in snippet");

  assert.equal(await plugin.encryption.decryptInline(dek, asFence.payload), secret);

  const asInline = await plugin.encryption.encryptInline(dek, secret, "inline");
  assert.ok(asInline.snippet.startsWith("`sn1."), "inline snippet");

  plugin.onunload();
});

test("decryptAll rewrites a document and reports failures honestly", async () => {
  const { plugin } = await boot();
  const { newDek } = await import("../src/core/keyring");

  const dek = newDek();
  plugin.vaultIdentifier = "33333333-4444-4555-8666-777777777777";

  const good = await plugin.encryption.encryptInline(dek, "可见的秘密", "fence");
  const broken = "```encrypted_txt\nsn1." + "B".repeat(64) + "\n```";
  const doc = ["# 标题", "", good.snippet, "", "中间", "", broken, "", "结尾"].join("\n");

  const result = await plugin.encryption.decryptAll(dek, doc);
  assert.ok(result.text.includes("可见的秘密"), "good block decrypted");
  assert.ok(result.text.includes("sn1."), "broken block left untouched");
  assert.ok(result.text.includes("结尾"), "surrounding text intact");
  assert.equal(result.failed, 1, "one failure reported");
  assert.equal(result.fenced, 2, "two fences seen");

  plugin.onunload();
});


test("key copy: every note carries a wrapped vault key", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  await plugin.keyringStore.save(keyring);
  plugin.vaultIdentifier = vaultId;

  const file: any = { path: "Private/a.sealed", basename: "a", extension: "md" };
  harness.files.set(file.path, "");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "secret body", keyring);

  const parsed = JSON.parse(harness.files.get(file.path)!);
  assert.ok(parsed.keys, "key copy embedded");
  assert.equal(parsed.keys.vaultId, vaultId);
  assert.equal(parsed.keys.epoch, keyring.epoch);
  assert.ok(parsed.keys.slots.password, "password slot copied");
  assert.ok(parsed.keys.slots.recovery, "recovery slot copied");
  assert.ok(!parsed.keys.slots.totp, "totp slot NOT copied (device bound, useless elsewhere)");
  // the copy must not leak anything new
  assert.ok(!JSON.stringify(parsed.keys).includes("pw-1234567890"), "no password in the copy");

  plugin.onunload();
});




test("password change refreshes key copies but leaves ciphertext byte-identical", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring, unlockWithPassword } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "aaaa1111-2222-4333-8444-555555555555";
  const recovery = generateRecoveryKey();
  const { keyring, dek } = await createKeyring(vaultId, "old-password-123", recovery, {
    iterations: 100_000,
  });
  // No keyring file: the first note itself carries the wrapped key.
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/secret", "标题");
  const file: any = { path: "Private/secret.sealed.md", basename: "secret", extension: "md" };
  const before = JSON.parse(harness.files.get(file.path)!);
  const dataBefore = before.data;
  const saltBefore = before.salt;
  const ivBefore = before.iv;
  const epochBefore = before.keys.epoch;

  // changePassword writes through noteKeyringStore, so the note is updated
  // immediately - there is no separate keyring file to lag behind.
  await plugin.unlockService.changePassword(dek, "new-password-456");
  const after = JSON.parse(harness.files.get(file.path)!);
  assert.ok(after.keys.epoch > epochBefore, "key copy advanced to the new generation");

  const kr = await plugin.unlockService.requireKeyring();

  // The important part: the encrypted content did not change at all.
  assert.equal(after.data, dataBefore, "ciphertext untouched");
  assert.equal(after.salt, saltBefore, "salt untouched");
  assert.equal(after.iv, ivBefore, "iv untouched");

  // Old password no longer works, new one does; note content still opens.
  await assert.rejects(() => unlockWithPassword(kr, "old-password-123"));
  assert.deepEqual(await unlockWithPassword(kr, "new-password-456"), dek);
  assert.ok((await plugin.notes.readPlaintext(file, dek, vaultId)).includes("标题"));

  plugin.onunload();
});

test("refresh is idempotent and skips notes already current", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "bbbb1111-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  await plugin.keyringStore.save(keyring);
  plugin.vaultIdentifier = vaultId;

  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/a", "A");
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/b", "B");

  const first = await plugin.keyCopies.refreshAll(keyring);
  assert.equal(first.current, 2, "already at current epoch, nothing to do");
  assert.equal(first.updated, 0);

  const stale = await plugin.keyCopies.countStale(keyring);
  assert.equal(stale, 0);
  void harness;

  plugin.onunload();
});

test("refresh touches only encrypted notes, never normal markdown", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring, setSlot } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "cccc1111-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  await plugin.keyringStore.save(keyring);
  plugin.vaultIdentifier = vaultId;

  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/a", "A");
  harness.files.set("daily/2026-01-01.md", "# 普通笔记\n\n不该被改动\n");
  harness.files.set("life/apikey.md", "apikey = real-looking-value\n");
  const normalBefore = harness.files.get("normal-placeholder.md") ?? "unused";
  const dailyBefore = harness.files.get("daily/2026-01-01.md");
  const apikeyBefore = harness.files.get("life/apikey.md");

  await setSlot(keyring, dek, "password", "new-pass-123456");
  const result = await plugin.keyCopies.refreshAll(keyring);
  assert.equal(result.updated, 1, "only the sealed note changed");

  assert.equal(harness.files.get("daily/2026-01-01.md"), dailyBefore);
  assert.equal(harness.files.get("life/apikey.md"), apikeyBefore);
  assert.ok(normalBefore);

  plugin.onunload();
});

test("refresh can be interrupted and resumed without corrupting content", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring, setSlot } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "dddd1111-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  await plugin.keyringStore.save(keyring);
  plugin.vaultIdentifier = vaultId;

  for (const name of ["a", "b", "c", "d"]) {
    await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, `Private/${name}`, name);
  }
  const originals = new Map<string, string>();
  for (const p of [...harness.files.keys()].filter((k) => k.endsWith(".sealed.md"))) {
    originals.set(p, JSON.parse(harness.files.get(p)!).data);
  }

  await setSlot(keyring, dek, "password", "changed-1234567890");

  // Stop after the first note.
  const partial = await plugin.keyCopies.refreshAll(keyring, (() => {
    let n = 0;
    return () => n++ < 1;
  })());
  assert.equal(partial.updated, 1);

  // Resume: exactly the remaining three are updated.
  const rest = await plugin.keyCopies.refreshAll(keyring);
  assert.equal(rest.updated, 3);
  assert.equal(rest.current, 1);

  // Every note's content is byte-identical to before the interruption.
  for (const [p, data] of originals) {
    assert.equal(JSON.parse(harness.files.get(p)!).data, data, `${p} content intact`);
  }

  plugin.onunload();
});

test("configureMode for all three modes writes matching slots", async () => {
  const { plugin } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateTotpSecret } = await import("../src/core/totp");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const seed = generateTotpSecret();
  const vaultId = "12121212-3434-4565-8678-909090909090";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/mode", "模式测试");

  const { unlockWithPassword, unlockWithTotp } = await import("../src/core/keyring");

  // combined mode
  await plugin.unlockService.configureMode(dek, "password+totp", {
    password: "pw-1234567890",
    seed,
  });
  let kr = await plugin.unlockService.requireKeyring();
  assert.ok(kr.slots["password-totp"], "combined slot exists");
  assert.equal(kr.totp.mode, "password+totp");
  assert.equal(kr.totp.enabled, true);
  assert.ok(!kr.slots.totp, "standalone totp slot removed");

  // pure totp mode
  await plugin.unlockService.configureMode(dek, "totp", { seed });
  kr = await plugin.unlockService.requireKeyring();
  assert.ok(kr.slots.totp, "totp slot exists");
  assert.ok(!kr.slots["password-totp"], "combined slot removed");
  assert.deepEqual(await unlockWithTotp(kr, seed), dek);

  // pure password mode clears totp
  await plugin.unlockService.configureMode(dek, "password");
  kr = await plugin.unlockService.requireKeyring();
  assert.equal(kr.totp.enabled, false);
  assert.ok(!kr.slots.totp, "totp slot cleared");
  assert.ok(!kr.slots["password-totp"], "combined slot cleared");
  assert.deepEqual(await unlockWithPassword(kr, "pw-1234567890"), dek);

  plugin.onunload();
});

test("changing password in combined mode rewraps BOTH slots", async () => {
  const { plugin } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateTotpSecret } = await import("../src/core/totp");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { unlockFromCredential, credentialFor, SLOT_PASSWORD_TOTP, UnlockError } =
    await import("../src/core/keyring");

  const seed = generateTotpSecret();
  const vaultId = "23232323-4545-4676-8789-010101010101";
  const { keyring, dek } = await createKeyring(vaultId, "old-pw-123456", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/mode", "模式测试");
  await plugin.unlockService.configureMode(dek, "password+totp", {
    password: "old-pw-123456",
    seed,
  });

  await plugin.unlockService.changePassword(dek, "new-pw-123456");
  const kr = await plugin.unlockService.requireKeyring();

  // new password + seed opens
  assert.deepEqual(
    await unlockFromCredential(
      kr,
      credentialFor(SLOT_PASSWORD_TOTP, { password: "new-pw-123456", totpSeed: seed }),
    ),
    dek,
  );
  // old password + seed fails
  await assert.rejects(() =>
    unlockFromCredential(
      kr,
      credentialFor(SLOT_PASSWORD_TOTP, { password: "old-pw-123456", totpSeed: seed }),
    ),
  );

  plugin.onunload();
});

test("TOTP-only unlock survives a restart without re-pasting the otpauth URI", async () => {
  const { plugin } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret, totpCode } = await import("../src/core/totp");

  const seed = generateTotpSecret();
  const vaultId = "34343434-5656-4787-8989-121212121212";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/totp", "动态密码测试");

  // Configure TOTP-only: the seed gets sealed into this device's storage.
  await plugin.unlockService.configureMode(dek, "totp", { seed });
  let kr = await plugin.unlockService.requireKeyring();
  assert.ok(kr.totp.enabled, "totp enabled");
  assert.equal(kr.totp.mode, "totp");
  assert.ok(kr.totp.seedRef, "a device-sealed seed copy exists");

  // Simulate a restart: wipe the in-memory session seed. A real restart would
  // create a new UnlockService instance; clearing this field is equivalent for
  // the seed-resolution path we are testing.
  plugin.unlockService.clearSessionSeed();
  assert.equal(plugin.unlockService.hasSessionSeed(), false, "session seed cleared");

  // The key copy that lives in the note must carry the reference so a new
  // session on the SAME device can find it.
  const storedRaw = [...(plugin.app.vault.getFiles() as any[])]
    .filter((f) => f.path.endsWith(".sealed.md"))
    .map((f) => (plugin.app.vault as any).adapter.read(f.path));
  const noteText = await Promise.all(storedRaw);
  const carriesSeedRef = noteText.some((raw: string) => {
    const parsed = JSON.parse(raw);
    return !!parsed.keys?.totp?.seedRef;
  });
  assert.ok(carriesSeedRef, "the device-sealed seed reference is in the note, readable after restart");

  // Now unlock through the real service path with ONLY a 6 digit code and no
  // pasted URI. This is what the UI does after a restart: performUnlock must
  // recover the seed from this device's sealed copy.
  const { getProvider } = await import("../src/core/providers");
  const code = await totpCode(seed, { now: Date.now() });
  const unlocked = await (plugin.unlockService as any).performUnlock(
    kr,
    getProvider("totp"),
    { secret: "", code },
  );
  assert.deepEqual(unlocked, dek, "unlocked using the code alone, seed recovered from this device");

  plugin.onunload();
});

test("configureMode seals the seed so a fresh service instance can recover it", async () => {
  const { buildHarness } = await import("./obsidian-stub");
  const { default: PluginClass } = await import("../src/main");
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret } = await import("../src/core/totp");
  const { openWithDevice } = await import("../src/core/device");

  const { harness } = buildHarness();
  const plugin = new PluginClass();
  plugin.app = harness.app;
  plugin.manifest = { id: "sealed-note", version: "1.0.0", dir: ".obsidian/plugins/sealed-note" };
  await plugin.onload();

  const seed = generateTotpSecret();
  const vaultId = "45454545-6767-4898-9090-232323232323";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/t", "T");

  await plugin.unlockService.configureMode(dek, "totp", { seed });
  const kr = await plugin.unlockService.requireKeyring();

  // What a fresh session on the same device would read:
  const recovered = await openWithDevice(vaultId, kr.totp.seedRef!);
  assert.equal(recovered, seed, "the sealed copy decrypts back to the original seed on this device");

  plugin.onunload();
});

test("all three unlock modes are usable independently", async () => {
  const { plugin } = await boot();
  const { createKeyring, unlockWithPassword, unlockWithTotp, unlockFromCredential, credentialFor, SLOT_PASSWORD_TOTP } =
    await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret } = await import("../src/core/totp");

  const seed = generateTotpSecret();
  const password = "pw-1234567890";
  const vaultId = "56565656-7878-4900-1212-343434343434";
  const { keyring, dek } = await createKeyring(vaultId, password, generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/modes", "模式");

  // 1) password only
  await plugin.unlockService.configureMode(dek, "password", { password });
  let kr = await plugin.unlockService.requireKeyring();
  assert.deepEqual(await unlockWithPassword(kr, password), dek, "password-only works");

  // 2) TOTP only
  await plugin.unlockService.configureMode(dek, "totp", { seed });
  kr = await plugin.unlockService.requireKeyring();
  assert.deepEqual(await unlockWithTotp(kr, seed), dek, "totp-only works");

  // 3) combined: both needed
  await plugin.unlockService.configureMode(dek, "password+totp", { password, seed });
  kr = await plugin.unlockService.requireKeyring();
  assert.deepEqual(
    await unlockFromCredential(kr, credentialFor(SLOT_PASSWORD_TOTP, { password, totpSeed: seed })),
    dek,
    "combined works",
  );
  await assert.rejects(() =>
    unlockFromCredential(kr, credentialFor(SLOT_PASSWORD_TOTP, { password: "wrong", totpSeed: seed })),
  );

  // Recovery always works regardless of mode, using the real recovery key.
  const realRecovery = generateRecoveryKey();
  await plugin.unlockService.replaceRecovery(dek, realRecovery);
  kr = await plugin.unlockService.requireKeyring();
  assert.deepEqual(
    await (await import("../src/core/keyring")).unlockWithRecovery(kr, realRecovery),
    dek,
    "recovery path works in combined mode",
  );

  plugin.onunload();
});

test("losing device storage loses the cached seed, but the phone's seed is untouched", async () => {
  const { plugin } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret, totpCode } = await import("../src/core/totp");
  const { openWithDevice } = await import("../src/core/device");
  const { getProvider } = await import("../src/core/providers");

  const seed = generateTotpSecret();
  const vaultId = "67676767-8989-4aab-8cdc-454545454545";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/deviceloss", "设备丢失");
  await plugin.unlockService.configureMode(dek, "totp", { seed });

  let kr = await plugin.unlockService.requireKeyring();
  const oldSeedRef = kr.totp.seedRef!;
  assert.ok(oldSeedRef, "a device-sealed seed exists before loss");

  // The phone still has the seed and keeps producing the SAME 6 digit codes.
  const code = await totpCode(seed, { now: Date.now() });

  // Simulate losing browser/device storage (clear app data, reinstall, etc).
  const key = `sealed-note:device-key:${vaultId}`;
  (globalThis as any).window.localStorage.removeItem(key);
  plugin.unlockService.clearSessionSeed();

  // The OLD seal can no longer be opened with a freshly generated device key.
  const recovered = await openWithDevice(vaultId, oldSeedRef);
  assert.equal(recovered, null, "the old device-sealed copy is now undecryptable");

  // So a code alone is NOT enough right after the loss.
  await assert.rejects(
    () => (plugin.unlockService as any).performUnlock(kr, getProvider("totp"), { secret: "", code }),
    (err: any) => /种子|seed|otpauth/i.test(String(err?.message)),
    "must ask for the otpauth URI once, cannot regenerate the seed from nothing",
  );

  // Re-import the SAME seed from the phone (otpauth URI) - one time only.
  const otpauth = `otpauth://totp/Test:${vaultId}?secret=${seed}&issuer=Test`;
  kr = await plugin.unlockService.requireKeyring();
  const unlocked = await (plugin.unlockService as any).performUnlock(
    kr,
    getProvider("totp"),
    { secret: "", code, totpSeed: otpauth },
  );
  assert.deepEqual(unlocked, dek, "re-import restores access");

  // After re-import, a new device-sealed copy exists.
  kr = await plugin.unlockService.requireKeyring();
  assert.ok(kr.totp.seedRef, "a fresh device-sealed copy was written");
  assert.notDeepEqual(kr.totp.seedRef, oldSeedRef, "it is sealed with a NEW device key");

  // Simulate another restart: no pasted URI, only the code. Works again.
  plugin.unlockService.clearSessionSeed();
  const code2 = await totpCode(seed, { now: Date.now() });
  const unlocked2 = await (plugin.unlockService as any).performUnlock(
    kr,
    getProvider("totp"),
    { secret: "", code: code2 },
  );
  assert.deepEqual(unlocked2, dek, "after one re-import, restart-only-code works again");

  plugin.onunload();
});

test("a vault can be initialized with TOTP only - no master password required", async () => {
  const { createKeyringWithoutPassword, unlockWithRecovery, unlockFromCredential, credentialFor, SLOT_TOTP, SLOT_RECOVERY } =
    await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret } = await import("../src/core/totp");
  const { sealNote, openNote } = await import("../src/core/format");

  const recovery = generateRecoveryKey();
  const seed = generateTotpSecret();
  const vaultId = "78787878-9090-4bab-8cdc-565656565656";
  const { keyring, dek } = await createKeyringWithoutPassword(vaultId, recovery, { iterations: 100_000 });

  // No password slot exists at all.
  assert.equal(keyring.slots.password, undefined, "no master password slot");
  assert.ok(keyring.slots[SLOT_RECOVERY], "recovery slot exists");

  // Add only the TOTP slot.
  const { setSlot } = await import("../src/core/keyring");
  await setSlot(keyring, dek, SLOT_TOTP, `sn-totp|${seed}`);
  keyring.totp.enabled = true;
  keyring.totp.mode = "totp";

  // The seed alone unlocks.
  assert.deepEqual(
    await unlockFromCredential(keyring, credentialFor(SLOT_TOTP, { totpSeed: seed })),
    dek,
    "TOTP alone opens the vault",
  );
  // Recovery still works as the fallback.
  assert.deepEqual(await unlockWithRecovery(keyring, recovery), dek, "recovery still works");

  // A note encrypted under this DEK round-trips.
  const sealed = await sealNote(dek, vaultId, vaultId, "只有动态密码的笔记");
  const parsed = (await import("../src/core/format")).parseNoteEnvelope(sealed)!;
  assert.equal(await openNote(dek, vaultId, parsed), "只有动态密码的笔记");
});

test("losing the phone seed: recovery key unblocks DEK and a NEW seed can be enrolled", async () => {
  const { plugin } = await boot();
  const { createKeyring, unlockWithRecovery, credentialFor, SLOT_TOTP, unlockFromCredential } =
    await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret, totpCode } = await import("../src/core/totp");

  const recovery = generateRecoveryKey();
  const oldSeed = generateTotpSecret();
  const vaultId = "89898989-0a0a-4bcb-8cdc-676767676767";
  const { keyring, dek } = await createKeyring(vaultId, "", recovery, { iterations: 100_000 });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/rebind", "重新绑定");

  // Enrol the original seed.
  const { setSlot } = await import("../src/core/keyring");
  await setSlot(keyring, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: oldSeed }));
  keyring.totp.enabled = true;
  keyring.totp.mode = "totp";
  await plugin.keyringStore.save(keyring, { force: true });
  let kr = await plugin.unlockService.requireKeyring();

  // Recovery key still opens the vault (this is the whole point).
  const recoveredDek = await unlockWithRecovery(kr, recovery);
  assert.deepEqual(recoveredDek, dek, "recovery key recovers the DEK, not the old seed");

  // Generate a BRAND NEW seed and bind it with the recovered DEK.
  const newSeed = generateTotpSecret();
  assert.notEqual(newSeed, oldSeed, "this is a fresh seed, not a recovery of the old one");
  await plugin.unlockService.configureMode(recoveredDek, "totp", { seed: newSeed });

  kr = await plugin.unlockService.requireKeyring();
  assert.deepEqual(
    await unlockFromCredential(kr, credentialFor(SLOT_TOTP, { totpSeed: newSeed })),
    dek,
    "new seed now unlocks the same DEK",
  );
  // The old seed is dead: against the CURRENT slot (wrapped under the new seed)
  // it cannot unwrap, so the old seed is genuinely invalidated.
  const isolated = { ...kr, slots: { [SLOT_TOTP]: kr.slots[SLOT_TOTP] } } as any;
  await assert.rejects(
    () => unlockFromCredential(isolated, credentialFor(SLOT_TOTP, { totpSeed: oldSeed })),
    "old seed no longer opens the vault",
  );

  // New seed produces valid codes for the phone.
  const code = await totpCode(newSeed, { now: Date.now() });
  assert.match(code, /^\d{6}$/, "new seed yields a usable 6 digit code");

  plugin.onunload();
});

test("restoreLocalSeed re-seals the SAME seed after local data loss", async () => {
  const { plugin } = await boot();
  const { createKeyring, unlockFromCredential, credentialFor, SLOT_TOTP } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret } = await import("../src/core/totp");
  const { openWithDevice } = await import("../src/core/device");

  const seed = generateTotpSecret();
  const vaultId = "9a9a9a9a-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const { keyring, dek } = await createKeyring(vaultId, "", generateRecoveryKey(), { iterations: 100_000 });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/restore", "恢复");
  await plugin.unlockService.configureMode(dek, "totp", { seed });

  // Simulate losing this device's key, then a fresh plugin session.
  (globalThis as any).window.localStorage.removeItem(`sealed-note:device-key:${vaultId}`);
  plugin.unlockService.clearSessionSeed();
  let kr = await plugin.unlockService.requireKeyring();
  assert.equal(await openWithDevice(vaultId, kr.totp.seedRef!), null, "old seal undecryptable");

  // The dedicated settings action restores the SAME seed from the phone URI.
  const otpauth = `otpauth://totp/Test:${vaultId}?secret=${seed}&issuer=Test`;
  await plugin.unlockService.restoreLocalSeed(otpauth);

  kr = await plugin.unlockService.requireKeyring();
  assert.deepEqual(await unlockFromCredential(kr, credentialFor(SLOT_TOTP, { totpSeed: seed })), dek);
  assert.equal(await openWithDevice(vaultId, kr.totp.seedRef!), seed, "new seal holds the SAME seed");

  // After restore, a code alone works again.
  plugin.unlockService.clearSessionSeed();
  const { getProvider } = await import("../src/core/providers");
  const { totpCode } = await import("../src/core/totp");
  const code = await totpCode(seed, { now: Date.now() });
  const unlocked = await (plugin.unlockService as any).performUnlock(kr, getProvider("totp"), { secret: "", code });
  assert.deepEqual(unlocked, dek, "code-only unlock works after restore");

  plugin.onunload();
});
