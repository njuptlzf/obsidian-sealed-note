# 发布到 Obsidian 社区插件市场

本文档记录 Obsidian 官方的发布要求、本项目的实际发布状态，以及后续发版的步骤。

来源：[Obsidian 官方「Submit your plugin」](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Submit%20your%20plugin.md)、参考仓库 `njuptlzf/daily-report`。

---

## 一、官方要求（联网核对，2026-11-23）

### 仓库根目录必须有

| 文件 | 作用 | 本项目 |
|---|---|---|
| `README.md` | 描述插件用途和用法。首段会显示在插件列表页，相对链接/图片会被重写指向仓库 | ✅ |
| `LICENSE` | 授权协议 | ✅ MIT |
| `manifest.json` | 插件元信息 | ✅ |
| `main.js` | 构建产物，**只在 release 里**，不提交到仓库（`.gitignore` 排除） | ✅ release 附件 |
| `styles.css` | 样式，同上 | ✅ release 附件 |
| `versions.json` | 版本 → 最低兼容 App 版本映射 | ✅ |
| 源码 + 构建配置 | 审核需要看到源码 | ✅ `src/`、`esbuild.config.mjs` |

### manifest.json 字段规则

```json
{
  "id": "sealed-note",
  "name": "Sealed Note",
  "version": "1.0.0",
  "minAppVersion": "1.5.0",
  "description": "...",
  "author": "PCXX",
  "authorUrl": "https://github.com/njuptlzf",
  "isDesktopOnly": false
}
```

- `id`：在所有已发布插件中**必须唯一**，且**不能包含 `obsidian`**
- `version`：**只能是 `x.y.z` 格式**（SemVer），不支持 `v1.0.0` 之类的前缀
- `authorUrl`：填 GitHub 主页
- `isDesktopOnly`：本项目用 Web Crypto，桌面/移动端都能跑，故为 `false`

### versions.json 的作用

```json
{
  "1.0.0": "1.5.0"
}
```

格式：`"插件版本": "所需最低 Obsidian 版本"`。

Obsidian 在用户升级 App 后，用它判断该装哪个插件版本——比如 App 版本较老时不会推不兼容的插件更新。**每次发新版本都要在 `versions.json` 加一行**，否则自动更新可能出问题。

### Release 规则

- **tag 必须等于 manifest 的 `version`**，且无 `v` 前缀：本项目是 `1.0.0`
- **附件必须包含**：`main.js`、`manifest.json`、`styles.css`
- Obsidian 安装时直接从 GitHub release 下载这三个文件，所以 release 和仓库里的 manifest 都不可少

### 提交入口

1. 在 [community.obsidian.md](https://community.obsidian.md) 用 GitHub 账号登录
2. 进入 Plugins → New plugin，提交仓库地址
3. 等待自动验证 + 人工审核
4. **只需提交初始版本**；之后的新版本用户直接从 GitHub release 更新

审核若有问题，目录页会给出指引；修好后更新仓库并发布一个版本号递增的新 release。

---

## 二、本项目发布状态

| 项目 | 值 |
|---|---|
| 仓库 | https://github.com/njuptlzf/obsidian-sealed-note |
| 当前版本 | `2.1.0` |
| Release | https://github.com/njuptlzf/obsidian-sealed-note/releases/tag/2.1.0 |
| Release 附件 | `main.js`、`manifest.json`、`styles.css` |
| 社区提交 | ⏳ 待在 community.obsidian.md 门户提交（需 Obsidian 账号登录，人工步骤） |

发版前检查清单：

```bash
npm test              # 全部测试通过
npm run build         # 构建产物最新
npm run deploy        # 可选：部署到本地 vault 验证
git add -A && git commit -m "..."
git push
gh release create <version> main.js manifest.json styles.css --title "<version>" --notes "..."
```

然后同步更新 `manifest.json` 的 `version` 和 `versions.json` 的新映射（两者必须在同一个 commit 里）。

---

## 三、一个容易踩的坑

本机 git 全局配置的用户名是 `kazakazee`，与 GitHub 登录账号 `njuptlzf` 不一致，直接 push 会触发密码提示（终端无输入会失败）。解决：

```bash
gh auth setup-git
```

之后 git 会走 gh 的凭据助手，push 正常。

---

## 四、参考：daily-report 的做法

仓库 `njuptlzf/daily-report` 是一个已发布的同类插件，其做法是本项目的参照：

- 根目录含 `LICENSE`、`versions.json`、`.gitignore`（排除 `main.js`）
- release tag 用纯版本号：`1.4.0`、`1.3.1`…
- 每个 release 都带 `main.js`、`manifest.json`、`styles.css` 三个附件
- `versions.json` 每发一版加一行映射
