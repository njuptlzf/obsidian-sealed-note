# 设计稿：单文件正文信封（方案 B）

状态：已决策，待实施。对应版本：2.0.0（破坏性格式变更）。
基线：master `22a3b6c`（v1.2.0）。分析工具：cbm 图谱，索引 freshness `current`。

## 1. 决策背景

用户对 v1.1.0 引入的 sidecar 架构提出三个问题：

1. 每篇隐私笔记要维护一个 `<!-- sealed-note:ref=<uuid> -->` 注释锚点；
2. 密文存在独立的 `sealed-data/` 目录与 `.sealedpayload` 文件里，用户看不懂、担心误删；
3. 注释一旦丢失，需要恢复密钥暴力试解所有 payload 并人肉匹配，设置页因此多出 `payloadDir` / `deletePayloadWithNote` / `cleanOrphans`。

方案 C（按笔记路径哈希派生 payload 文件名）能去掉注释，但**路径即锚点**：笔记改名、跨设备同步、外部重命名时若 `rename` 事件没被 Obsidian 捕获，payload 依旧失联。用户明确选择方案 B。

**目标**：彻底移除独立密文目录和独立密文文件。密文信封直接存放在 `.sealed.md` 正文里；锁定态正文是密文，解锁态正文是明文。笔记文件改名、移动、同步都不影响可解密性，因为密文就在文件自身里。

## 2. 现状结构与影响面（图谱实测）

| 符号 | 直接/传递调用者 | 位置 |
|---|---|---|
| `parseNoteRef` | 15 / 65 | `format.ts:45-53`，跨 5 个子系统 |
| `writePlaintext` | 3 / 19 | `sealed-note-store.ts:210-249` |
| `resolveEnvelope` | 1 / 8 | `sealed-note-store.ts:173-193` |
| `updateKeyCopy` | 2 / 10 | `sealed-note-store.ts:252-272` |

现状三态都在代码里：

- **sidecar 格式**（当前写入）：正文 = ref 注释 + 占位提示，信封在 `sealed-data/<ref>.sealedpayload`；
- **legacy 格式**（当前可读、保存时迁移）：正文 = `<!-- sealed-note/note/1 {json} -->` 注释包裹的信封；
- **revealed 格式**（解锁态）：正文 = ref 注释 + 明文（`revealNote` at `sealed-note-store.ts:322-334`、`serializeNoteRevealed` at `format.ts:71-73`）。

关键有利事实：`serializeNoteEnvelope`（`format.ts:194-197`）产出的 legacy 注释包裹格式**就是方案 B 需要的锁定态格式**，`parseNoteEnvelope`（`format.ts:212-244`）已经能读它，且只校验必需字段、额外字段原样保留。核心编解码不需要重写。

## 3. 格式设计

### 3.1 三态判定（放 `core/format.ts`，纯函数，可单测）

```
锁定态  sealed     : parseNoteEnvelope(text) !== null
旧格式  sidecar    : parseNoteRef(text) !== null（迁移期兼容读）
解锁态  revealed   : 上面都不成立且正文非空（纯明文，无注释行）
空笔记  empty      : 正文空白（新建笔记解锁后的初始态）
```

`isSealedPath`（`sealed-note-store.ts:83-85`）仍按 `.sealed.md` 后缀识别，三态判定只在该后缀文件内使用。

### 3.2 锁定态正文

直接复用 `serializeNoteEnvelope(envelope)`：

```
<!-- sealed-note/note/1
{
  "format": "sealed-note/note/1",
  "kid": "...",
  "salt": "...",
  "iv": "...",
  "data": "...",
  "keys": { ... }
}
-->
```

- 渲染视图下是 HTML 注释，显示为空白页；源码视图看到信封，但**是密文**，agent 读取、同步工具、协作者都拿不到明文。
- `keys` 字段（key copy）保留在每篇锁定笔记里，这是无 keyring 文件架构的密钥来源。

### 3.3 解锁态正文

纯明文，**不带任何注释行**。取消 `serializeNoteRevealed` 的 ref 行前缀。

- 好处：正文就是 Markdown，原生编辑体验完整，复制/搜索/同步都正常。
- 代价：解锁态磁盘上有明文。这是应用层加密的既有边界（`format.ts:64-73` 的注释原本就承认这点），方案 B 不改善也不恶化。用户已确认接受：**只要求锁定态下 agent 读到密文**。

## 4. 状态机与写入安全

```
  锁定态(信封 JSON) --解锁--> [备份密文] --写明文--> 解锁态(纯明文)
        ^                                              |
        |                                              | 编辑/autosave
        +-- 加密写回信封 <------------------------------+
```

### 4.1 正文写入用 vault.modify，不用适配器 swap（关键修正）

v1 的双文件架构里，payload 不是编辑器打开的文件，所以用 `writeAndSwap`（`sealed-note-store.ts:452-478`）做适配器级原子替换；正文用 `vault.modify` 保持编辑器同步。v2 里正文**同时是密文容器和编辑器内容**，适配器级 swap 会让编辑器 buffer 与磁盘脱节（用户继续打字会把旧 buffer 刷回去覆盖密文）。所以：

- **正文写入一律用 `app.vault.modify(file, content)`**，让 Obsidian 自己同步编辑器；
- `writeAndSwap` 的随机 token 与串行写链保留给仍需适配器写的场景（旧 payload 迁移读取、备份文件），不用于正文；
- 失败恢复靠"密文信封有完整校验 + 重复写幂等"，而不是临时文件换位。

这个取舍放弃了正文写入的严格原子性，换取编辑器一致性；profile §7 的临时名事故不会在这条路径上复现，因为这条路径根本不产生临时文件。

### 4.1b 备份绝不落明文

现有 `backupBeforeOverwrite`（`sealed-note-store.ts:505-518`）把**写入前的字节**备份到插件私有目录。v2 下：

- 解锁时写明文：写入前是密文 → 备份密文，**安全**；
- 锁定时写信封：写入前是明文 → 备份明文，**不安全**。

因此备份函数加一道判定：`noteBodyState(current) !== "sealed"` 就直接跳过，只有当前字节是密文信封才备份。明文永远不会出现在备份目录。

### 4.1c 自动保存语义变更

v1 的 `flushNote`（`main.ts:1249-1277`）在解锁态把明文加密写进 payload，正文保持明文。v2 没有第二个位置可写：**解锁态磁盘正文就是明文，这是用户已确认接受的应用层边界**。因此 `flushNote` 退化为无操作（保留函数签名与调用链，避免动生命周期钩子），唯一真正写密文的时刻是锁定（`reSealNote`）。这也消除了 autosave 与锁定时写同一文件的竞态。

### 4.2 启动扫描：明文态提示

启动时扫描 `.sealed.md`，`noteBodyState` 判为 `revealed` 的记录到列表并提示"N 篇笔记当前是明文态"。不自动写回（自动加密会在用户无密钥时失败或打断编辑）。下次锁定走正常 `reSealNote` 把它加密成信封即可。用户已明确接受解锁态明文落盘的边界。

默认 `lockPolicy: blur` 保证离开笔记即锁，正常关闭时 `onunload` re-seal，因此"所有笔记都解锁"只在崩溃时可能出现，是可接受的边界。

## 5. keyring 来源改造

- `NoteKeyringStore.sources`（`note-keyring-store.ts:55-74`）：从"扫描 payload + 带 ref 的 note（去重）"改为"扫描所有 `.sealed.md` 的正文信封，取 `keys` 字段"，去重逻辑删除。
- `VaultRecoveryService.findCandidates`（`vault-recovery.ts:50-73`）：同样改为扫描正文信封。
- `KeyCopyRefreshService.refreshAll`（`key-copy-refresh.ts:48-113`）：删除"跳过有 ref 的 note"分支，逐个更新正文信封的 `keys` 字段。
- `SealedNoteStore.updateKeyCopy`（`sealed-note-store.ts:252-272`）：删除 payload 分支与 ref 分支，只保留 `atomicWrite(file, serializeNoteEnvelope(updated))`。

`NoteEnvelope` / `KeyCopy` 接口与所有密码学原语（`sealNote` / `openNote` / `noteAad` / `deriveNoteKey`）**零改动**。这是"不挑战密码学"的具体含义。

## 6. 连根删除的旧功能

按删功能纪律同步清理：代码、设置字段与默认值、`normalizeSettings` 分支、UI 控件、i18n 双语键、命令与菜单、service 调用链、测试引用，最后 grep 旧符号计数应为 0。

- 命令：`restore-annotation`、`clean-orphan-payloads`
- 类/方法：`RestoreService`、`RestoreModal`、`SealedNoteStore.orphanPayloads` / `deletePayload` / `moveRef` / `forgetPath` / `refForPath` / `placeholderWithRef`
- 格式：`NOTE_REF_PREFIX` / `NOTE_REF_SUFFIX` / `noteRefLine` / `parseNoteRef` / `serializeNotePlaceholder` / `serializeNoteRevealed` / `parseRevealedBody` / `PAYLOAD_EXTENSION`（迁移期需保留读取函数，迁移完成后再删）
- 设置：`payloadDir`、`deletePayloadWithNote`
- 常量：`DEFAULT_PAYLOAD_DIR`
- 文件/目录：`sealed-data/` 整个目录（迁移后清理）

## 7. 迁移设计

旧格式 → 新格式是破坏性变更，major `2.0.0`。命令 `migrate-to-single-file`，规则：

1. 扫描所有 `.sealed.md`：
   - 已是正文信封 → 跳过（幂等）；
   - 有 ref 注释 → 读 `sealed-data/<ref>.sealedpayload`，验证信封可解析；
   - 无 ref 也无信封但正文非空 → 视为明文态，跳过（解锁态不迁移）；
2. 每个笔记独立提交：先 `atomicWrite(file, serializeNoteEnvelope(env))`，成功后再删对应 payload 文件；
3. 任一步失败：保留旧格式不动，记录失败列表，命令可重复运行重试；
4. 全部成功后提示用户可手动删除空的 `sealed-data/` 目录（不自动递归删除用户目录）；
5. 迁移过程写入前同样遵守 §4.1 的备份规则（只备份密文）。

## 8. 测试计划

- **格式层单测**：三态判定覆盖四种输入；`serializeNoteEnvelope` → `parseNoteEnvelope` round trip；额外字段保留。
- **fails-then-passes 回归**：删除注释后正文信封仍可解锁（旧代码必失败）；rename/move 后仍可解锁（方案 C 会失败，B 必须通过）；payload 目录不存在时隐私笔记仍可用。
- **崩溃恢复**：模拟解锁态正文 + 备份存在 → 恢复后正文为密文；所有笔记解锁态 → 引导恢复密钥而非静默失败。
- **备份安全**：锁定写入后备份目录内不得出现明文（真断言，读备份文件内容核对）。
- **迁移**：旧格式笔记迁移后可解锁、payload 被删、重复运行幂等、中途失败保留旧格式。
- 全量 `tsc --noEmit` + `npm test` + `npm run build`。

## 9. 版本与文档

- `manifest.json` `2.0.0`，`versions.json` 追加 `"2.0.0": "1.5.0"`；
- README 双语更新：删除 sidecar / `sealed-data` / 注释锚点 / 恢复注释 的全部描述，改为"单文件正文信封、锁定态密文、解锁态明文"；
- 设计稿与本文件同步。
