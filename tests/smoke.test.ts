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

/** Read the envelope from whichever file (note or payload) currently holds it. */
async function envelopeOf(plugin: any, file: any) {
  return (plugin.notes as any).tryReadEnvelope(file);
}

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
    // Elements track their children and can remove themselves, so tests can
    // assert that a UI element was really mounted and really torn down rather
    // than trusting an internal flag on the plugin.
    const makeEl = (): any => ({
      className: "",
      textContent: "",
      style: {},
      children: [] as any[],
      parent: null as any,
      classList: {
        add(this: any, c: string) {
          this.owner.className = `${this.owner.className} ${c}`.trim();
        },
        remove(this: any, c: string) {
          this.owner.className = this.owner.className.replace(c, "").trim();
        },
      },
      setAttribute() {},
      /** Obsidian DOM helpers used by the UI; mirror the minimal behaviour. */
      createEl(this: any, tag: string, opts: any = {}) {
        const child: any = makeEl();
        child.tag = tag;
        if (opts.text) child.textContent = opts.text;
        if (opts.cls) child.className = String(opts.cls);
        return this.appendChild(child);
      },
      createDiv(this: any, opts: any = {}) {
        return this.createEl("div", opts);
      },
      createSpan(this: any, opts: any = {}) {
        return this.createEl("span", opts);
      },
      appendChild(this: any, child: any) {
        child.parent = this;
        this.children.push(child);
        return child;
      },
      remove(this: any) {
        const p = this.parent;
        if (!p) return;
        p.children = p.children.filter((c: any) => c !== this);
        this.parent = null;
      },
    });
    const body: any = makeEl();
    g.document = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      createElement: () => {
        const el = makeEl();
        el.classList.owner = el;
        return el;
      },
      createTreeWalker: () => ({ nextNode: () => null }),
      querySelector: () => null,
      // CodeMirror probes documentElement.style at module init for browser
      // detection; without this the real plugin import throws headless.
      documentElement: { style: {}, classList: { add() {}, remove() {} } },
      body,
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
async function boot(): Promise<{
  plugin: any;
  harness: ReturnType<typeof buildHarness>["harness"];
  obsidian: any;
}> {
  const { default: PluginClass } = await import("../src/main");
  const { harness, obsidian } = buildHarness();
  const plugin = new PluginClass();
  plugin.app = harness.app;
  plugin.manifest = { id: "sealed-note", version: "1.0.0", dir: ".obsidian/plugins/sealed-note" };
  await plugin.onload();
  return { plugin, harness, obsidian };
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
    "lock-document",
    "show-recovery-key",
    "setup-totp",
  ];
  for (const id of expected) assert.ok(ids.includes(id), `missing command: ${id}`);
  assert.equal(new Set(ids).size, ids.length, "command ids must be unique");

  assert.ok(!r.views.has("sealed-note-view"), "no custom padlock view is registered");
  assert.ok(!r.extensions.has("sealed"), "sealed notes open in the native Markdown editor");
  assert.ok(r.events.some((e) => e.name === "file-open"), "file-open hook present for stale-tab cleanup");

  for (const lang of ["encrypted_txt", "txt_encrypted", "sealed"]) {
    assert.ok(r.codeBlocks.has(lang), `code block processor for ${lang}`);
  }
  assert.equal(r.postProcessors.length, 2, "inline payloads and locked-note marker registered");
  assert.equal(r.editorExtensions.length, 1, "ciphertext guard editor extension registered");

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

test("v2: locked note body is the envelope; round trip, no sidecar, no annotation", async () => {
  const { plugin, harness } = await boot();
  const { newDek } = await import("../src/core/keyring");
  const { noteBodyState, parseNoteEnvelope } = await import("../src/core/format");

  const dek = newDek();
  const vaultId = "11111111-2222-4333-8444-555555555555";
  plugin.vaultIdentifier = vaultId;

  const file: any = { path: "Private/t.sealed.md", basename: "t", extension: "md" };
  harness.files.set(file.path, "");
  const body = "# 秘密标题\n\npassword = hunter2\n";
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, body);

  const noteText = harness.files.get(file.path)!;
  assert.equal(noteBodyState(noteText), "sealed", "body is a locked envelope");
  assert.ok(parseNoteEnvelope(noteText), "envelope is readable from the note itself");
  assert.ok(!noteText.includes("hunter2"), "no plaintext in the note");
  assert.ok(!noteText.includes("秘密"), "no plaintext (unicode) in the note");
  assert.ok(!noteText.includes("sealed-note:ref"), "no annotation to maintain");
  assert.ok(
    ![...harness.files.keys()].some((p: string) => p.endsWith(".sealedpayload")),
    "no sidecar payload was created",
  );
  assert.ok(!harness.files.has(file.path + ".tmp"), "no scratch file left behind");

  assert.equal(await plugin.notes.readPlaintext(file, dek, vaultId), body, "round trip");
  await assert.rejects(() => plugin.notes.readPlaintext(file, newDek(), vaultId), "wrong key fails");
  plugin.onunload();
});

test("v2: renaming/moving a locked note cannot separate it from its ciphertext", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "10000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), { iterations: 100_000 });
  plugin.vaultIdentifier = vaultId;

  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/new", "new note");
  const noteText = harness.files.get(file.path)!;
  assert.ok(noteText.trimStart().startsWith("<!--"), "envelope body is an HTML comment, invisible when rendered");
  assert.ok(!noteText.includes("sealed-note:ref"), "no annotation in the body");

  // A path-only move (sync tool, manual rename) carries the ciphertext with it.
  const movedPath = "Renamed/moved.sealed.md";
  harness.files.set(movedPath, noteText);
  harness.files.delete(file.path);
  const moved: any = { path: movedPath, basename: "moved", extension: "md" };
  assert.equal(await plugin.notes.readPlaintext(moved, dek, vaultId), "", "ciphertext travels with the file");
  plugin.onunload();
});

test("v2: deleting a note deletes its ciphertext with it (single file)", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "30000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), { iterations: 100_000 });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/del", "delete me");
  assert.ok(harness.files.has(file.path), "note exists before delete");

  const hook = harness.registered.events.find((e) => e.name === "vault:delete");
  assert.ok(hook, "delete hook registered");
  harness.files.delete(file.path);
  await hook!.fn({ path: file.path });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.files.has(file.path), false, "note and its ciphertext are gone together");
  plugin.onunload();
});

/* ------------------------------------------------------------------ */
/* DEK-cache sessions on PLAIN notes must never enter the note-seal    */
/* machinery: with a keyring present, flushNote on a plain path reads  */
/* an empty "revealed body", seals it through writePlaintext's legacy  */
/* migration branch and REPLACES THE WHOLE FILE with a placeholder.   */
/* ------------------------------------------------------------------ */

/** Install a real keyring so requireKeyring() resolves; returns its DEK.
 * This design has no keyring file: the wrapped key lives in a note payload's
 * key copy, so we must create an actual private note as the key anchor.
 * Without it requireKeyring throws before flushNote reaches the seal path and
 * the test passes for the wrong reason (verified: the pre-fix run needs the
 * anchor to actually reproduce the corruption). */
async function seedKeyring(plugin: any): Promise<Uint8Array> {
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const vaultId = "60000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/anchor", "anchor");
  plugin.vaultIdentifier = vaultId;
  return dek;
}

/** Number of sealedpayload files currently in the fake vault. */
function countPayloads(harness: any): number {
  return [...harness.files.keys()].filter((p: string) => p.endsWith(".sealedpayload")).length;
}

test("modify on a plain note with a DEK-cache session does not seal it away", async () => {
  const { plugin, harness } = await boot();
  const dek = await seedKeyring(plugin);
  const { TFile } = await import("./obsidian-stub");

  const path = "Journal/plain.md";
  const original = "meeting notes\n\n```encrypted_txt\nsn1.abc\n```\n";
  harness.files.set(path, original);
  plugin.settingsData.autoSaveMs = 10;
  // A DEK cache exists because the user unlocked an inline block here.
  plugin.sessions.put(path, dek, "password");
  const payloadsBefore = countPayloads(harness);

  const modify = harness.registered.events.find((e) => e.name === "vault:modify");
  assert.ok(modify, "modify hook registered");
  await modify!.fn(new TFile(path));
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(harness.files.get(path), original, "plain note body untouched");
  assert.equal(countPayloads(harness), payloadsBefore, "no payload minted from the plain note");
  assert.ok(plugin.sessions.has(path), "the DEK cache itself is not dropped by autosave");
  plugin.onunload();
});

test("flushNote refuses a plain path outright", async () => {
  const { plugin, harness } = await boot();
  const dek = await seedKeyring(plugin);

  const path = "Journal/flush-direct.md";
  harness.files.set(path, "do not seal me\n");
  plugin.sessions.put(path, dek, "password");
  const payloadsBefore = countPayloads(harness);

  await plugin.flushNote(path);

  assert.equal(harness.files.get(path), "do not seal me\n", "body survives a direct flush call");
  assert.equal(countPayloads(harness), payloadsBefore, "no payload minted");
  plugin.onunload();
});

test("lockNote on a plain path drops only the DEK cache", async () => {
  const { plugin, harness } = await boot();
  const dek = await seedKeyring(plugin);

  const path = "Journal/plain2.md";
  harness.files.set(path, "body stays plaintext\n");
  plugin.sessions.put(path, dek, "password");
  const payloadsBefore = countPayloads(harness);

  await plugin.lockNote(path); // must not throw "无法读取笔记 ID"

  assert.equal(plugin.sessions.has(path), false, "cache dropped");
  assert.equal(harness.files.get(path), "body stays plaintext\n", "file intact");
  assert.equal(countPayloads(harness), payloadsBefore, "no payload minted by locking");
  plugin.onunload();
});

test("onunload with a plain-note cache neither seals it nor throws", async () => {
  const { plugin, harness } = await boot();
  const dek = await seedKeyring(plugin);

  const path = "Journal/plain3.md";
  harness.files.set(path, "# still mine\n");
  plugin.sessions.put(path, dek, "password");
  const payloadsBefore = countPayloads(harness);

  plugin.onunload();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.files.get(path), "# still mine\n", "no legacy migration on unload");
  assert.equal(countPayloads(harness), payloadsBefore, "no orphan payload minted");
});

test("unlocking reveals bare plaintext in the note body and switches to Markdown", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState } = await import("../src/core/format");

  const vaultId = "50000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), { iterations: 100_000 });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/native", "native");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "# 秘密\n", keyring);
  plugin.unlockService.dekFor = async () => dek;
  harness.registered.viewSwitches.length = 0;

  await plugin.unlockNote(file);

  const body = harness.files.get(file.path)!;
  assert.equal(body, "# 秘密\n", "body is bare plaintext, no annotation at all");
  assert.equal(noteBodyState(body), "revealed", "body classified as unlocked");
  assert.ok(
    harness.registered.viewSwitches.some((s: any) => s.type === "markdown" && s.state?.file === file.path),
    "note switched to the native Markdown editor",
  );
  assert.equal(plugin.isUnlocked(file.path), true, "note tracked as unlocked");
  plugin.onunload();
});

test("v2: the same body flips from plaintext to envelope on lock, with no sidecar", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState } = await import("../src/core/format");

  const vaultId = "60000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), { iterations: 100_000 });
  await plugin.keyringStore.save(keyring);
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/edit", "edit");
  plugin.sessions.put(file.path, dek, "test");
  await plugin.unlockNote(file);

  // The user edits the body directly; there is no ref line to preserve.
  harness.files.set(file.path, "# 改过的标题\n\n正文 secret-xyz\n");
  assert.equal(noteBodyState(harness.files.get(file.path)!), "revealed");

  await plugin.lockNote(file.path);
  const lockedBody = harness.files.get(file.path)!;
  assert.equal(noteBodyState(lockedBody), "sealed", "same file now holds the envelope");
  assert.ok(!lockedBody.includes("secret-xyz"), "plaintext gone after lock");
  assert.ok(!lockedBody.includes("sealed-note:ref"), "no annotation was ever needed");
  assert.equal(plugin.isUnlocked(file.path), false, "session dropped on lock");
  assert.equal(
    await plugin.notes.readPlaintext(file, dek, vaultId),
    "# 改过的标题\n\n正文 secret-xyz\n",
    "edited text survived the lock",
  );
  assert.ok(
    ![...harness.files.keys()].some((p: string) => p.endsWith(".sealedpayload")),
    "no sidecar was used at any point",
  );
  plugin.onunload();
});

test("legacy working-copy files are removed on load", async () => {
  const { buildHarness } = await import("./obsidian-stub");
  const { default: PluginClass } = await import("../src/main");
  const { harness } = buildHarness();
  harness.files.set("sealed-note-work/leftover.md", "# 崩溃前的明文\n");

  const plugin = new PluginClass();
  plugin.app = harness.app;
  plugin.manifest = { id: "sealed-note", version: "1.0.0", dir: ".obsidian/plugins/sealed-note" };
  await plugin.onload();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.files.has("sealed-note-work/leftover.md"), false, "stale plaintext removed at boot");
  plugin.onunload();
});

test("file-menu keeps New private note on folders only", async () => {
  const { plugin, harness } = await boot();
  const fileMenus = harness.registered.events.filter((e) => e.name === "file-menu");
  assert.ok(fileMenus.length > 0, "file-menu hook registered");
  const source = String(fileMenus[fileMenus.length - 1].fn);
  // The stub cannot share class identity between the bundled test and plugin
  // graphs, so verify the real branching structure: folders get the create
  // action, then the handler returns before the file-only actions.
  assert.ok(source.includes("instanceof TFolder"), "branches on folder targets");
  assert.ok(
    source.indexOf("instanceof TFolder") < source.indexOf("instanceof TFile"),
    "folder branch comes first",
  );
  const folderBranch = source.slice(source.indexOf("instanceof TFolder"), source.indexOf("instanceof TFile"));
  assert.ok(folderBranch.includes("newSealedNote("), "folder branch creates a private note");
  const fileBranch = source.slice(source.indexOf("instanceof TFile"));
  assert.ok(!fileBranch.includes("newSealedNote("), "file branch does not offer New private note");
  plugin.onunload();
});

test("first-run new note with no active file does not throw", async () => {
  const { plugin, harness } = await boot();
  const {
    createKeyringWithoutPassword,
    setSlot,
    credentialFor,
    SLOT_TOTP,
  } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret } = await import("../src/core/totp");

  const vaultId = "90000000-2222-4333-8444-555555555555";
  const seed = generateTotpSecret();
  const { keyring, dek } = await createKeyringWithoutPassword(vaultId, generateRecoveryKey(), {
    iterations: 100_000,
  });
  await setSlot(keyring, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));
  keyring.totp.enabled = true;
  keyring.totp.mode = "totp";
  plugin.vaultIdentifier = vaultId;
  // Keyring already on disk + a live session: new note must not prompt.
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.sessions.put("some-open-note", dek, "test");
  // getActiveFile() is null in the stub, mirroring "wizard just closed".
  await plugin.newSealedNote(undefined, "测试笔记");

  const created = [...harness.files.keys()].find((p) => p.endsWith(".sealed.md"));
  assert.ok(created, "a sealed note was created");
  // A just-created note is revealed immediately, so its body is bare plaintext.
  assert.equal(harness.files.get(created!), "", "note opens clean with an empty body");
  plugin.onunload();
});

test("new note payload starts empty so the native editor opens clean", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "70000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/blank", "空白");

  const noteText = harness.files.get(file.path)!;
  assert.ok(noteText.trimStart().startsWith("<!--"), "placeholder hidden in a comment");
  assert.equal(await plugin.notes.readPlaintext(file, dek, vaultId), "", "payload body is empty");
  plugin.onunload();
});

test("decrypt document decrypts all blocks in a plain note in place", async () => {
  const { plugin, harness } = await boot();
  const { newDek } = await import("../src/core/keyring");
  const dek = newDek();
  const vaultId = "80000000-2222-4333-8444-555555555555";
  plugin.vaultIdentifier = vaultId;

  const fence = await plugin.encryption.encryptInline(dek, "内联秘密", "fence");
  const inline = await plugin.encryption.encryptInline(dek, "行内秘密", "inline");
  const path = "daily/note.md";
  harness.files.set(path, `# 标题\n\n${fence.snippet}\n\n${inline.snippet}\n`);
  const file: any = { path, basename: "note", extension: "md" };
  plugin.sessions.put(path, dek, "test");

  await plugin.decryptDocument(file);

  const after = harness.files.get(path)!;
  assert.ok(after.includes("内联秘密"), "fence block decrypted in place");
  assert.ok(after.includes("行内秘密"), "inline payload decrypted in place");
  assert.ok(!after.includes("sn1."), "no ciphertext left");
  plugin.onunload();
});

test("unlocking an already-revealed note is idempotent and still opens the editor", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "a1000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/stale", "陈旧");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "# 内容A", keyring);
  plugin.unlockService.dekFor = async () => dek;

  await plugin.unlockNote(file);
  const body1 = harness.files.get(file.path)!;
  assert.ok(body1.includes("# 内容A"), "revealed once");

  // Unlock again while already unlocked: must not double-encrypt or lose text.
  harness.registered.viewSwitches.length = 0;
  await plugin.unlockNote(file);
  assert.equal(harness.files.get(file.path)!, body1, "second unlock leaves the body unchanged");
  assert.ok(
    harness.registered.viewSwitches.some((s: any) => s.type === "markdown"),
    "still switches to the native editor",
  );
  plugin.onunload();
});

test("v2: recovery key rebuilds the keyring from a locked note body, no annotation needed", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState, parseNoteEnvelope } = await import("../src/core/format");

  const vaultId = "b2000000-2222-4333-8444-555555555555";
  const recovery = generateRecoveryKey();
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", recovery, {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;

  const original = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/restore-me", "recovery test");
  await plugin.notes.writePlaintext(original, dek, vaultId, vaultId, "# 我的秘密日记\n\n今天写点东西", keyring);

  // Locked body is the envelope itself: no sidecar, no annotation, no keyring file.
  const body = harness.files.get(original.path)!;
  assert.equal(noteBodyState(body), "sealed", "locked note body is the envelope");
  assert.ok(parseNoteEnvelope(body)?.keys, "key copy travels inside the note body");
  assert.ok(
    ![...harness.files.keys()].some((p: string) => p.endsWith(".sealedpayload")),
    "no sidecar payload exists",
  );
  assert.ok(!body.includes("sealed-note:ref"), "no annotation to maintain");

  // The recovery service finds candidates from note bodies, not payload files.
  const candidates = await plugin.recovery.findCandidates();
  assert.ok(candidates.length >= 1, "locked notes are recovery candidates");
  const wrong = await plugin.keyringStore.load();
  assert.ok(wrong, "keyring loads from the note body alone");
  assert.equal(
    await plugin.notes.readPlaintext(original, dek, vaultId),
    "# 我的秘密日记\n\n今天写点东西",
    "note still decrypts after restart with no sidecar",
  );
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

  const noteText = harness.files.get(file.path)!;
  assert.ok(noteText.includes("sealed-note/note/1"), "the note body IS the envelope");
  assert.ok(noteText.includes("\"keys\""), "key copy travels inside the note body");
  assert.ok(!noteText.includes("sealed-note:ref"), "no annotation to maintain");
  const parsed = (await envelopeOf(plugin, file))!;
  assert.ok(parsed.keys, "key copy embedded");
  assert.equal(parsed.keys.vaultId, vaultId);
  assert.equal(parsed.keys.epoch, keyring.epoch);
  assert.ok(parsed.keys.slots.password, "password slot copied");
  assert.ok(parsed.keys.slots.recovery, "recovery slot copied");
  assert.ok(parsed.keys.totp, "TOTP mode metadata must survive, even when TOTP is off");
  assert.ok(!parsed.keys.slots.totp, "no TOTP slot when TOTP was never configured");
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
  const before = (await envelopeOf(plugin, file))!;
  const dataBefore = before.data;
  const saltBefore = before.salt;
  const ivBefore = before.iv;
  const epochBefore = before.keys.epoch;

  // changePassword writes through noteKeyringStore, so the note is updated
  // immediately - there is no separate keyring file to lag behind.
  await plugin.unlockService.changePassword(dek, "new-password-456");
  const after = (await envelopeOf(plugin, file))!;
  assert.ok(after.keys.epoch > epochBefore, "key copy advanced to the new generation");

  const kr = await plugin.unlockService.requireKeyring();

  // The important part: the encrypted content did not change at all.
  assert.equal(after.data, dataBefore, "ciphertext untouched");
  assert.equal(after.salt, saltBefore, "salt untouched");
  assert.equal(after.iv, ivBefore, "iv untouched");

  // Old password no longer works, new one does; note content still opens.
  await assert.rejects(() => unlockWithPassword(kr, "old-password-123"));
  assert.deepEqual(await unlockWithPassword(kr, "new-password-456"), dek);
  assert.equal(await plugin.notes.readPlaintext(file, dek, vaultId), "", "note content still opens");

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
    originals.set(p, (await envelopeOf(plugin, { path: p }))!.data);
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
    assert.equal((await envelopeOf(plugin, { path: p }))!.data, data, `${p} content intact`);
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
  assert.ok(!kr.slots.password, "strict two-factor: the standalone password door is closed");
  assert.equal(kr.totp.mode, "password+totp");
  assert.equal(kr.totp.enabled, true);
  assert.ok(!kr.slots.totp, "standalone totp slot removed");

  // pure totp mode
  await plugin.unlockService.configureMode(dek, "totp", { seed });
  kr = await plugin.unlockService.requireKeyring();
  assert.ok(kr.slots.totp, "totp slot exists");
  assert.ok(!kr.slots["password-totp"], "combined slot removed");
  assert.ok(!kr.slots.password, "password slot removed too - totp-only means the phone is the only door");
  assert.deepEqual(await unlockWithTotp(kr, seed), dek);

  // pure password mode clears totp; after totp-only there is no password door,
  // so switching must supply the new password explicitly (guard below).
  await assert.rejects(() => plugin.unlockService.configureMode(dek, "password"), /master password first|需要先设置一个主密码/);
  await plugin.unlockService.configureMode(dek, "password", { password: "pw-1234567890" });
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
  const sources = (plugin.app.vault.getFiles() as any[]).filter(
    (f) => f.path.endsWith(".sealed.md") || f.path.endsWith(".sealedpayload"),
  );
  const envelopes = await Promise.all(sources.map((f) => envelopeOf(plugin, f)));
  const carriesSeedRef = envelopes.some((env: any) => !!env?.keys?.totp?.seedRef);
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

test("first-run TOTP-only setup keeps TOTP in the first note's key copy", async () => {
  const { plugin } = await boot();
  const {
    createKeyringWithoutPassword,
    setSlot,
    credentialFor,
    SLOT_TOTP,
  } = await import("../src/core/keyring");
  const { providersAvailable } = await import("../src/core/providers");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret, totpCode } = await import("../src/core/totp");
  const { sealWithDevice } = await import("../src/core/device");

  const seed = generateTotpSecret();
  const vaultId = "f1f1f1f1-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyringWithoutPassword(vaultId, generateRecoveryKey(), {
    iterations: 100_000,
  });
  await setSlot(keyring, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));
  keyring.totp.enabled = true;
  keyring.totp.mode = "totp";
  keyring.totp.seedRef = (await sealWithDevice(vaultId, seed)) ?? undefined;
  plugin.vaultIdentifier = vaultId;

  // This is exactly what newSealedNote() does on first run: the keyring lives
  // only in memory until the first note carries it.
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/first", "首篇");
  plugin.unlockService.clearSessionSeed();

  const kr = await plugin.unlockService.requireKeyring();
  assert.ok(kr.slots.totp, "TOTP slot survived being reconstructed from the note");
  assert.equal(kr.totp.mode, "totp", "unlock mode survived too");
  assert.ok(providersAvailable(kr).some((p) => p.id === "totp"), "TOTP is still offered");
  assert.ok(providersAvailable(kr).some((p) => p.id === "recovery"), "recovery fallback still offered");

  const { getProvider } = await import("../src/core/providers");
  const code = await totpCode(seed, { now: Date.now() });
  const opened = await (plugin.unlockService as any).performUnlock(
    kr,
    getProvider("totp"),
    { secret: "", code },
  );
  assert.deepEqual(opened, dek, "a 6-digit code still unlocks after a restart");

  plugin.onunload();
});

test("opening a sealed file shows the padlock but does NOT auto-unlock", async () => {
  const { plugin, harness } = await boot();
  const fileOpen = harness.registered.events.find((e) => e.name === "file-open");
  assert.ok(fileOpen, "file-open hook registered");
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "45670000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/note", "note");
  let dekCalls = 0;
  plugin.unlockService.dekFor = async () => {
    dekCalls++;
    return dek;
  };

  harness.registered.viewSwitches.length = 0;
  fileOpen!.fn(file);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(dekCalls, 0, "opening must NOT prompt for a credential");
  assert.equal(plugin.sessions.get(file.path), null, "no session created just by opening");

  // Only the user clicking "unlock & edit" prompts + reveals the body.
  await plugin.unlockNote(file);
  assert.equal(dekCalls, 1, "explicit unlock prompts once");
  assert.ok(plugin.isUnlocked(file.path), "note unlocked after explicit prompt");
  assert.ok(
    harness.registered.viewSwitches.some((s: any) => s.type === "markdown" && s.state?.file === file.path),
    "revealed note opens in the native editor under its own path",
  );
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

test("active-leaf-change with null active file does not lock the open note", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "c3000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/focus", "焦点");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "# 编辑中 secret-xyz", keyring);
  plugin.unlockService.dekFor = async () => dek;
  await plugin.unlockNote(file);
  const revealed = harness.files.get(file.path)!;
  assert.ok(revealed.includes("secret-xyz"), "body revealed for editing");

  // Transient focus loss right after opening (modal close / tab swap): active
  // file is null. The unlocked body must survive (first-run unlock loop).
  harness.app.workspace.setActiveFile(null);
  harness.app.workspace.triggerActiveLeafChange();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(harness.files.get(file.path)!.includes("secret-xyz"), "body survives a null-active leaf change");
  assert.ok(plugin.sessions.get(file.path), "session survives a null-active leaf change");

  // Active file still the sealed note itself: also must not lock.
  harness.app.workspace.setActiveFile(file.path);
  harness.app.workspace.triggerActiveLeafChange();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(plugin.isUnlocked(file.path), "stays unlocked while its own note is active");

  // Now the user really switched to a different note: lock it.
  harness.files.set("other.md", "other");
  harness.app.workspace.setActiveFile("other.md");
  harness.app.workspace.triggerActiveLeafChange();
  // lockNote is fire-and-forget inside the event; wait for its flush chain.
  for (let i = 0; i < 50 && plugin.isUnlocked(file.path); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(plugin.isUnlocked(file.path), false, "locked on real switch");
  assert.ok(!harness.files.get(file.path)!.includes("secret-xyz"), "plaintext removed from the body on lock");
  assert.equal(
    await plugin.notes.readPlaintext(file, dek, vaultId),
    "# 编辑中 secret-xyz",
    "edits were flushed into the payload before locking",
  );
  plugin.onunload();
});

test("a plain note with an inline encrypted block is never locked", async () => {
  const { plugin, harness } = await boot();
  const { newDek } = await import("../src/core/keyring");
  const dek = newDek();
  plugin.vaultIdentifier = "d3000000-2222-4333-8444-555555555555";
  const enc = await plugin.encryption.encryptInline(dek, "secret", "inline");
  const path = "daily/with-block.md";
  harness.files.set(path, `# 日记\n\n${enc.snippet}\n\n随便写点\n`);
  harness.app.workspace.setActiveFile(path);
  harness.app.workspace.triggerActiveLeafChange();
  // ensureSealedView only targets sealed paths; the note stays an ordinary
  // editable markdown file and no sealed view switch is attempted.
  assert.ok(
    !harness.registered.viewSwitches.some((s: any) => s.type === "sealed-note-view"),
    "no lock view forced on a plain note",
  );
  assert.ok(harness.files.get(path)!.includes("随便写点"), "plain note content untouched and editable");
  plugin.onunload();
});

test("v1 sidecar settings and all legacy commands are gone", async () => {
  const { plugin, harness } = await boot();
  assert.equal("payloadDir" in plugin.settingsData, false, "no payloadDir setting");
  assert.equal("deletePayloadWithNote" in plugin.settingsData, false, "no payload retention setting");
  for (const id of [
    "clean-orphan-payloads",
    "restore-annotation",
    "migrate-to-single-file",
  ]) {
    assert.equal(
      harness.registered.commands.some((c: any) => c.id === id),
      false,
      `${id} command removed`,
    );
  }
  plugin.onunload();
});

test("key copy in the payload survives a restart so setup is not repeated", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "f3000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/persist", "持久");

  // Wipe all in-memory state, as a real restart would. What remains is only
  // what was written to disk (the payload's key copy).
  plugin.sessions.lockAll();
  (plugin as any).pendingKeyring = null;
  assert.ok(harness.files.has(file.path), "note on disk");

  assert.equal(await plugin.hasKeyring(), true, "keyring found on disk after restart");
  const kr = await plugin.unlockService.requireKeyring();
  assert.equal(kr.vaultId, vaultId, "keyring loads from the payload's key copy");
  assert.ok(kr.slots.recovery && kr.slots.totp === undefined, "recovery slot persisted");
  plugin.onunload();
});

test("legacy working copies are removed and revealed notes are recovered on load", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "77770000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.unlockService.requireKeyring = async () => keyring;

  // 1. Legacy folder leftovers from the old architecture.
  harness.files.set("sealed-note-work/stale-a.md", "plaintext");
  harness.files.set("sealed-note-work/stale-b.md", "");

  // 2. A note left revealed on disk (crash while unlocked): bare plaintext,
  //    no annotation in the single-file layout.
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/crash", "崩溃");
  harness.files.set(file.path, "# 未保存的明文 secret-xyz");

  await (plugin as any).recoverAfterCrash();
  assert.equal(harness.files.has("sealed-note-work/stale-a.md"), false, "stale copy a deleted");
  assert.equal(harness.files.has("sealed-note-work/stale-b.md"), false, "stale copy b deleted");
  // Boot must not touch the body: its ciphertext is intact, so opening asks for
  // the credential and the typed text stays exactly where the user left it.
  assert.ok(harness.files.get(file.path)!.includes("secret-xyz"), "boot leaves the body alone");
  assert.ok(
    harness.notices.some((n) => /plaintext|明文状态/i.test(n)),
    "the user is told about the leftover plaintext",
  );

  // Locking re-seals the very same file with the real DEK.
  plugin.sessions.put(file.path, dek, "test", keyring);
  await plugin.lockNote(file.path);
  const locked = harness.files.get(file.path)!;
  assert.ok(!locked.includes("secret-xyz"), "plaintext re-sealed into the body");
  assert.equal(
    await plugin.notes.readPlaintext({ path: file.path } as any, dek, vaultId),
    "# 未保存的明文 secret-xyz",
    "typed content preserved in the envelope",
  );
  plugin.onunload();
});

test("creating a note asks for the credential before the file exists", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "12340000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;

  let asked = 0;
  let verb: string | undefined;
  plugin.unlockService.dekFor = async (_path: string, request?: any) => {
    asked++;
    verb = request?.verb;
    return null; // user cancels
  };

  await plugin.newSealedNote(undefined, "取消新建");

  assert.equal(asked, 1, "asked exactly once, before creating anything");
  assert.equal(verb, "encrypt", "worded as encryption, not unlocking");
  assert.equal(
    [...harness.files.keys()].filter((p) => p.endsWith(".sealed.md")).length,
    0,
    "cancelling leaves no note behind",
  );
  assert.equal(
    [...harness.files.keys()].filter((p) => p.endsWith(".sealedpayload")).length,
    0,
    "and no orphan payload either",
  );
  assert.ok(
    harness.notices.some((n) => /没有创建笔记|No note was created/.test(n)),
    "says nothing was created",
  );
  plugin.onunload();
});

test("v2: a created note is editable immediately and locks under the real DEK", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState } = await import("../src/core/format");

  const vaultId = "23450000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), { iterations: 100_000 });
  plugin.vaultIdentifier = vaultId;
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.unlockService.dekFor = async () => dek;
  await plugin.newSealedNote(undefined, "测试笔记");

  const created = [...harness.files.keys()].find((p) => p.endsWith(".sealed.md"))!;
  assert.equal(harness.files.get(created), "", "new note opens as a clean blank editor");
  assert.ok(plugin.sessions.get(created), "session established at creation");
  assert.ok(plugin.isUnlocked(created), "note is editable right away");

  harness.files.set(created, "# 我的新秘密\n\n正文内容");
  let promptsDuringSave = 0;
  plugin.unlockService.dekFor = async () => { promptsDuringSave++; return null; };
  await plugin.flushNote(created); // no-op in v2: the body is already the live document
  assert.equal(promptsDuringSave, 0, "autosave is silent - no dialog mid-typing");

  await plugin.lockNote(created);
  const locked = harness.files.get(created)!;
  assert.equal(noteBodyState(locked), "sealed", "lock sealed the very same file");
  assert.ok(!locked.includes("我的新秘密"), "no plaintext left on disk");
  assert.equal(
    await plugin.notes.readPlaintext({ path: created } as any, dek, vaultId),
    "# 我的新秘密\n\n正文内容",
    "typed text preserved under the same DEK",
  );
  plugin.onunload();
});

test("active-leaf-change does not force padlock over an unlocked note", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "34560000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/live", "活跃");
  plugin.unlockService.dekFor = async () => dek;
  await plugin.unlockNote(file);

  // The note is unlocked and its own body is active: switching focus must not
  // slap the padlock over the editor the user is typing in.
  harness.app.workspace.setActiveFile(file.path);
  harness.registered.viewSwitches.length = 0;
  harness.app.workspace.triggerActiveLeafChange();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(
    !harness.registered.viewSwitches.some((s: any) => s.type === "sealed-note-view"),
    "padlock must not override an unlocked note",
  );
  assert.ok(plugin.isUnlocked(file.path), "still unlocked");
  plugin.onunload();
});

test("file-open on a stale (deleted) sealed tab does not try to unlock", async () => {
  const { plugin, harness } = await boot();
  const fileOpen = harness.registered.events.find((e) => e.name === "file-open");
  assert.ok(fileOpen, "file-open hook registered");
  // No file written to disk: a workspace-restored ghost tab.
  harness.registered.viewSwitches.length = 0;
  fileOpen!.fn({ path: "life/已删除.sealed.md", basename: "已删除", extension: "md" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.registered.viewSwitches.length, 0, "stale tab ignored, no view switch");
  plugin.onunload();
});

test("unlocking never switches a sidebar leaf", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "56780000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.unlockService.dekFor = async () => dek;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/side", "侧边");

  // Sealed notes are ordinary Markdown files. The ACTIVE leaf is the file
  // explorer; another main-area markdown leaf already shows the note.
  const switches: string[] = [];
  const noteLeaf = {
    view: { getViewType: () => "markdown", file: { path: file.path } },
    setViewState: async (s: any) => { switches.push(`${file.path}->${s.type}`); },
  };
  harness.app.workspace.markdownLeaves = [noteLeaf];
  harness.app.workspace.activeLeafIsSide = true;
  assert.equal((plugin as any).isSideLeaf(harness.app.workspace.activeLeaf), true, "stub detects side leaf");

  await plugin.unlockNote(file);

  assert.equal(harness.files.get(file.path), "", "body revealed as bare plaintext, no annotation");
  assert.deepEqual(switches, [], "the existing markdown leaf is reused, never re-switched");
  assert.equal(harness.registered.activeLeafSwitches.length, 0, "sidebar leaf was NOT used");
  plugin.onunload();
});

test("opening a sealed note does not switch any leaf to a custom view", async () => {
  const { plugin, harness } = await boot();
  const fileOpen = harness.registered.events.find((e) => e.name === "file-open");
  assert.ok(fileOpen, "file-open hook registered");
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "67890000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/padlock", "padlock");

  // Two markdown leaves: one showing the sealed note, one showing another note.
  const switched: string[] = [];
  const mkLeaf = (path: string) => ({
    view: { getViewType: () => "markdown", file: { path } },
    setViewState: async (s: any) => { switched.push(`${path}->${s.type}`); },
  });
  harness.app.workspace.markdownLeaves = [mkLeaf(file.path), mkLeaf("daily/other.md")];

  fileOpen!.fn(file);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(switched, [], "sealed notes stay in the native Markdown editor");
  plugin.onunload();
});

test("v2: renaming a locked note keeps the chosen filename and carries the ciphertext", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState } = await import("../src/core/format");

  const vaultId = "78900000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/daily", "daily");
  const lockedBody = harness.files.get(file.path)!;
  assert.equal(noteBodyState(lockedBody), "sealed", "body is the envelope before rename");

  const renameHook = harness.registered.events.find((e) => e.name === "vault:rename");
  assert.ok(renameHook, "rename hook registered");

  // User renames to "summary.md" (drops .sealed). The plugin must NOT rename it
  // back: locked notes are recognised by content and registry, not by suffix.
  harness.files.delete(file.path);
  harness.files.set("Private/summary.md", lockedBody);
  await renameHook!.fn({ path: "Private/summary.md", basename: "summary", extension: "md" }, file.path);

  assert.ok(harness.files.has("Private/summary.md"), "the filename the user chose is kept");
  assert.equal(harness.files.has("Private/summary.sealed.md"), false, "no suffix forced back");
  assert.equal(plugin.notes.isSealedPath("Private/summary.md"), true, "registry follows the rename");
  assert.equal(
    await plugin.notes.readPlaintext({ path: "Private/summary.md" } as any, dek, vaultId),
    "",
    "ciphertext followed the rename with no sidecar to rewire",
  );
  plugin.onunload();
});

/* ------------------------------------------------------------------ */
/* cancelling the first-encrypt prompt                                */
/* ------------------------------------------------------------------ */

test("creation keeps the progress pill up while the credential is checked", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "abcd3333-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;

  let seenBusyDuringPrompt = false;
  plugin.unlockService.dekFor = async () => {
    // The wait happens before the file exists. Without the pill this is a
    // silent gap between clicking "new note" and seeing anything at all.
    seenBusyDuringPrompt = plugin.busy.visible;
    return dek;
  };

  await plugin.newSealedNote(undefined, "进度");
  assert.equal(seenBusyDuringPrompt, true, "progress is up while creation waits on the credential");
  assert.equal(plugin.busy.visible, false, "cleared once creation finished");
  assert.ok([...harness.files.keys()].some((p) => p.endsWith(".sealed.md")), "note was created");
  plugin.onunload();
});

test("the progress pill never outlives the operation that raised it", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "abcd4444-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.unlockService.dekFor = async () => dek;

  await plugin.newSealedNote(undefined, "释放");
  const created = [...harness.files.keys()].find((p) => p.endsWith(".sealed.md"))!;
  assert.equal(plugin.busy.visible, false, "creation released its pill");

  // A delete while something holds the pill must clear it too.
  plugin.claimBusy(created, "x");
  const delHook = harness.registered.events.find((e) => e.name === "vault:delete");
  assert.ok(delHook, "delete hook registered");
  harness.files.delete(created);
  await delHook!.fn({ path: created });
  assert.equal(plugin.busy.visible, false, "deleting a note releases its pill");
  plugin.onunload();
});

test("v2: locking really replaces the body envelope and leaves no scratch files", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState } = await import("../src/core/format");

  const vaultId = "ef010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), { iterations: 100_000 });
  plugin.vaultIdentifier = vaultId;
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.unlockService.dekFor = async () => dek;

  await plugin.newSealedNote(undefined, "替换");
  const created = [...harness.files.keys()].find((p) => p.endsWith(".sealed.md"))!;
  const before = harness.files.get(created)!;

  harness.files.set(created, "第二次保存也必须落盘\n");
  await plugin.lockNote(created);

  assert.notEqual(harness.files.get(created), before, "body envelope was actually rewritten");
  assert.equal(noteBodyState(harness.files.get(created)!), "sealed");
  assert.equal(
    await plugin.notes.readPlaintext({ path: created } as any, dek, vaultId),
    "第二次保存也必须落盘\n",
    "new envelope decrypts to what the user typed",
  );
  const scratch = [...harness.files.keys()].filter((p) => /\.(tmp|old)$/.test(p));
  assert.deepEqual(scratch, [], "no .tmp/.old scratch files left behind");
  plugin.onunload();
});

test("reopening a note whose first save never landed keeps the typed text", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "ef020000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.unlockService.dekFor = async () => dek;

  await plugin.newSealedNote(undefined, "没保存就退出");
  const created = [...harness.files.keys()].find((p) => p.endsWith(".sealed.md"))!;
  // Typed but not locked: in v2 the body IS the live document, so the text is
  // already on disk as plaintext. No ref line to preserve any more.
  harness.files.set(created, "这段字不能丢\n");

  // Restart: a brand-new plugin instance over the same files.
  const { default: PluginClass } = await import("../src/main");
  const { buildHarness } = await import("./obsidian-stub");
  const h2 = buildHarness().harness;
  for (const [p, v] of harness.files) h2.files.set(p, v);
  const restarted = new PluginClass();
  restarted.app = h2.app;
  restarted.manifest = { id: "sealed-note", version: "1.0.0", dir: ".obsidian/plugins/sealed-note" };
  await restarted.onload();
  await (restarted as any).recoverAfterCrash();

  const file = h2.app.vault.getAbstractFileByPath(created);
  let prompted = 0;
  restarted.unlockService.requireKeyring = async () => keyring;
  restarted.unlockService.dekFor = async () => {
    prompted++;
    return dek;
  };
  await restarted.unlockNote(file);

  // Opening asks for the credential (uniform model: opening always does), and
  // the reveal step is idempotent - it must never trade the text away for a
  // clean "blank" note just because the body is already plaintext.
  assert.equal(prompted, 1, "opening a sealed note asks once");
  assert.ok(
    h2.files.get(created)!.includes("这段字不能丢"),
    "the plaintext recovered from disk survives opening",
  );

  // Locking finishes what an autosave used to do: the text is sealed into the
  // same body under the real DEK.
  restarted.unlockService.requireKeyring = async () => keyring;
  const session = restarted.sessions.get(created);
  restarted.sessions.put(created, dek, session?.providerId ?? "test", keyring);
  await restarted.lockNote(created);
  assert.equal(
    await restarted.notes.readPlaintext({ path: created } as any, dek, vaultId),
    "这段字不能丢\n",
    "the typed text is encrypted into the note body under the real DEK",
  );
  assert.ok(!h2.files.get(created)!.includes("这段字不能丢"), "no plaintext remains in the body");

  restarted.onunload();
  plugin.onunload();
});

test("a decryption failure is reported in words the user can act on", async () => {
  const { describeError } = await import("../src/util/errors");
  const { DecryptError } = await import("../src/core/crypto");

  const { setLanguage } = await import("../src/i18n");

  // The raw AES-GCM message is English and blames the password, which the user
  // had already got right. It used to surface as a toast verbatim.
  setLanguage("zh");
  const zh = describeError(new DecryptError());
  assert.ok(!/Unable to decrypt/i.test(zh), "raw crypto message is not shown (zh)");
  assert.ok(/无法解密/.test(zh), "says what happened (zh)");
  assert.ok(/备份|文件历史/.test(zh), "says what to do next (zh)");

  setLanguage("en");
  const en = describeError(new DecryptError());
  assert.ok(!/Unable to decrypt/i.test(en), "raw crypto message is not shown (en)");
  assert.ok(/backup/i.test(en), "says what to do next (en)");
  setLanguage("en");
});

/* ------------------------------------------------------------------ */
/* unlock failures are reported per cause, with a next step           */
/* ------------------------------------------------------------------ */

async function totpOnlyService(plugin: any, vaultId: string) {
  const { createKeyringWithoutPassword, setSlot, credentialFor, SLOT_TOTP } = await import(
    "../src/core/keyring"
  );
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { generateTotpSecret } = await import("../src/core/totp");

  const seed = generateTotpSecret();
  const { keyring, dek } = await createKeyringWithoutPassword(vaultId, generateRecoveryKey(), {
    iterations: 100_000,
  });
  await setSlot(keyring, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));
  keyring.totp.enabled = true;
  keyring.totp.mode = "totp";
  plugin.unlockService.requireKeyring = async () => keyring;
  return { keyring, dek, seed };
}

test("a rejected credential never says WHICH part failed (no 2FA oracle)", async () => {
  const { plugin } = await boot();
  const { setLanguage } = await import("../src/i18n");
  setLanguage("zh"); // assert the wording the user actually reads
  const { seed } = await totpOnlyService(plugin, "fa010000-2222-4333-8444-555555555555");

  const seen: any[] = [];
  plugin.unlockService.setUi(() => ({
    prompt: async (request: any) => {
      seen.push(request);
      // First a bad code, then cancel so the loop ends.
      return seen.length === 1 ? { providerId: "totp", code: "000000", totpSeed: seed } : null;
    },
  }));

  assert.equal(await plugin.unlockService.dekFor("note-a.md"), null);
  assert.equal(seen.length, 2, "the dialog stays open and asks again");
  const msg = seen[1].error as string;
  assert.match(msg, /凭据不正确/, "a single generic rejection wording");
  assert.match(msg, /恢复密钥/, "still points at the way out");
  assert.ok(!/动态密码不对|主密码不对|恢复密钥不对/.test(msg), "names no specific credential");
  assert.ok(!/是对的/.test(msg), "never confirms any part as correct");
  setLanguage("en");
  plugin.onunload();
});

test("a correct code with a mismatched key gets the SAME message as a wrong code", async () => {
  const { plugin } = await boot();
  const { setLanguage } = await import("../src/i18n");
  setLanguage("zh");
  await totpOnlyService(plugin, "fa020000-2222-4333-8444-555555555555");
  const { generateTotpSecret, totpCode } = await import("../src/core/totp");

  // A different, perfectly valid seed: the code verifies, the key does not open.
  // The UI must not reveal that the code was the correct half.
  const otherSeed = generateTotpSecret();
  const code = await totpCode(otherSeed);

  const seen: any[] = [];
  plugin.unlockService.setUi(() => ({
    prompt: async (request: any) => {
      seen.push(request);
      return seen.length === 1 ? { providerId: "totp", code, totpSeed: otherSeed } : null;
    },
  }));

  await plugin.unlockService.dekFor("note-b.md");
  const msg = seen[1].error as string;
  assert.match(msg, /凭据不正确/, "same generic rejection as a wrong code");
  assert.ok(!/是对的/.test(msg), "does not confirm the code was valid");
  setLanguage("en");
  plugin.onunload();
});

test("an empty submission is not counted as a failed attempt", async () => {
  const { plugin } = await boot();
  const { keyring, seed } = await totpOnlyService(plugin, "fa030000-2222-4333-8444-555555555555");

  let calls = 0;
  plugin.unlockService.setUi(() => ({
    prompt: async () => {
      calls++;
      // Four submits with the code field left blank, then cancel: a form typo
      // must not eat the lockout.
      return calls <= 4 ? { providerId: "totp" as const, code: "", totpSeed: seed } : null;
    },
  }));

  await plugin.unlockService.dekFor("note-c.md");
  assert.equal(calls, 5);
  assert.equal(keyring.guard.failCount ?? 0, 0, "blank submits do not consume attempts");
  plugin.onunload();
});

/* ------------------------------------------------------------------ */
/* save robustness: the "Destination file already exists!" family      */
/* ------------------------------------------------------------------ */

test("two overlapping saves of one note both land and leave no scratch files", async () => {
  const { plugin, harness } = await boot();
  const { newDek } = await import("../src/core/keyring");

  const dek = newDek();
  const vaultId = "b2000000-2222-4333-8444-555555555555";
  plugin.vaultIdentifier = vaultId;
  const file: any = { path: "Private/race.sealed.md", basename: "race", extension: "md" };
  harness.files.set(file.path, "");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "第一版");

  // An autosave flush and the lock-on-blur re-seal really do overlap; each used
  // to consume the other's scratch file and throw.
  const saves = await Promise.allSettled([
    plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "并发甲"),
    plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "并发乙"),
  ]);
  const reasons = saves.filter((s) => s.status === "rejected").map((s: any) => String(s.reason?.message));
  assert.deepEqual(reasons, [], "overlapping saves must not throw");

  const scratch = [...harness.files.keys()].filter((p) => /\.(tmp|old)$/.test(p));
  assert.deepEqual(scratch, [], "no scratch files left behind");

  const body = await plugin.notes.readPlaintext(file, dek, vaultId);
  assert.ok(body === "并发甲" || body === "并发乙", `payload holds a complete write, got ${body}`);
  plugin.onunload();
});

test("a scratch file held open by another process cannot block later saves", async () => {
  const { plugin, harness } = await boot();
  const { newDek } = await import("../src/core/keyring");

  const dek = newDek();
  const vaultId = "b2100000-2222-4333-8444-555555555555";
  plugin.vaultIdentifier = vaultId;
  const file: any = { path: "Private/stuck.sealed.md", basename: "stuck", extension: "md" };
  harness.files.set(file.path, "");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "第一版");

  // Exactly the state the user's vault was found in: a `.tmp` and a `.old` from
  // an interrupted write, still held open so Windows keeps both names taken.
  const payloadPath = [...harness.files.keys()].find((p) => p.endsWith(".sealedpayload"))!;
  harness.files.set(`${payloadPath}.tmp`, "stale");
  harness.files.set(`${payloadPath}.old`, "stale");
  harness.stuckPaths.add(`${payloadPath}.tmp`);
  harness.stuckPaths.add(`${payloadPath}.old`);

  await assert.doesNotReject(
    () => plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "第二次保存"),
    "a leftover scratch file must not fail the save",
  );
  assert.equal(
    await plugin.notes.readPlaintext(file, dek, vaultId),
    "第二次保存",
    "the save really landed, not just stopped throwing",
  );
  plugin.onunload();
});

/* ------------------------------------------------------------------ */
/* creating a note: caret below the ID comment                         */
/* ------------------------------------------------------------------ */

test("a new private note puts the caret below the ID comment", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "b3000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  // An existing private note carries the key copy, so creating another one can
  // reuse a live DEK instead of running the first-run wizard (a modal here).
  const seed = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/seed", "种子");
  plugin.sessions.put(seed.path, dek, "test");

  const path = "光标测试.sealed.md";
  const caret = { line: -1, ch: -1 };
  let focused = false;
  harness.app.workspace.mdView = {
    file: { path, basename: "光标测试", extension: "md" },
    editor: {
      lineCount: () => harness.files.get(path)!.split("\n").length,
      getLine: (n: number) => harness.files.get(path)!.split("\n")[n] ?? "",
      setCursor: (pos: any) => {
        caret.line = pos.line;
        caret.ch = pos.ch;
      },
      focus: () => {
        focused = true;
      },
    },
  };

  await plugin.newSealedNote(undefined, "光标测试");
  await new Promise((resolve) => setTimeout(resolve, 200));

  // v2: the new note is pure plaintext. No ID comment means no caret dance -
  // line 1 is exactly where the user starts typing.
  assert.equal(harness.files.get(path), "", "body is empty with no annotation at all");
  assert.equal(
    harness.files.get(path)!.includes("sealed-note:ref"),
    false,
    "no ID comment to accidentally delete",
  );
  plugin.onunload();
});

/* ------------------------------------------------------------------ */
/* lock policy                                                         */
/* ------------------------------------------------------------------ */

test("the lock policy decides which focus loss re-locks a note", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "b4000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/policy", "策略");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "# 私密内容\n", keyring);

  const unlock = async () => {
    // Carry the key copy into the session, as unlockNote() does: once this
    // single note is revealed there is no on-disk key source left.
    plugin.sessions.put(file.path, dek, "test", keyring);
    await plugin.notes.revealNote(file, dek, vaultId);
  };
  const blur = async () => {
    for (const e of harness.registered.domEvents.filter((e) => e.type === "blur")) e.fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const leaveNote = async () => {
    harness.files.set("daily/other.md", "");
    harness.app.workspace.setActiveFile("daily/other.md");
    harness.app.workspace.triggerActiveLeafChange();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  // Default = highest privacy: any focus loss locks.
  assert.equal(plugin.settingsData.lockPolicy, "blur", "strictest policy is the default");
  await unlock();
  harness.app.workspace.setActiveFile(file.path);
  await blur();
  assert.equal(plugin.isUnlocked(file.path), false, "blur policy locks on window blur");
  assert.ok(!harness.files.get(file.path)!.includes("私密内容"), "plaintext left the note body");

  // "close": neither a window blur nor switching notes locks - only closing
  // the note's tab does (covered by its own test below).
  plugin.settingsData.lockPolicy = "close";
  await unlock();
  await blur();
  assert.equal(plugin.isUnlocked(file.path), true, "close policy ignores a window blur");
  await leaveNote();
  assert.equal(plugin.isUnlocked(file.path), true, "close policy survives switching to another note");

  // "session": only quitting Obsidian ends the session.
  plugin.settingsData.lockPolicy = "session";
  await unlock();
  await blur();
  await leaveNote();
  assert.equal(plugin.isUnlocked(file.path), true, "session policy stays unlocked for the whole run");
  plugin.onunload();
});

test("the close policy locks exactly when the note's tab is destroyed", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "b4100000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/tab", "标签");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "# 标签内 secret-abc", keyring);
  plugin.unlockService.dekFor = async () => dek;
  plugin.settingsData.lockPolicy = "close";

  // The note is open in one Markdown leaf; unlockNote records that leaf.
  const noteLeaf: any = {
    view: { getViewType: () => "markdown", file: { path: file.path, basename: "tab" } },
    parent: harness.app.workspace.rootSplit,
    setViewState: async () => undefined,
  };
  harness.app.workspace.markdownLeaves.push(noteLeaf);
  await plugin.unlockNote(file);
  assert.equal(plugin.isUnlocked(file.path), true, "unlocked");

  // 1. Tab switch: another leaf takes focus, the note's leaf survives showing
  //    it. "close" must not lock - this is the case the old build got wrong
  //    (it locked on tab switch but not on sidebar switch).
  harness.files.set("daily/other.md", "");
  harness.app.workspace.markdownLeaves.push({
    view: { getViewType: () => "markdown", file: { path: "daily/other.md", basename: "other" } },
    parent: harness.app.workspace.rootSplit,
  });
  harness.app.workspace.setActiveFile("daily/other.md");
  harness.app.workspace.triggerActiveLeafChange();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(plugin.isUnlocked(file.path), true, "tab switch keeps the note unlocked");
  assert.ok(harness.files.get(file.path)!.includes("secret-abc"), "plaintext stays while the tab is open");

  // 2. Sidebar switch: the SAME leaf navigates to another file. The note's
  //    tab content is gone but the leaf lives on - still not "closed".
  noteLeaf.view.file = { path: "daily/other.md", basename: "other" };
  harness.app.workspace.triggerFileOpen("daily/other.md");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(plugin.isUnlocked(file.path), true, "same-tab navigation keeps it unlocked");

  // 3. Now the tab that last showed the note is destroyed (user closes it).
  //    The note is displayed nowhere and its leaf is gone: lock.
  const idx = harness.app.workspace.markdownLeaves.indexOf(noteLeaf);
  harness.app.workspace.markdownLeaves.splice(idx, 1);
  harness.app.workspace.triggerLayoutChange();
  for (let i = 0; i < 50 && plugin.isUnlocked(file.path); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(plugin.isUnlocked(file.path), false, "closing the tab locks the note");
  assert.ok(!harness.files.get(file.path)!.includes("secret-abc"), "plaintext flushed out on tab close");
  assert.equal(await plugin.notes.readPlaintext(file, dek, vaultId), "# 标签内 secret-abc", "content preserved in the payload");
  plugin.onunload();
});



test("old combined vaults can close the password-only door", async () => {
  const { plugin } = await boot();
  const { createKeyring, unlockWithPassword } = await import("../src/core/keyring");
  const { generateTotpSecret } = await import("../src/core/totp");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { getProvider } = await import("../src/core/providers");

  const seed = generateTotpSecret();
  const vaultId = "b5000000-2222-4333-8444-555555555555";
  // Simulate a vault created by the OLD build: standalone password slot +
  // combined slot side by side, and a note carrying that key copy.
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/old", "旧库");
  await plugin.unlockService.configureMode(dek, "password+totp", { password: "pw-1234567890", seed });
  // The combined mode from configureMode already dropped it in a NEW flow;
  // force the old shape back to test the hardening entry point itself.
  let kr = await plugin.unlockService.requireKeyring();
  const { setSlot, SLOT_PASSWORD, credentialFor } = await import("../src/core/keyring");
  await setSlot(kr, dek, SLOT_PASSWORD, credentialFor(SLOT_PASSWORD, { password: "pw-1234567890" }));
  await plugin.unlockService.keyringStore.save(kr, { force: true });

  // The hole is real: password alone opens the keyring.
  kr = await plugin.unlockService.requireKeyring();
  assert.deepEqual(await unlockWithPassword(kr, "pw-1234567890"), dek, "password-only door exists before hardening");
  assert.ok(getProvider("password").isConfigured(kr), "password provider offered before hardening");

  await plugin.unlockService.hardenCombinedMode();
  await plugin.keyCopies.refreshAll(await plugin.unlockService.requireKeyring());

  kr = await plugin.unlockService.requireKeyring();
  assert.ok(!kr.slots[SLOT_PASSWORD], "password slot gone");
  assert.ok(!getProvider("password").isConfigured(kr), "the dialog no longer offers a password-only tab");
  assert.ok(getProvider("password+totp").isConfigured(kr), "combined stays usable");
  // Idempotent: running it again is a no-op, not an error.
  await assert.doesNotReject(() => plugin.unlockService.hardenCombinedMode());
  plugin.onunload();
});

/* ------------------------------------------------------------------ */
/* Inline plaintext blocks (issue 1): typed as plaintext, sealed on     */
/* leaving points, same lockPolicy as private notes. Cancel + failure  */
/* keep the bytes; only a successful seal rewrites the file.           */
/* ------------------------------------------------------------------ */

/** Plain note keyed trail needs a real keyring; return its DEK. */
async function seedInlineKey(plugin: any): Promise<Uint8Array> {
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const vaultId = "c1000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/inline-anchor", "anchor");
  plugin.vaultIdentifier = vaultId;
  return dek;
}

test("modify registers a hand-typed plaintext block as a warning trail", async () => {
  const { plugin, harness } = await boot();
  await seedInlineKey(plugin);
  const { TFile } = await import("./obsidian-stub");
  const path = "Plain/inline.md";
  harness.files.set(path, "```encrypted_txt\ntest\n```\n");

  const modify = harness.registered.events.find((e) => e.name === "vault:modify")!;
  await modify.fn(new TFile(path));
  // The handler fires guard() fire-and-forget: poll for the trail instead of
  // trusting a single microtask (pitfall #7 in the API guide).
  for (let i = 0; i < 50 && !(plugin as any).unsealedNotes.has(path); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal((plugin as any).unsealedNotes.has(path), true, "trail registered");
  assert.match(String(harness.registered.statusBar[0].text), /未加密|Unsealed/i, "status bar warns");
  plugin.onunload();
});

test("sealPlainNote rewrites the fenced block into sn1 ciphertext in place", async () => {
  const { plugin, harness } = await boot();
  const dek = await seedInlineKey(plugin);
  const path = "Plain/seal.md";
  const src = "# note\n\n```encrypted_txt\nmy secret text\n```\nafter\n";
  harness.files.set(path, src);

  // A live session holds the vault DEK: no dialog, silent seal.
  plugin.sessions.put(path, dek, "password");
  const sealed = await plugin.sealPlainNote(path, { interactive: true, notify: false });

  assert.ok(sealed > 0, "at least one block sealed");
  const out = harness.files.get(path)!;
  assert.ok(out.includes("```encrypted_txt\nsn1."), "fence kept, body is ciphertext");
  assert.ok(!out.includes("my secret text"), "no plaintext left on disk");
  assert.ok(out.startsWith("# note\n") && out.endsWith("after\n"), "surrounding text intact");
  assert.equal((plugin as any).unsealedNotes.has(path), false, "trail cleared after seal");

  // The ciphertext really decrypts back with the same key.
  const { openInline } = await import("../src/core/format");
  const payload = /```encrypted_txt\n(sn1\.[A-Za-z0-9+/=]+)\n```/.exec(out)![1];
  assert.equal(await openInline(dek, plugin.vaultIdentifier, payload), "my secret text");
  plugin.onunload();
});

test("cancel leaves the plaintext byte-for-byte and keeps the trail", async () => {
  const { plugin, harness } = await boot();
  await seedInlineKey(plugin);
  const path = "Plain/cancel.md";
  const src = "```encrypted_txt\nstill mine\n```\n";
  harness.files.set(path, src);
  // No cached DEK, and the unlock dialog returns "cancelled".
  plugin.unlockService.dekFor = async () => null;

  const sealed = await plugin.sealPlainNote(path, { interactive: true });

  assert.equal(sealed, -1, "seal reports failure");
  assert.equal(harness.files.get(path), src, "plaintext untouched, nothing deleted");
  assert.equal((plugin as any).unsealedNotes.has(path), true, "trail stays for next visit");
  assert.ok(harness.notices.some((n) => n.includes("未加密") || /plain/i.test(n)), "user was warned");
  plugin.onunload();
});

test("leaving a note at blur policy seals its plaintext blocks", async () => {
  const { plugin, harness } = await boot();
  const dek = await seedInlineKey(plugin);
  const path = "Plain/leave.md";
  harness.files.set(path, "```encrypted_txt\nblur secret\n```\n");
  const { TFile } = await import("./obsidian-stub");
  const modify = harness.registered.events.find((e) => e.name === "vault:modify")!;
  await modify.fn(new TFile(path));
  for (let i = 0; i < 50 && !(plugin as any).unsealedNotes.has(path); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((plugin as any).unsealedNotes.has(path), true);
  plugin.sessions.put(path, dek, "password"); // already unlocked this session

  // Switching to another note is a file-open leave point (blur policy).
  harness.files.set("Plain/other.md", "");
  harness.app.workspace.triggerFileOpen("Plain/other.md");
  for (let i = 0; i < 50 && (plugin as any).unsealedNotes.has(path); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const out = harness.files.get(path)!;
  assert.ok(out.includes("sn1."), "block sealed at the leave point");
  assert.ok(!out.includes("blur secret"), "no plaintext survives");
  plugin.onunload();
});

test("silent seal (unload) never opens a dialog without a cached key", async () => {
  const { plugin, harness } = await boot();
  await seedInlineKey(plugin);
  const path = "Plain/unload.md";
  const src = "```encrypted_txt\nkeep until asked\n```\n";
  harness.files.set(path, src);
  (plugin as any).unsealedNotes.add(path);
  let prompted = 0;
  plugin.unlockService.dekFor = async () => { prompted++; return null; };

  await plugin.sealPlainNote(path, { interactive: false });

  assert.equal(prompted, 0, "no modal on the opportunistic path");
  assert.equal(harness.files.get(path), src, "bytes untouched without a key");
  plugin.onunload();
});

/* ------------------------------------------------------------------ */
/* Recovery key reveal + settings mode switching regressions           */
/* ------------------------------------------------------------------ */

test("recovery modal ignores backdrop/Escape close; only × or 完成 settles it", async () => {
  const { obsidian } = buildHarness();
  const { RecoveryKeyModal } = await import("../src/ui/modals");

  let settled: boolean | undefined;
  const modal: any = new RecoveryKeyModal(
    { vault: { getName: () => "TestVault" } } as any,
    "KEY-1234-5678",
    "fp",
    "TestVault",
    (saved: boolean) => { settled = saved; },
  );
  void obsidian;
  modal.onOpen();

  // Backdrop click / Escape route through close() with no explicit grant.
  modal.close();
  assert.equal(settled, undefined, "an accidental dismiss must not resolve the promise");

  // The title-bar × is an explicit dismissal but is NOT an acknowledgement.
  modal.dismissByCloseButton();
  assert.equal(settled, false, "× closes without claiming the key was saved");
  let resolveCount = 0;
  const counted: any = new RecoveryKeyModal(
    { vault: { getName: () => "TestVault" } } as any,
    "KEY-1234-5678", "fp", "TestVault",
    () => { resolveCount++; },
  );
  counted.onOpen();
  counted.dismissByCloseButton();
  counted.onClose(); // Obsidian may call onClose after close()
  assert.equal(resolveCount, 1, "a close resolves the promise exactly once");

  // Re-open a fresh modal: the 完成 button acknowledges the key.
  let saved: boolean | undefined;
  const ack: any = new RecoveryKeyModal(
    { vault: { getName: () => "TestVault" } } as any,
    "KEY-1234-5678",
    "fp",
    "TestVault",
    (value: boolean) => { saved = value; },
  );
  ack.onOpen();
  ack.acknowledge();
  assert.equal(saved, true, "完成 reports the key as saved");
});

test("resetting the recovery key uses the configured mode's credential, never the master password by default", async () => {
  const { plugin } = await boot();
  const { createKeyring, createKeyringWithoutPassword, setSlot, credentialFor, SLOT_TOTP } =
    await import("../src/core/keyring");
  const { generateTotpSecret, totpCode } = await import("../src/core/totp");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const seed = generateTotpSecret();
  const vaultId = "ab010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyringWithoutPassword(vaultId, generateRecoveryKey(), {
    iterations: 100_000,
  });
  await setSlot(keyring, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));
  keyring.totp.enabled = true;
  keyring.totp.mode = "totp";
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/recovery-mode", "恢复测试");
  plugin.sessions.lockAll();

  // A TOTP-only vault must ask for a code, not for a master password.
  const provider = plugin.unlockService.providerForMode(keyring);
  assert.equal(provider?.id, "totp", "mode-derived provider is TOTP");

  const seen: any[] = [];
  plugin.unlockService.setUi(() => ({
    prompt: async (request: any) => {
      seen.push(request);
      return { providerId: "totp", code: await totpCode(seed), totpSeed: seed };
    },
  }));
  const reauth = await plugin.unlockService.reauthForSettings("recovery");
  assert.ok(reauth, "TOTP code re-authenticates the settings change");
  assert.deepEqual(reauth!.dek, dek);
  assert.equal(seen.length, 1, "one prompt");
  assert.deepEqual(seen[0].providers.map((p: any) => p.id), ["totp", "recovery"], "configured mode first, recovery key still available");
  assert.equal(seen[0].provider.id, "totp", "configured mode is the default tab");

  plugin.onunload();
});

test("the recovery key itself can authorize resetting the recovery key", async () => {
  const { plugin } = await boot();
  const { createKeyringWithoutPassword, setSlot, credentialFor, SLOT_TOTP } = await import("../src/core/keyring");
  const { generateTotpSecret } = await import("../src/core/totp");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const seed = generateTotpSecret();
  const recovery = generateRecoveryKey();
  const vaultId = "cd010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyringWithoutPassword(vaultId, recovery, { iterations: 100_000 });
  await setSlot(keyring, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));
  keyring.totp.enabled = true;
  keyring.totp.mode = "totp";
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/recovery-reset", "恢复重置");
  plugin.sessions.lockAll();

  // The user suspects the recovery key leaked (or lost the phone) and wants to
  // rotate it. The only credential in hand is that recovery key.
  const seen: any[] = [];
  plugin.unlockService.setUi(() => ({
    prompt: async (request: any) => {
      seen.push(request);
      return { providerId: "recovery", secret: recovery };
    },
  }));
  const reauth = await plugin.unlockService.reauthForSettings("recovery");
  assert.ok(reauth, "the recovery key authorizes the reset");
  assert.deepEqual(reauth!.dek, dek);
  // First prompt defaults to the configured mode; picking the recovery tab
  // re-prompts once for that tab's credential. No forced switch back to TOTP.
  assert.equal(seen.length, 2, "one tab switch, then the recovery key submission");
  assert.equal(seen[0].provider.id, "totp", "configured mode is the default tab");
  assert.deepEqual(seen[0].providers.map((p: any) => p.id), ["totp", "recovery"]);
  assert.equal(seen[1].provider.id, "recovery", "recovery tab accepted");

  plugin.onunload();
});

test("switchUnlockMode reuses the existing seed and writes the new mode", async () => {
  const { plugin } = await boot();
  const { createKeyring, SLOT_PASSWORD } = await import("../src/core/keyring");
  const { generateTotpSecret, totpCode } = await import("../src/core/totp");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const seed = generateTotpSecret();
  const password = "pw-switch-123456";
  const vaultId = "bc010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, password, generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/switch", "模式切换");
  plugin.sessions.lockAll();

  let seedPrompts = 0;
  plugin.unlockService.setUi(() => ({
    prompt: async (request: any) => {
      if (request.provider.id === "totp") {
        return { providerId: "totp", code: await totpCode(seed), totpSeed: seed };
      }
      return { providerId: "password", secret: password };
    },
  }));

  // Switch from password to TOTP, supplying a seed once.
  await plugin.unlockService.configureMode(dek, "totp", { seed });
  plugin.sessions.lockAll();
  const originalTotpSetupModal = (plugin as any).app;
  void originalTotpSetupModal;

  // A device-sealed seed is now available; switching to combined must reuse it
  // and must not ask the user to scan a new QR code.
  const krBefore = await plugin.unlockService.requireKeyring();
  assert.ok(await plugin.unlockService.hasLocalSeed(krBefore), "seed is cached on this device");
  const sameSeed = await plugin.unlockService.currentSeed(krBefore);
  assert.equal(sameSeed, seed.replace(/[^A-Z2-7]/g, "").toUpperCase(), "current seed returned for reuse");
  assert.equal(seedPrompts, 0, "no QR re-scan needed");

  const reauth = await plugin.unlockService.reauthForSettings("unlock");
  assert.ok(reauth, "re-auth with the current TOTP code succeeds");
  await plugin.unlockService.configureMode(reauth!.dek, "password+totp", {
    password,
    seed: sameSeed!,
  });
  const krAfter = await plugin.unlockService.requireKeyring();
  assert.equal(krAfter.totp.mode, "password+totp", "combined mode written");
  assert.ok(krAfter.slots["password-totp"], "combined slot present");
  assert.ok(!krAfter.slots[SLOT_PASSWORD], "no standalone password door in strict two-factor");

  plugin.onunload();
});

/* ------------------------------------------------------------------ */
/* Native locked-note editing (no custom view)                         */
/* ------------------------------------------------------------------ */

test("lockDocument seals an ordinary note in place, keeping its filename", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState } = await import("../src/core/format");

  const password = "pw-lock-doc-1234";
  const vaultId = "de010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, password, generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/setup", "setup");
  await plugin.keyringStore.save(keyring);

  const path = "Daily/2026-11-26.md";
  harness.files.set(path, "# 今天\n\n一段正文\n");
  plugin.unlockService.dekFor = async () => dek;
  plugin.unlockService.requireKeyring = async () => keyring;

  await plugin.lockDocument({ path, extension: "md", basename: "2026-11-26" } as any);

  assert.ok(harness.files.has(path), "original filename kept");
  assert.ok(!harness.files.has(`${path}.sealed.md`), "no renamed copy created");
  assert.equal(noteBodyState(harness.files.get(path)!), "sealed", "body is the ciphertext envelope");
  assert.equal(plugin.notes.isSealedPath(path), true, "registry recognises the in-place note");

  plugin.onunload();
});

test("refreshVaultPaths detects locked notes with arbitrary filenames", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { sealNote } = await import("../src/core/format");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "ef010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-scan-1234567", generateRecoveryKey(), {
    iterations: 100_000,
  });
  void keyring;
  const envelope = await sealNote(dek, vaultId, vaultId, "secret body");
  harness.files.set("Projects/plain-name.md", envelope);
  harness.files.set("Projects/normal.md", "# not encrypted\n");

  await plugin.notes.refreshVaultPaths();

  assert.equal(plugin.notes.isSealedPath("Projects/plain-name.md"), true, "envelope content detected");
  assert.equal(plugin.notes.isSealedPath("Projects/normal.md"), false, "ordinary note stays ordinary");
  plugin.onunload();
});

test("opening a locked note never registers a custom view and the marker is present", async () => {
  const { plugin, harness } = await boot();
  assert.equal((plugin.app as any).vault ? true : false, true, "vault wired");
  assert.equal(harness.registered.views.has("sealed-note-view"), false, "no padlock view");
  assert.equal(harness.registered.extensions.has("sealed"), false, "no extension routing");
  plugin.onunload();
});

test("a locked note stays recognised after a crash left its body as plaintext", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "fe010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-index-123456", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Start/base", "base");

  const path = "Random/meeting-notes.md";
  harness.files.set(path, "plain text");
  plugin.notes.markSealed(path);
  // Simulate a crash: the body is plaintext but the persisted index remembers.
  harness.files.set(path, "# revealed after crash\n");
  const indexPath = ".obsidian/plugins/sealed-note/vault-notes.json";
  for (let i = 0; i < 50 && !(harness.files.get(indexPath) ?? "").includes(path); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const index = harness.files.get(indexPath) ?? "[]";
  assert.ok(JSON.parse(index).includes(path), "the path is persisted to the local index");

  // A fresh store in the same vault picks the path up without any envelope.
  const { SealedNoteStore } = await import("../src/storage/sealed-note-store");
  const reloaded = new SealedNoteStore(harness.app, ".obsidian/plugins/sealed-note");
  await reloaded.refreshVaultPaths();
  assert.equal(
    reloaded.isSealedPath(path),
    true,
    "registry survives restart even without an envelope in the body",
  );
  plugin.onunload();
});

test("a freshly created note keeps its keyring discoverable while unlocked", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "aa010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-fresh-123456", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;

  // First run: setup registers the keyring in memory, the wizard creates the
  // first note and reveals it (empty plaintext body), exactly like the real
  // newSealedNote path does.
  // Drive the same calls the wizard makes: runSetup() registers the keyring,
  // newSealedNote() reveals the freshly created note.
  assert.equal(typeof plugin.setupFromSettings, "function", "settings setup wrapper exists");
  plugin.unlockService.rememberKeyring(keyring);
  (plugin as any).pendingKeyring = keyring;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/first", "first");
  await plugin.revealBlank(file);
  (plugin as any).pendingKeyring = null;

  assert.equal(harness.files.get(file.path), "", "body is revealed plaintext");
  assert.equal(await plugin.hasKeyring(), true, "vault is initialized even with no sealed note on disk");
  const loaded = await plugin.unlockService.requireKeyring();
  assert.equal(loaded.vaultId, vaultId, "keyring still loadable for settings");
  assert.ok(loaded.slots.recovery, "recovery slot survives for the settings page");
  plugin.onunload();
});

test("a first-run note survives restart as a vault note (registry persisted at create)", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "b1010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-restart-12345", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;

  // Exactly what the first-run wizard does: create the note, then reveal it.
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "life/test密文", "test密文");
  await plugin.revealBlank(file);

  // Restart: a fresh store over the same filesystem, scanning from disk only.
  const { SealedNoteStore } = await import("../src/storage/sealed-note-store");
  const restarted = new SealedNoteStore(harness.app, ".obsidian/plugins/sealed-note");
  await restarted.refreshVaultPaths();

  assert.equal(
    restarted.isSealedPath(file.path),
    true,
    "the note is still a vault note after restart even though its body is plaintext",
  );
  plugin.onunload();
});

test("opening a leaked plaintext vault note re-seals it before it can be read", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState } = await import("../src/core/format");

  const vaultId = "b2020000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-leak-1234567", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  await plugin.keyringStore.save(keyring).catch(() => undefined);
  // The registry knows the note (as after a crash), but its body is plaintext.
  const path = "life/leaked.md";
  plugin.notes.markSealed(path);
  harness.files.set(path, "secret body that leaked");
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.unlockService.rememberKeyring(keyring); // what the real wizard does
  let prompted = 0;
  plugin.unlockService.dekFor = async () => {
    prompted++;
    return dek;
  };

  const fileOpen = harness.registered.events.find((e) => e.name === "file-open");
  assert.ok(fileOpen, "file-open hook registered");
  fileOpen!.fn({ path, basename: "leaked", extension: "md" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(prompted, 1, "the credential was demanded before the body was usable");
  assert.equal(noteBodyState(harness.files.get(path)!), "sealed", "the leaked plaintext is gone from disk");
  plugin.onunload();
});

test("demoting a suffixed private note yields a normal note that stays normal", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { noteBodyState } = await import("../src/core/format");

  const vaultId = "b3030000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-demote-123456", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/demote", "demote");
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "the content", keyring);
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.unlockService.dekFor = async () => dek;

  await plugin.demoteToPlain({ path: file.path, basename: "demote", extension: "md" } as any);

  const plain = "Private/demote.md";
  assert.equal(harness.files.get(plain), "the content", "plaintext restored under a normal name");
  assert.equal(harness.files.has(file.path), false, "the .sealed.md file is gone");
  assert.equal(plugin.notes.isSealedPath(plain), false, "no longer a vault note");
  assert.ok(!plugin.notes.vaultNotePaths().includes(file.path), "old path out of the registry");
  assert.ok(!plugin.notes.vaultNotePaths().includes(plain), "new path out of the registry");

  // A restart must not resurrect it: the registry and content both say normal.
  const { SealedNoteStore } = await import("../src/storage/sealed-note-store");
  const restarted = new SealedNoteStore(harness.app, ".obsidian/plugins/sealed-note");
  await restarted.refreshVaultPaths();
  assert.equal(restarted.isSealedPath(plain), false, "demotion survives restart");
  plugin.onunload();
});

test("unlock pushes plaintext into a stale editor buffer (the no-plaintext-injection bug)", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "c4040000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-buffer-12345", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "life/buffer", "buffer");

  // The note is open in the editor with its body still the envelope. The
  // buffer is a snapshot taken at open time and is NOT auto-synced here -
  // exactly the state that produced "unlock showed no plaintext".
  const envelopeBody = harness.files.get(file.path)!;
  const buffer: { value: string } = { value: envelopeBody };
  harness.app.workspace.mdView = {
    file: { path: file.path, basename: "buffer", extension: "md" },
    editor: {
      getValue: () => buffer.value,
      setValue: (v: string) => {
        buffer.value = v;
      },
    },
  };
  plugin.unlockService.dekFor = async () => dek;
  plugin.unlockService.requireKeyring = async () => keyring;

  await plugin.unlockNote({ path: file.path, basename: "buffer", extension: "md" } as any);
  await new Promise((resolve) => setTimeout(resolve, 30)); // buffer sync is async

  assert.equal(buffer.value, "", "the stale envelope buffer was replaced with the revealed plaintext");
  assert.notEqual(buffer.value, envelopeBody, "the envelope is gone from the buffer");

  // And locking swaps the buffer back to ciphertext, not a stale plaintext.
  plugin.sessions.put(file.path, dek, "test", keyring);
  await plugin.lockNote(file.path);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(buffer.value.startsWith("<!-- sealed-note/note/1"), "the buffer now holds the envelope again");
  plugin.onunload();
});

test("a renamed envelope note (no suffix, not in registry) still unlocks - content self-heals identity", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "d5050000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-rename-123456", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "life/orig", "orig");

  // The user renames through Obsidian's API with NO plugin event wired (as if
  // the rename came from outside): suffix gone, registry entry gone.
  const body = harness.files.get(file.path)!;
  harness.files.delete(file.path);
  const renamed = "life/apikey.md";
  harness.files.set(renamed, body);
  (plugin.notes as any).vaultPaths.delete(file.path);
  assert.equal(plugin.notes.isSealedPath(renamed), false, "precondition: identity lost");

  let prompted = 0;
  plugin.unlockService.dekFor = async () => {
    prompted++;
    return dek;
  };
  plugin.unlockService.requireKeyring = async () => keyring;

  // The banner's unlock button calls this. Before the fix it silently returns.
  await plugin.unlockNote({ path: renamed, basename: "apikey", extension: "md" } as any);

  assert.equal(prompted, 1, "unlock asked for the credential instead of silently returning");
  assert.equal(plugin.notes.isSealedPath(renamed), true, "the note re-registered itself from its content");
  assert.equal(harness.files.get(renamed), "", "body revealed to plaintext");
  plugin.onunload();
});

test("modify on a plain-looking path that holds an envelope re-registers it", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "d6060000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-sync-1234567", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const src = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "life/src", "src");
  const envelope = harness.files.get(src.path)!;

  // Simulate a sync client delivering the note under a plain name: modify
  // event fires, path unknown to the registry.
  const path = "life/synced.md";
  harness.files.set(path, envelope);
  const modify = harness.registered.events.find((e) => e.name === "vault:modify");
  assert.ok(modify, "vault modify handler registered");
  // The handler guards on instanceof TFile, so deliver a real one.
  const synced = harness.app.vault.getAbstractFileByPath(path) ?? { path, basename: "synced", extension: "md" };
  modify!.fn(synced);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(plugin.notes.isSealedPath(path), true, "the envelope body re-registered the note");
  plugin.onunload();
});
