/**
 * Compatibility test for the shipped offline decryptor.
 *
 * It does NOT re-implement the algorithm: it loads tools/decrypt.html, extracts
 * the real script, evaluates it in a sandbox with a minimal DOM stub, and drives
 * the actual UI handlers. If this passes, the file we ship can really decrypt
 * what the plugin produced - which is the only claim that matters.
 *
 *   npm test   (part of the suite)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  createKeyring,
  serializeKeyring,
  newDek,
} from "../src/core/keyring";
import { sealNote, sealInline, wrapFenced } from "../src/core/format";
import { keyCopyFromKeyringData } from "../src/core/keyring";
import { generateRecoveryKey } from "../src/core/recovery";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "tools", "decrypt.html");

const VAULT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FAST = { iterations: 100_000 };

/* ------------------------------------------------------------------ */
/* a DOM stub just big enough for the page's script                    */
/* ------------------------------------------------------------------ */

interface StubEl {
  id: string;
  value: string;
  textContent: string;
  className: string;
  type: string;
  disabled: boolean;
  files: any[];
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, fn: () => void): void;
  fire(type: string): void;
}

function makeDom(ids: string[]): Record<string, StubEl> {
  const els: Record<string, StubEl> = {};
  for (const id of ids) {
    els[id] = {
      id,
      value: "",
      textContent: "",
      className: "",
      type: id === "secret" ? "password" : "text",
      disabled: false,
      files: [],
      listeners: {},
      addEventListener(type, fn) {
        (this.listeners[type] ||= []).push(fn);
      },
      fire(type) {
        for (const fn of this.listeners[type] ?? []) fn();
      },
    };
  }
  return els;
}

const PAGE_IDS = [
  "secret",
  "source",
  "input",
  "output",
  "summary",
  "run",
  "copy",
  "clear",
  "toggle",
];

/** Boot the page script and hand back its element stubs. */
function bootDecryptPage(): Record<string, StubEl> {
  const html = readFileSync(htmlPath, "utf8");
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(scriptMatch, "decrypt.html must contain a script block");

  const els = makeDom(PAGE_IDS);
  const sandbox: any = {
    crypto,
    atob,
    btoa,
    TextEncoder,
    TextDecoder,
    console,
    document: { getElementById: (id: string) => els[id] ?? null },
    navigator: { clipboard: { writeText: async () => undefined } },
    JSON,
    Uint8Array,
    Promise,
    String,
    Number,
    Error,
    RegExp,
    Math,
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptMatch[1], sandbox, { filename: "decrypt.html" });
  return els;
}

/** Click "解密" and wait for the async handler to settle. */
async function runDecrypt(els: Record<string, StubEl>): Promise<void> {
  els.run.fire("click");
  // the handler is async and flips disabled back when done
  for (let i = 0; i < 400; i++) {
    if (!els.run.disabled) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("decrypt handler did not finish");
}

/* ------------------------------------------------------------------ */
/* tests                                                              */
/* ------------------------------------------------------------------ */

test("offline tool is a single self-contained file with no network calls", () => {
  const html = readFileSync(htmlPath, "utf8");
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/i.test(html), "must not reference remote URLs");
  assert.ok(!/<script[^>]+src=/i.test(html), "must not load external scripts");
  assert.ok(!/\bfetch\s*\(/.test(html), "must not fetch");
  assert.ok(!/XMLHttpRequest/.test(html), "must not use XHR");
  assert.ok(html.includes("PBKDF2"), "should document its KDF");
});

test("offline tool decrypts a .sealed note with the password", async () => {
  const password = "correct horse battery staple";
  const { keyring, dek } = await createKeyring(VAULT, password, generateRecoveryKey(), FAST);
  const body = "# 机密笔记\n\napi_key = sk-live-REAL-VALUE\n";
  const sealed = await sealNote(dek, VAULT, VAULT, body);

  const els = bootDecryptPage();
  els.secret.value = password;
  els.input.value = sealed;
  els.source.files = [
    { text: async () => JSON.stringify(keyCopyFromKeyringData(keyring)) },
  ];

  await runDecrypt(els);

  assert.equal(els.output.value, body, "plaintext must match");
  assert.match(els.summary.textContent, /已解密整篇笔记/);
  assert.doesNotMatch(els.summary.className, /err/);
});

test("offline tool decrypts a .sealed note with the recovery key", async () => {
  const recovery = generateRecoveryKey();
  const { keyring, dek } = await createKeyring(VAULT, "some password", recovery, FAST);
  const body = "用恢复密钥解开的正文";
  const sealed = await sealNote(dek, VAULT, VAULT, body);

  const els = bootDecryptPage();
  els.secret.value = recovery; // formatted with dashes on purpose
  els.input.value = sealed;
  els.source.files = [{ text: async () => JSON.stringify(keyCopyFromKeyringData(keyring)) }];

  await runDecrypt(els);
  assert.equal(els.output.value, body);
});

test("offline tool rejects a wrong password with a readable message", async () => {
  const { keyring, dek } = await createKeyring(VAULT, "right", generateRecoveryKey(), FAST);
  const sealed = await sealNote(dek, VAULT, VAULT, "x");

  const els = bootDecryptPage();
  els.secret.value = "wrong";
  els.input.value = sealed;
  els.source.files = [{ text: async () => JSON.stringify(keyCopyFromKeyringData(keyring)) }];

  await runDecrypt(els);
  assert.equal(els.output.value, "");
  assert.match(els.summary.textContent, /无法解开/);
  assert.match(els.summary.className, /err/);
});

test("offline tool decrypts fenced blocks and inline payloads in a note", async () => {
  const { keyring, dek } = await createKeyring(VAULT, "pw1234567890", generateRecoveryKey(), FAST);

  const fencePlain = "数据库密码：hunter2";
  const inlinePlain = "token=abc123";
  const fence = wrapFenced(await sealInline(dek, VAULT, fencePlain));
  const inline = "`" + (await sealInline(dek, VAULT, inlinePlain)) + "`";
  const doc = ["# 标题", "", fence, "", "行内：" + inline, "", "结尾"].join("\n");

  const els = bootDecryptPage();
  els.secret.value = "pw1234567890";
  els.input.value = doc;
  els.source.files = [{ text: async () => JSON.stringify(keyCopyFromKeyringData(keyring)) }];

  await runDecrypt(els);

  assert.ok(els.output.value.includes(fencePlain), "fenced block decrypted");
  assert.ok(els.output.value.includes(inlinePlain), "inline payload decrypted");
  assert.ok(!els.output.value.includes("sn1."), "no payloads left");
  assert.ok(els.output.value.includes("结尾"), "surrounding text preserved");
  assert.match(els.summary.textContent, /加密块：成功 1，失败 0/);
  assert.match(els.summary.textContent, /行内密文：成功 1，失败 0/);
});

test("offline tool needs a key-bearing note for a whole-note file", async () => {
  const dek = newDek();
  const sealed = await sealNote(dek, VAULT, VAULT, "body");

  const els = bootDecryptPage();
  els.secret.value = "whatever";
  els.input.value = sealed; // no source note selected

  await runDecrypt(els);
  assert.equal(els.output.value, "");
  assert.match(els.summary.textContent, /没有密钥副本/);
});

test("offline tool refuses a tampered iteration count", async () => {
  const { keyring, dek } = await createKeyring(VAULT, "pw", generateRecoveryKey(), FAST);
  const sealed = await sealNote(dek, VAULT, VAULT, "body");
  const downgraded = { ...keyring, kdf: { ...keyring.kdf, iterations: 1000 } };

  const els = bootDecryptPage();
  els.secret.value = "pw";
  els.input.value = sealed;
  els.source.files = [{ text: async () => JSON.stringify(downgraded) }];

  await runDecrypt(els);
  assert.match(els.summary.textContent, /迭代次数异常/);
});

test("offline tool decrypts a note using its OWN embedded key copy, with no file selected", async () => {
  const password = "self-contained-password";
  const { keyring, dek } = await createKeyring(VAULT, password, generateRecoveryKey(), FAST);
  const body = "# 自己带密钥的笔记\n\n不需要额外文件就能解开";
  const sealed = await sealNote(dek, VAULT, VAULT, body, keyCopyFromKeyringData(keyring));

  const els = bootDecryptPage();
  els.secret.value = password;
  els.input.value = sealed;
  // deliberately do NOT set els.source.files

  await runDecrypt(els);
  assert.equal(els.output.value, body, "note decrypted using its own keys field");
  assert.match(els.summary.textContent, /已解密整篇笔记/);
});

test("offline tool leaves a damaged payload alone instead of mangling the note", async () => {
  const { keyring, dek } = await createKeyring(VAULT, "pw", generateRecoveryKey(), FAST);
  const good = wrapFenced(await sealInline(dek, VAULT, "good-value"));
  const broken = wrapFenced("sn1.AAAA" + "B".repeat(60));
  const doc = ["start", good, "middle", broken, "end"].join("\n");

  const els = bootDecryptPage();
  els.secret.value = "pw";
  els.input.value = doc;
  els.source.files = [{ text: async () => JSON.stringify(keyCopyFromKeyringData(keyring)) }];

  await runDecrypt(els);

  assert.ok(els.output.value.includes("good-value"), "good block decrypted");
  assert.ok(els.output.value.includes("sn1.AAAA"), "broken block left in place");
  assert.ok(els.output.value.includes("end"));
  assert.match(els.summary.textContent, /失败 1/);
});