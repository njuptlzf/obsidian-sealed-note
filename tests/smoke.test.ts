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
    "show-recovery-key",
    "setup-totp",
  ];
  for (const id of expected) assert.ok(ids.includes(id), `missing command: ${id}`);
  assert.equal(new Set(ids).size, ids.length, "command ids must be unique");

  assert.ok(r.views.has("sealed-note-view"), "sealed view registered");
  assert.equal(r.extensions.get("sealed"), "sealed-note-view", "the 'sealed' token routes .sealed.md to the padlock view");
  assert.ok(r.events.some((e) => e.name === "file-open"), "file-open hook present for stale-tab cleanup");

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

  const noteText = harness.files.get(file.path)!;
  assert.ok(noteText.includes("sealed-note:ref="), "note keeps only an opaque ID");
  assert.ok(!noteText.includes("sealed-note/note/1"), "no envelope in the note source");
  assert.ok(!noteText.includes("hunter2"), "no plaintext in the note");
  const payloadPath = [...harness.files.keys()].find((p) => p.endsWith(".sealedpayload"))!;
  const payload = harness.files.get(payloadPath)!;
  assert.ok(payload.includes("sealed-note/note/1"), "envelope lives in the payload");
  assert.ok(!payload.includes("hunter2"), "no plaintext on disk");
  assert.ok(!payload.includes("秘密"), "no plaintext on disk (unicode)");
  assert.ok(!harness.files.has(file.path + ".tmp"), "temp file cleaned up");

  assert.equal(await notes.readPlaintext(file, dek, vaultId), body, "round trip");

  // and a different key must not open it
  await assert.rejects(() => notes.readPlaintext(file, newDek(), vaultId));

  plugin.onunload();
});

test("sidecar format: note holds only a placeholder and an ID, renames cannot break it", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { parseNoteRef } = await import("../src/core/format");

  const vaultId = "10000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;

  const file = await plugin.notes.create(
    { vaultId, kid: vaultId, keyring },
    dek,
    "Private/new",
    "新笔记",
    "PLACEHOLDER",
  );
  const noteText = harness.files.get(file.path)!;
  // Both lines are HTML comments: rendered view is a clean blank page.
  assert.ok(noteText.trimStart().startsWith("<!--"), "placeholder is a comment, invisible when rendered");
  assert.ok(noteText.includes("PLACEHOLDER"), "hint lives inside a comment");
  assert.ok(!noteText.includes("keys"), "no key copy in note source");
  assert.ok(!noteText.includes("sealed-note/note/1"), "no envelope in note source");
  const ref = parseNoteRef(noteText);
  assert.ok(ref, "a stable ID is present");
  assert.ok(harness.files.has(`sealed-data/${ref}.sealedpayload`), "payload created in the configured folder");

  // Renaming the note is just a path change: the ID in its body is untouched.
  const movedPath = "Renamed/moved.sealed.md";
  harness.files.set(movedPath, noteText);
  harness.files.delete(file.path);
  const moved: any = { path: movedPath, basename: "moved", extension: "md" };
  assert.equal(
    await plugin.notes.readPlaintext(moved, dek, vaultId),
    "",
    "payload still found after the note moved",
  );
  plugin.onunload();
});

test("migration moves a legacy envelope into a payload without changing content", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring, keyCopyFromKeyringData } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { sealNote } = await import("../src/core/format");

  const vaultId = "20000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file: any = { path: "Private/old.sealed.md", basename: "old", extension: "md" };
  harness.files.set(
    file.path,
    await sealNote(dek, vaultId, vaultId, "旧内容", keyCopyFromKeyringData(keyring)),
  );
  assert.equal(await plugin.notes.readPlaintext(file, dek, vaultId), "旧内容");

  await plugin.migrateToPayloads();

  const noteText = harness.files.get(file.path)!;
  assert.ok(noteText.includes("sealed-note:ref="), "note became a placeholder");
  assert.ok(!noteText.includes("sealed-note/note/1"), "envelope removed from note");
  assert.equal(await plugin.notes.readPlaintext(file, dek, vaultId), "旧内容", "content intact");
  assert.ok(
    [...harness.files.keys()].some((p) => p.endsWith(".sealedpayload")),
    "payload created",
  );
  plugin.onunload();
});

test("deleting a note removes its payload when the setting is on", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { parseNoteRef } = await import("../src/core/format");

  const vaultId = "30000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.settingsData.deletePayloadWithNote = true; // explicit: default is now off
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/del", "删除");
  const ref = parseNoteRef(harness.files.get(file.path)!)!;
  const payloadPath = `sealed-data/${ref}.sealedpayload`;
  assert.ok(harness.files.has(payloadPath), "payload exists before delete");

  const hook = harness.registered.events.find((e) => e.name === "vault:delete");
  assert.ok(hook, "delete hook registered");
  harness.files.delete(file.path);
  await hook!.fn({ path: file.path });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.files.has(payloadPath), false, "payload deleted with the note");
  plugin.onunload();
});

test("orphan payload detection ignores payloads referenced by notes", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { parseNoteRef } = await import("../src/core/format");

  const vaultId = "40000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/keep", "保留");
  const ref = parseNoteRef(harness.files.get(file.path)!)!;
  harness.files.set("sealed-data/orphan-1234.sealedpayload", "{}\n");

  const orphans = await plugin.notes.orphanPayloads();
  assert.deepEqual(
    orphans.map((f: any) => f.path),
    ["sealed-data/orphan-1234.sealedpayload"],
    "only the unreferenced payload is reported",
  );
  assert.ok(!orphans.some((f: any) => f.path.includes(ref)), "live payload is kept");
  plugin.onunload();
});

test("unlocking reveals plaintext in the note body and switches to the Markdown view", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { parseNoteRef } = await import("../src/core/format");

  const vaultId = "50000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/native", "原生");
  // Seed a payload with real content so reveal has something to show.
  await plugin.notes.writePlaintext(file, dek, vaultId, vaultId, "# 秘密\n", keyring);
  plugin.unlockService.dekFor = async () => dek;
  harness.registered.viewSwitches.length = 0;

  await plugin.unlockNote(file);

  const ref = parseNoteRef(harness.files.get(file.path)!)!;
  assert.ok(ref, "ref line survives reveal");
  assert.ok(harness.files.get(file.path)!.includes("# 秘密"), "plaintext revealed IN the note body");
  assert.ok(
    harness.registered.viewSwitches.some((s: any) => s.type === "markdown" && s.state?.file === file.path),
    "note switched to the native Markdown editor",
  );
  assert.equal(plugin.isUnlocked(file.path), true, "note tracked as unlocked");

  plugin.onunload();
});

test("editing the revealed body encrypts back to payload and locking restores the placeholder", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "60000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/edit", "编辑");
  plugin.sessions.put(file.path, dek, "test");
  await plugin.unlockNote(file);

  // Simulate the user editing: write plaintext into the note body, then flush.
  const refLine = harness.files.get(file.path)!.split("\n")[0];
  harness.files.set(file.path, `${refLine}\n# 改过的标题\n\n正文 secret-xyz\n`);
  await plugin.flushNote(file.path);
  assert.equal(
    await plugin.notes.readPlaintext(file, dek, vaultId),
    "# 改过的标题\n\n正文 secret-xyz\n",
    "edited plaintext encrypted back into the payload",
  );

  await plugin.lockNote(file.path);
  const lockedBody = harness.files.get(file.path)!;
  assert.ok(!lockedBody.includes("secret-xyz"), "plaintext gone from the note body after lock");
  assert.ok(lockedBody.trimStart().startsWith("<!--"), "placeholder comments restored");
  assert.equal(plugin.isUnlocked(file.path), false, "session dropped on lock");

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
  assert.equal(await plugin.notes.readPlaintext(
    { path: created!, basename: "x", extension: "md" } as any,
    dek,
    vaultId,
  ), "", "note opens clean");
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

test("recovery key can enumerate payloads and restore a deleted annotation", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { parseNoteRef } = await import("../src/core/format");
  const { RestoreService } = await import("../src/services/restore-service");

  const vaultId = "b2000000-2222-4333-8444-555555555555";
  const recovery = generateRecoveryKey();
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", recovery, {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;

  const original = await plugin.notes.create(
    { vaultId, kid: vaultId, keyring },
    dek,
    "Private/restore-me",
    "恢复测试",
    "PLACEHOLDER",
  );
  // Give the note real content so the candidate has a title/preview.
  await plugin.notes.writePlaintext(original, dek, vaultId, vaultId, "# 我的秘密日记\n\n今天写点东西", keyring);
  const oldRef = parseNoteRef(harness.files.get(original.path)!)!;

  const service = new RestoreService(plugin.app, plugin.notes);
  const { candidates, skipped } = await service.collectCandidates(recovery);
  assert.ok(candidates.length >= 1, "recovery key opens at least one payload");
  assert.equal(skipped, 0, "no payload skipped with the correct key");
  const mine = candidates.find((c) => c.ref === oldRef);
  assert.ok(mine, "the note's payload is among the candidates");
  assert.equal(mine!.title, "我的秘密日记", "candidate title comes from decrypted text");

  // Wrong key opens nothing.
  const wrong = await service.collectCandidates(generateRecoveryKey());
  assert.equal(wrong.candidates.length, 0, "wrong recovery key opens nothing");

  // Simulate deleting the annotation, then restore from the chosen candidate.
  harness.files.set(original.path, "# 恢复测试\n\n注解被误删了\n");
  const result = await service.restore(original, mine!);
  assert.notEqual(result.newRef, oldRef, "a fresh ref is generated");
  const newBody = harness.files.get(original.path)!;
  assert.equal(parseNoteRef(newBody), result.newRef, "new annotation points at the new ref");
  assert.ok(harness.files.has(`sealed-data/${result.newRef}.sealedpayload`), "new payload written");
  assert.ok(harness.files.has(`sealed-data/${oldRef}.sealedpayload`), "old payload kept");
  assert.equal(
    await plugin.notes.readPlaintext(original, dek, vaultId),
    "# 我的秘密日记\n\n今天写点东西",
    "restored note decrypts back to the original text",
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
  assert.ok(noteText.includes("sealed-note:ref="), "note has only a ref");
  assert.ok(!noteText.includes("\"keys\""), "no keys in the note source");
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
  await assert.rejects(() => plugin.unlockService.configureMode(dek, "password"), /需要先设置一个主密码/);
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

test("by default deleting a note keeps its ciphertext; clean-orphans removes it", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { parseNoteRef } = await import("../src/core/format");

  assert.equal(plugin.settingsData.deletePayloadWithNote, false, "payload retention is the default");
  const vaultId = "e3000000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/keep", "保留");
  const ref = parseNoteRef(harness.files.get(file.path)!)!;
  const payloadPath = `sealed-data/${ref}.sealedpayload`;

  const hook = harness.registered.events.find((e) => e.name === "vault:delete");
  assert.ok(hook, "delete hook registered");
  harness.files.delete(file.path);
  await hook!.fn({ path: file.path });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(harness.files.has(payloadPath), "payload kept when the note is deleted by default");

  const orphans = await plugin.notes.orphanPayloads();
  assert.ok(orphans.some((f: any) => f.path === payloadPath), "kept payload is detected as orphan");

  // A manual clean command and settings button both exist for clearing orphans.
  const cmd = harness.registered.commands.find((c: any) => c.id === "clean-orphan-payloads");
  assert.ok(cmd, "clean orphan command registered");
  const settingsWithClean = (plugin as any).appSettingTab; // may be null in stub
  void settingsWithClean;
  // Removing one orphan directly (what the clean command does after confirm).
  await plugin.notes.deletePayload(ref);
  assert.equal(harness.files.has(payloadPath), false, "orphan payload can be removed");
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

  // 2. A note left revealed on disk (crash while unlocked).
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/crash", "崩溃");
  const ref = harness.files.get(file.path)!.split("\n")[0];
  harness.files.set(file.path, `${ref}\n# 未保存的明文 secret-xyz`);

  await (plugin as any).recoverAfterCrash();
  assert.equal(harness.files.has("sealed-note-work/stale-a.md"), false, "stale copy a deleted");
  assert.equal(harness.files.has("sealed-note-work/stale-b.md"), false, "stale copy b deleted");
  // Boot must not touch the body: its ciphertext is intact, so opening asks for
  // the credential and the typed text stays exactly where the user left it.
  assert.ok(harness.files.get(file.path)!.includes("secret-xyz"), "boot leaves the body alone");
  assert.ok(
    harness.notices.some((n) => n.includes("明文状态")),
    "the user is told about the leftover plaintext",
  );

  // Locking re-seals with the real DEK.
  plugin.sessions.put(file.path, dek, "test");
  await plugin.lockNote(file.path);
  assert.ok(!harness.files.get(file.path)!.includes("secret-xyz"), "plaintext re-sealed");
  assert.equal(
    await plugin.notes.readPlaintext({ path: file.path } as any, dek, vaultId),
    "# 未保存的明文 secret-xyz",
    "content preserved in the payload",
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

test("a created note is encrypted with the real DEK from the first byte", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { parseNoteRef } = await import("../src/core/format");

  const vaultId = "23450000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.unlockService.dekFor = async () => dek;
  await plugin.newSealedNote(undefined, "测试笔记");

  const created = [...harness.files.keys()].find((p) => p.endsWith(".sealed.md"))!;
  const payloadPath = [...harness.files.keys()].find((p) => p.endsWith(".sealedpayload"))!;

  // The payload is real before a single character is typed: there is no window
  // in which the note exists but its ciphertext is a throwaway envelope.
  assert.equal(
    await plugin.notes.readPlaintext({ path: payloadPath } as any, dek, vaultId),
    "",
    "empty body sealed under the real DEK",
  );
  assert.ok(plugin.sessions.get(created), "session established at creation");
  assert.ok(plugin.isUnlocked(created), "note is editable right away");

  const refLine = harness.files.get(created)!.split("\n")[0];
  harness.files.set(created, `${refLine}\n# 我的新秘密\n\n正文内容`);
  // Saving must never reach for a credential again: the DEK is already here.
  let promptsDuringSave = 0;
  plugin.unlockService.dekFor = async () => {
    promptsDuringSave++;
    return null;
  };
  await plugin.flushNote(created);
  assert.equal(promptsDuringSave, 0, "autosave is silent - no dialog mid-typing");

  assert.equal(
    await plugin.notes.readPlaintext({ path: payloadPath } as any, dek, vaultId),
    "# 我的新秘密\n\n正文内容",
    "flush writes under the same key, with no prompt",
  );
  assert.ok(parseNoteRef(harness.files.get(created)!), "ref intact");
  assert.ok(harness.files.get(created)!.includes("我的新秘密"), "body stays editable");
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

  // The note's tab is a padlock leaf; the ACTIVE leaf is the file explorer.
  const sealedSwitches: string[] = [];
  const sealedLeaf = {
    view: { getViewType: () => "sealed-note-view", file: { path: file.path } },
    setViewState: async (s: any) => { sealedSwitches.push(`${file.path}->${s.type}`); },
  };
  harness.app.workspace.sealedLeaves = [sealedLeaf];
  harness.app.workspace.activeLeafIsSide = true;
  assert.equal((plugin as any).isSideLeaf(harness.app.workspace.activeLeaf), true, "stub detects side leaf");

  await plugin.unlockNote(file);

  assert.ok(harness.files.get(file.path)!.includes("<!--"), "body revealed in place");
  assert.deepEqual(sealedSwitches, [`${file.path}->markdown`], "the note's own leaf switched to markdown");
  assert.equal(harness.registered.activeLeafSwitches.length, 0, "sidebar leaf was NOT used");
  plugin.onunload();
});

test("opening a sealed note switches only its own leaf to the padlock, not other tabs", async () => {
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

  assert.deepEqual(switched, [`${file.path}->sealed-note-view`], "only the sealed note's leaf is switched");
  plugin.onunload();
});

test("renaming a private note without .sealed.md restores the suffix and keeps its ID", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");
  const { parseNoteRef } = await import("../src/core/format");

  const vaultId = "78900000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  const file = await plugin.notes.create({ vaultId, kid: vaultId, keyring }, dek, "Private/daily", "daily");
  const ref = parseNoteRef(harness.files.get(file.path)!)!;
  assert.ok(plugin.notes.refForPath(file.path), "ID cached under original path");

  const renameHook = harness.registered.events.find((e) => e.name === "vault:rename");
  assert.ok(renameHook, "rename hook registered");

  // User renames to "summary.md" (drops .sealed). Simulate vault rename + event.
  harness.files.delete(file.path);
  harness.files.set("Private/summary.md", "# 内容\n");
  await renameHook!.fn({ path: "Private/summary.md", basename: "summary", extension: "md" }, file.path);
  for (let i = 0; i < 50 && !harness.files.has("Private/summary.sealed.md"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(harness.files.has("Private/summary.sealed.md"), "suffix restored automatically");
  assert.equal(harness.files.has("Private/summary.md"), false, "old no-suffix path gone");
  assert.equal(plugin.notes.refForPath("Private/summary.sealed.md"), ref, "ID cache moved to new path");
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

test("saving a note really replaces its payload and leaves no scratch files", async () => {
  const { plugin, harness } = await boot();
  const { createKeyring } = await import("../src/core/keyring");
  const { generateRecoveryKey } = await import("../src/core/recovery");

  const vaultId = "ef010000-2222-4333-8444-555555555555";
  const { keyring, dek } = await createKeyring(vaultId, "pw-1234567890", generateRecoveryKey(), {
    iterations: 100_000,
  });
  plugin.vaultIdentifier = vaultId;
  plugin.hasKeyring = async () => true;
  plugin.unlockService.requireKeyring = async () => keyring;
  plugin.unlockService.dekFor = async () => dek;

  await plugin.newSealedNote(undefined, "替换");
  const created = [...harness.files.keys()].find((p) => p.endsWith(".sealed.md"))!;
  const payloadPath = [...harness.files.keys()].find((p) => p.endsWith(".sealedpayload"))!;
  const before = harness.files.get(payloadPath)!;

  const refLine = harness.files.get(created)!.split("\n")[0];
  harness.files.set(created, `${refLine}\n第二次保存也必须落盘\n`);
  await plugin.flushNote(created);

  // The regression: atomicWrite renamed a temp file onto an existing payload,
  // which Obsidian refuses ("Destination file already exists!"). The payload
  // therefore never changed and a .tmp was left behind on every save.
  assert.notEqual(harness.files.get(payloadPath), before, "payload was actually rewritten");
  assert.equal(
    await plugin.notes.readPlaintext({ path: payloadPath } as any, dek, vaultId),
    "第二次保存也必须落盘\n",
    "payload decrypts to what the user typed",
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
  const refLine = harness.files.get(created)!.split("\n")[0];
  // Typed, but the save never reached disk (the bug this session fixes).
  harness.files.set(created, `${refLine}\n这段字不能丢\n`);

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

  // And the next save finishes what the failed one started: the text lands in
  // the payload under the real DEK, so the note is genuinely encrypted again.
  restarted.unlockService.dekFor = async () => dek;
  restarted.unlockService.requireKeyring = async () => keyring;
  await restarted.flushNote(created);
  const payloadPath = [...h2.files.keys()].find((p) => p.endsWith(".sealedpayload"))!;
  assert.equal(
    await restarted.notes.readPlaintext({ path: payloadPath } as any, dek, vaultId),
    "这段字不能丢\n",
    "the retried save puts the text into the payload under the real DEK",
  );

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

test("a wrong dynamic code is called a wrong code, and says what to do", async () => {
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
  assert.match(msg, /动态密码不对/, "names the actual cause");
  assert.match(msg, /主密码/, "tells the user the way out");
  assert.ok(!/^.*不正确，请重试$/.test(msg), "not the old generic 'wrong, try again'");
  setLanguage("en");
  plugin.onunload();
});

test("a correct dynamic code that does not match the key says exactly that", async () => {
  const { plugin } = await boot();
  const { setLanguage } = await import("../src/i18n");
  setLanguage("zh");
  const { seed } = await totpOnlyService(plugin, "fa020000-2222-4333-8444-555555555555");
  const { generateTotpSecret, totpCode } = await import("../src/core/totp");

  // A different, perfectly valid seed: the code verifies, the key does not open.
  const otherSeed = generateTotpSecret();
  const code = await totpCode(otherSeed);

  const seen: any[] = [];
  plugin.unlockService.setUi(() => ({
    prompt: async (request: any) => {
      seen.push(request);
      return seen.length === 1
        ? { providerId: "totp", code, totpSeed: otherSeed }
        : null;
    },
  }));

  await plugin.unlockService.dekFor("note-b.md");
  const msg = seen[1].error as string;
  assert.match(msg, /动态密码是对的/, "does not blame the code, which was valid");
  assert.match(msg, /重新绑定|主密码/, "explains the repair");
  assert.ok(seed !== otherSeed);
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

  const lines = harness.files.get(path)!.split("\n");
  assert.ok(lines[0].includes("sealed-note:ref="), "ID comment is line 1");
  assert.equal(lines[1], "", "the body starts on an empty line 2");
  assert.deepEqual(caret, { line: 1, ch: 0 }, "caret waits on the line after the comment");
  assert.equal(focused, true, "the editor is focused so typing goes to the note");
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
    plugin.sessions.put(file.path, dek, "test");
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
