# Sealed Note — 完整设计方案

> Obsidian 加密插件 · v1.0 设计稿
> 目标：只加密"某篇笔记 / 某段内容"，而不是加密整个 vault；忘记密码不会导致数据永久报废。

---

## 0. 先回答那个悬而未决的问题：找回、重置，还是别的？

你的 PRD 里写的是"用恢复密钥把**所有文档的加密文本都重新解密加密**"。这个做法能work，但它有三个硬伤：

| 问题 | 全库重加密的代价 |
|---|---|
| 慢 | 每篇笔记一个 PBKDF2。100 篇 × 600k 迭代 ≈ 60–90 秒，移动端更久 |
| 危险 | 中途崩溃/断电/同步冲突 → 一部分文件是新密文、一部分是旧密文，可能永久打不开 |
| 没必要 | 换密码只是换"钥匙的包装"，**内容本身没变**，凭什么要重写所有内容？ |

所以正确的做法是**信封加密（envelope encryption）**，也是 1Password / Bitwarden / macOS 钥匙串的标准结构：

```
                     ┌──────────────────────────────┐
   主密码  ──PBKDF2──▶│ KEK_pw  ──解开──┐            │
                     └─────────────────┤            │
                     ┌─────────────────┤   ┌────────┴────────┐
   恢复密钥 ─PBKDF2──▶│ KEK_rec ──解开──┼──▶│  DEK（数据密钥） │
                     └─────────────────┘   │  32 字节随机     │
                                            └────────┬────────┘
                                                     │ HKDF + 每文件盐
                                        ┌────────────┴────────────┐
                                        ▼                         ▼
                                   笔记 A 的文件密钥          内联块密钥
                                        │                         │
                                   AES-256-GCM               AES-256-GCM
```

**DEK 是真正的钥匙，主密码只是装钥匙的盒子。** 由此得到：

- **改密码 = 只重新包一次 DEK**，写入一个几百字节的 keyring 文件 → 毫秒级、原子、零风险。所有笔记立刻用新密码可读。
- **忘记密码 = 用恢复密钥解开同一个 DEK** → 重设主密码。**数据一行都不用重写**。
- **只有真正的密钥泄露**（恢复密钥也外泄了）才需要"轮换 DEK + 全库重加密"——这个我们做成显式的高级操作，带备份与进度，不是日常路径。

所以严格说，这是**"凭证重置（credential reset）"，不是"数据找回（data recovery）"**：

- 找回密码？**做不到，也不该做**。密码若以任何可还原形式存盘（哪怕加密），它就不再是密码。任何声称"能帮你找回密码"的加密产品都在骗你或留了后门。
- 重置密码？**做得到，且不丢数据**——因为你丢的是"包装钥匙"，不是"钥匙"。
- 真正的"找回"只有一条合法路径：**恢复密钥**（离线保存的 256 位随机串）。它等价于第二把钥匙，不是密码提示。

UI 文案就按这个事实写，不含糊：
> 主密码不会保存在任何地方。忘记密码时，请用**恢复密钥**重设——你的笔记不会丢失。
> 没有恢复密钥，也没有密码，数据将永久无法解密。这是设计，不是故障。

---

## 1. 需求 → 功能映射

| PRD 条目 | 落地方案 |
|---|---|
| 新建"隐私笔记"（不是加密整个 vault） | 独立扩展名 `.sealed`，专属视图；不影响普通笔记 |
| 未设主密码时先引导设置 | 首次调用任一加密命令 → 初始化向导（设密码 → 生成恢复密钥 → 强制确认已保存） |
| 解密密码"面向接口" | `UnlockProvider` 接口 + 三个实现：主密码 / 密码+TOTP / 恢复密钥 |
| 主密码 + 外部解密工具 | `tools/decrypt.html` 单文件离线解密器，与插件共用同一套格式常量 |
| UI 明示密码不存盘、丢了就没了 | 初始化向导 + 解锁弹窗 + 设置页三处固定警示块 |
| 动态密码（2FA） | TOTP（RFC 6238，SHA-1/6 位/30 秒），种子加密后存于 keyring |
| 每种方式都配密码重置 | 每个 slot 都可独立重设；恢复密钥可随时轮换；支持 DEK 轮换 |
| 打开加密文档 → 每次输入密码 → 看到明文 | 自定义视图，解锁态仅存内存；切换文档立即丢弃 |
| 保存时落盘为密文 | 视图 `save()` 内加密后写盘；缓冲区明文永不落盘 |
| ` ```encrypted_txt ` 内嵌块 | 围栏代码块，编辑态为密文，阅读态渲染为锁卡片 |
| `txt_entrypted` 内联 | 行内代码 payload（`sn1:` 前缀），渲染为 🔒 药丸 |
| 右键"解密整个文档" | 文件菜单命令，带风险确认 |
| 右键"解密所选内容" / "到剪贴板" | 编辑器菜单 + 命令面板 |
| 放到 `.obsidian/plugins` 加载测试 | `npm run deploy` 一键构建并复制，含启用步骤 |

---

## 2. 技术选型与工程结构

**栈**：TypeScript + esbuild + Obsidian API（无运行时第三方依赖；加密只用 Web Crypto）。

```
obsidian-encrypt-text/
├── src/
│   ├── main.ts                  # 插件入口：注册视图/命令/菜单/设置
│   ├── core/
│   │   ├── crypto.ts            # AES-GCM / PBKDF2 / HKDF / base64 / base32
│   │   ├── totp.ts              # RFC 6238
│   │   ├── keyring.ts           # DEK 生命周期、slot 包裹、generation、限流
│   │   ├── format.ts            # 三套信封格式的编码/解码 + AAD 常量
│   │   ├── session.ts           # 解锁态（内存），按文件路径归属，TTL
│   │   ├── recovery.ts          # 恢复密钥生成/校验/重置/轮换
│   │   └── providers/
│   │       ├── provider.ts      # UnlockProvider 接口 + 注册表
│   │       ├── password.ts
│   │       ├── totp.ts
│   │       └── recovery.ts
│   ├── notes/
│   │   ├── sealed-view.ts       # .sealed 自定义视图（CM6 + 自动封存）
│   │   └── sealed-file.ts       # 读写 .sealed（加解密 + 原子写 + 备份）
│   ├── inline/
│   │   ├── codeblock.ts         # 阅读态渲染器（encrypted_txt）
│   │   ├── postprocessor.ts     # 行内 🔒 渲染
│   │   └── cm-extension.ts      # 编辑态折叠/替换装饰
│   ├── ui/
│   │   ├── modals.ts            # 解锁、初始化、恢复密钥展示、确认
│   │   ├── settings.ts          # 设置页
│   │   └── notice.ts            # 统一提示与错误文案
│   └── util/
│       ├── errors.ts            # 类型化错误 + 用户可读文案映射
│       └── log.ts               # 结构化日志（不记密钥/明文）
├── tools/
│   └── decrypt.html             # 离线解密器（单文件，无依赖）
├── tests/index.test.ts          # node:test，跑真实 Web Crypto
├── docs/DESIGN.md               # 本文
├── docs/USER-GUIDE.md
├── manifest.json / versions.json / esbuild.config.mjs / tsconfig.json
└── scripts/deploy.mjs
```

---

## 3. 加密规格（可审计、可离线复现）

### 3.1 原语

| 用途 | 参数 |
|---|---|
| 内容加密 | AES-256-GCM，12 字节随机 IV，128 位 tag |
| 人类密钥 → KEK | PBKDF2-HMAC-SHA512，600,000 次迭代，16 字节随机盐（存于 slot，可读，明文） |
| DEK → 子密钥 | HKDF-SHA256，16 字节随机盐，`info` 域分隔 |
| TOTP | HMAC-SHA1，6 位，30 秒，±1 步容差 |

迭代次数写在每个 slot 里，日后可无痛提高（老数据按存储值解）。600k 是现代笔记本约 0.3–0.5s 的量级，兼顾移动端。

### 3.2 Keyring（一个文件，位于插件目录）

```json
{
  "format": "sealed-note/keyring/1",
  "vaultId": "b1f2…uuid",
  "generation": 3,
  "kdf": { "hash": "SHA-512", "iterations": 600000 },
  "slots": {
    "password": { "salt": "b64", "wrap": { "iv": "b64", "data": "b64" }, "updatedAt": "ISO" },
    "recovery": { "salt": "b64", "wrap": { "iv": "b64", "data": "b64" }, "updatedAt": "ISO" }
  },
  "totp": {
    "enabled": true,
    "secret": { "iv": "b64", "data": "b64" },
    "digits": 6, "period": 30
  },
  "fingerprint": "8f3a 91c2 4d7e 0b15",
  "guard": { "failCount": 0, "lockedUntil": null }
}
```

关键设计点：

- **`wrap` 里没有密码，也没有 DEK 明文**。`data` = AES-GCM(KEK, DEK)，AAD = `sealed-note|keyring|<vaultId>|<slot>|g<generation>`。
  - AAD 绑定 slot 名 → **不能把 password slot 的密文挪到 recovery slot 复用**。
  - AAD 绑定 generation → 每次重设 `gen++`。**注意能力边界**：这只能防两类攻击——① 篡改 `gen` 数字（AAD 对不上）② 把某个槽的密文挪到另一个槽（AAD 里的 slot 名对不上）。它**防不住**"把整格原样还原"，因为 `gen` 就存在格子里，会跟着一起回来。真正的整文件回滚要靠设备端高水位记录，且新设备无记忆。详见 [CRYPTO.md 第 7 节](CRYPTO.md#7-回滚攻击能力边界与处置)。
- **`fingerprint`** = HKDF(DEK, "fp") 前 8 字节。解锁后显示，用于让用户确认"我拿到的是同一把钥匙"。也用于恢复密钥校验时快速判断对错。
- **`totp.secret`** 用 DEK 加密。诚实说明：这把 TOTP 挡的是**拿到 vault 文件 + 知道你密码的人**（他还需要你的手机），但它是**应用层门禁**，不是密码学强制——因为绕过它不需要破译任何密文，只需要改插件代码。真正的密码学根是恢复密钥。这一点会写进 UI 与文档，不吹。

### 3.3 隐私笔记 `.sealed`

整个文件是一个 JSON 信封，**没有任何明文元数据**（标题来自文件名，是唯一泄露点，见 §8）：

```json
{
  "format": "sealed-note/note/1",
  "kid": "b1f2…uuid",
  "salt": "b64 16B",
  "iv": "b64 12B",
  "data": "b64 (ciphertext ‖ tag)"
}
```

- 文件密钥 `FK = HKDF(DEK, salt, "sealed-note/note/v1")`
- AAD = `sealed-note|note|<vaultId>` — **刻意不含 generation**，所以改密码/换恢复密钥后，所有笔记无需动一下。
- 明文是整个 Markdown 文本（含可能的 frontmatter）。解密后交给 CM6 视图。
- 写盘：先写 `xxx.sealed.tmp` 再 `adapter.rename` 覆盖；同时把旧版本落到 `插件目录/backups/`（保留最近 5 份）——防止解密器 bug 吃掉原文。

### 3.4 内联块

围栏（编辑态看到的真实内容）：

````
```encrypted_txt
sn1.<base64( salt8 ‖ iv12 ‖ ciphertext ‖ tag )>
```
````

- `BK = HKDF(DEK, salt8, "sealed-note/inline/v1")`，AAD = `sealed-note|inline|<vaultId>|v1`
- 别名同时接受 `txt_encrypted` / `sealed`（PRD 里写的 `txt_entrypted` 应为笔误，两个都认）。
- 行内：`` `sn1:<base64>` `` → 阅读态渲染成 `🔒 密文`（悬停显示长度，点击解密）。
- 块内始终是密文，**编辑器缓冲区里从不出现明文**——这是"保存后就是密文"的天然实现，不需要拦截保存。

---

## 4. 解锁体系（面向接口）

```ts
export interface UnlockProvider {
  readonly id: "password" | "totp" | "recovery";
  readonly label: string;
  isConfigured(kr: Keyring): boolean;
  /** 返回解开后的 DEK；失败必须抛 UnlockError，不得返回部分结果 */
  unlock(kr: Keyring, ui: UnlockUi): Promise<Uint8Array>;
}
```

- **password**：输入框 → PBKDF2 → 解 `slots.password` → DEK。
- **totp**：先密码解 DEK → 用 DEK 解出 TOTP 种子 → 弹 6 位码输入 → 校验通过才交付 DEK；失败则不交付（DEK 在闭包里被丢弃）。
- **recovery**：输入恢复密钥（自动补 `-`、忽略大小写/空格）→ PBKDF2 → 解 `slots.recovery` → DEK。

新增方式（未来：通行密钥 / 系统钥匙串 / 硬件令牌）只要实现该接口并在注册表登记，UI 自动出现选项——这是"面向接口"的落点。

**会话与锁定**
- DEK 只在内存（`Map<filePath, SessionEntry>`），条目含 `dek`、`unlockedAt`、`expiresAt`。
- 默认策略 **严格按 PRD**：打开即索要密码；`active-leaf-change` 离开该笔记 → 立即 `lock(filePath)` 并清零缓冲区（明文填 0 后丢弃引用）。
- 设置项可放宽为"保持 N 分钟"（N=0 即每次都要输）。默认 0。
- 命令"锁定全部" + 状态栏按钮，一键清空所有会话。

**限流**：连续 5 次失败 → 退避（1s/2s/4s…上限 60s），计数与 `lockedUntil` 写进 keyring.guard。诚实标注：这是防"有人在你电脑前瞎试"，不是防离线爆破。

---

## 5. 密码重置 / 恢复 流程

### 5.1 初始化（首次）
1. 设置主密码（≥10 位，实时强度条；弱密码只警告不阻断）。
2. 生成 DEK、password slot。
3. 生成恢复密钥：32 字节 → Base32 → 分 13 组展示（`K7QM-3XPD-…`），提供 **复制 / 下载 .txt / 打印样式**。
4. **强制勾选**"我已离线保存恢复密钥，理解没有它无法恢复"才能完成。
5. 写 keyring + 显示指纹。

### 5.2 忘记密码（重置）
```
恢复密钥 → 解 DEK → 校验指纹 → 设新密码 → 新 salt 新 wrap → generation++ → 原子写 keyring
```
完成提示："已重设主密码。共 12 篇隐私笔记保持原样，无需重新加密。"
（因为 DEK 未变——这是信封模型的红利，要在 UI 里明说，用户才敢用。）

### 5.3 轮换恢复密钥（密码还在）
设置 → "重新生成恢复密钥" → 解 DEK → 新恢复密钥 + 新 wrap → generation++ → 强制展示+确认。旧恢复密钥立刻作废。

### 5.4 密钥泄露 → 轮换数据密钥（高级）
1. 确认框（红色，需手动输入 `ROTATE`）。
2. 全量备份到 `backups/rotate-<时间戳>/`。
3. 生成 DEK₂ → 新 keyring（password+recovery 双 slot 重新包裹）→ 逐文件用 DEK₂ 重加密（进度条，可取消，已完成的记录进 journal）。
4. 中断后可重入：journal 记录已迁移文件，续跑不重复。
5. 完成后清空所有会话。

---

## 6. 交互与 UI

**入口**
- 左侧功能栏 🔒 图标 → 菜单：新建隐私笔记 / 解锁并打开 / 锁定全部 / 设置。
- 命令面板 9 条命令（新建、加密所选、加密整篇、解密所选、解密到剪贴板、锁定当前、锁定全部、恢复密钥、导出离线包）。
- 右键：文件树（新建隐私笔记、解锁/锁定、解密整个文档）；编辑器（加密所选、解密所选、解密到剪贴板）。
- 状态栏：`🔓 已解锁 · 3 篇` / `🔒 已锁定`，点击切换。

**解锁弹窗**：标题"解锁《笔记名》"；provider 切换 tab（主密码 / 两步验证 / 恢复密钥）；底部固定小字警示；错误内联显示不弹窗；Enter 提交；失败抖动动画。

**阅读态渲染**
- 围栏 → 卡片：`🔒 已加密内容 · 点击解密`，解密后原地显示明文 + 右上"重新加密"。
- 行内 → `🔒 密文` 药丸。
- 未解锁时点解密 → 先弹解锁，成功后再执行原动作（有上下文，不用点两次）。

**新建隐私笔记后的体验**：直接落在 `.sealed` 视图里、光标就位、标题可改（重命名文件）、`Ctrl+S` 或失焦 1.5s 自动保存（加密落盘）。首次保存前文件内容为空信封占位。

---

## 7. 交付与验收

| 项 | 标准 |
|---|---|
| 单测 | 加解密往返、AAD 篡改必失败、slot 互换必失败、gen 篡改必失败、整格还原**可复现**（记录能力边界）、回滚仅警告不阻断、TOTP 已知向量（RFC 6238 附录 B）、base32 往返、恢复密钥格式化 |
| 编译 | `tsc --noEmit` 零错误；esbuild 产物 `main.js` |
| 设备验证 | 装入 `D:/work/obsidian/.obsidian/plugins/sealed-note` → 启用 → 建笔记 → 加内联块 → 重开 Obsidian 验证已锁 |
| 离线工具 | `tools/decrypt.html` 用密码**和**恢复密钥分别解同一篇笔记，结果一致 |
| 跨端 | 手机端只用密码路径（TOTP 也可），不依赖 Node/Electron API（`isDesktopOnly: false`） |

**发布路径**（Obsidian 社区插件）：GitHub Release 附 `main.js/manifest.json/styles.css` → 提交 `obsidian-releases` PR → 审核。此步放在功能验收通过之后。

---

## 8. 安全边界（写进 README，不含糊）

**能防**
- 云端同步泄漏（iCloud/坚果云/Git 仓库只看到密文）
- 电脑丢失但系统已锁屏、vault 被别人翻看
- 笔记被 AI/搜索工具批量索引（`.sealed` 不在 Markdown 索引里）
- 有人拿到 vault 文件 + 知道你密码，但没有你的手机（若开 TOTP）

**防不住（必须告知）**
- 解锁状态下：明文在内存、在渲染层、可被截屏/录屏/剪贴板泄漏
- 文件名、文件大小、修改时间、文件数量
- 键盘记录器、恶意插件、被入侵的操作系统
- 弱密码 + 拿到 keyring → 离线爆破（所以 600k 迭代 + 强度提示）
- 恢复密钥拍照存相册 = 等于把钥匙贴在门上

---

## 9. 实施顺序（预计 6 个批次）

1. 工程骨架 + crypto/totp/format + 单测（**先绿再往下**）
2. keyring + providers + session（含限流、generation 语义）
3. `.sealed` 视图 + 自动封存 + 原子写 + 备份
4. 内联块三件套（渲染器、后处理器、编辑器装饰）+ 右键与命令
5. UI（初始化/解锁/恢复密钥/设置/状态栏）+ 离线 decrypt.html
6. 装进 vault 实测 → 修 → 文档 → 发布材料 → 最后封成"Obsidian 插件开发"专家（保留本次全过程）

---

## 10. 待你点头的四个决策

1. **载体**：`.sealed` 独立扩展名（推荐，干净且不进搜索索引） vs 普通 `.md` 里放一整块密文。
2. **重置策略**：默认"只重包 DEK"（秒级）+ 独立的全库轮换命令（推荐） vs 每次都全库重加密。
3. **TOTP 定位**：作为"密码之后的第二道门"（推荐，GitHub 同款） vs 允许单独用 TOTP 解锁（安全性会掉一个量级）。
4. **解锁保持**：默认每次打开都要输（按你的 PRD，推荐） vs 默认免输 5 分钟。