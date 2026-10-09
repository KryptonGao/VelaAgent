# Vela 开发与发版指引

给在本仓库工作的 AI 代理和开发者。文档正文用简体中文；命令、文件名和符号保持英文。

## 项目概览

- pnpm 工作区：`apps/desktop`（Electron 应用，主进程在 `src/main`，渲染层在 `src/renderer`）、`packages/{agent,shared,tools,workspace}`。
- 只发布 macOS Apple Silicon（arm64）版本，应用未公证，使用 ad-hoc 签名。
- 更多专题文档见 [docs/README.md](docs/README.md)。应用内更新的原理见 [docs/updates.md](docs/updates.md)。

## 常用命令

```bash
pnpm install
pnpm dev                 # 开发版，资料目录 ~/.vela-dev
pnpm test                # typecheck + 全部单元测试（PR 和发版前必须通过）
pnpm build               # 生产构建，冒烟测试依赖它
pnpm test:smoke          # 真实 Electron 冒烟测试（先 pnpm build）
pnpm test:ui             # 真实 Electron 的渲染层检查
pnpm --filter @vela/desktop test:updates     # 应用内更新相关测试
pnpm package:mac         # 打包 dmg 和 zip 到 apps/desktop/dist
pnpm sign:release        # 给更新包生成并签名 SHA256SUMS.txt
```

## 发版流程

应用内更新只依赖 GitHub Release：已安装的 Vela 读取 `releases/latest`，下载 zip，用内置公钥验证 `SHA256SUMS.txt.sig`，再校验哈希。**所以 Release 的资产名、签名和「最新」状态都是产品行为的一部分，不能随意改动。**

推送代码、创建或修改 Release 都是对外可见的操作：每一步先向用户确认，得到明确同意后再执行，一次同意不覆盖后续步骤。

### 1. 确定版本号并统一修改

版本号遵循 semver（`X.Y.Z`）。以下 5 处必须一致，缺一会让更新器拒绝安装（解压出的 `CFBundleShortVersionString` 必须等于 Release 版本）：

| 文件 | 字段 |
| --- | --- |
| `apps/desktop/package.json` | `version`、`shortVersion` |
| `apps/desktop/electron-builder.yml` | `buildVersion`、`mac.bundleShortVersion`、`mac.bundleVersion` |

不要改 `artifactName`（`Vela-${shortVersion}-${arch}.${ext}`），更新器按 `Vela-<版本>-arm64.zip` 查找。

### 2. 写发布说明

重写根目录 `RELEASE_NOTES.md`（英文），沿用现有结构：`# Vela X.Y.Z` 与一段概述，`## New`、`## Improved`、`## Upgrade`、`## Download`、`## Validation`。

- `## Download` 表格列出全部四个文件：`.dmg`、`.zip`、`SHA256SUMS.txt`、`SHA256SUMS.txt.sig`，并写明包版本。
- `## Validation` 只写实际执行过并通过的检查，不写没跑过的。
- 这份文件会原样作为 GitHub Release 的正文，更新器会把它显示给用户。

### 3. 验证

```bash
pnpm test                                    # 必须全绿
pnpm build && pnpm test:smoke                # 真实 Electron 冒烟测试
pnpm --filter @vela/desktop test:updates
```

### 4. 提交

在 `main` 上提交，信息格式沿用历史：`feat: <变更概述>, release X.Y.Z`（修复类用 `fix:`）。提交信息末尾带上会话给出的 Co-Authored-By 署名。推送前先问用户。

### 5. 打包并核对产物

```bash
pnpm package:mac
```

在 `apps/desktop/dist` 得到 `Vela-X.Y.Z-arm64.dmg` 和 `Vela-X.Y.Z-arm64.zip`。核对：

- `plutil -extract CFBundleShortVersionString raw -o - apps/desktop/dist/mac-arm64/Vela.app/Contents/Info.plist` 等于 `X.Y.Z`，`CFBundleIdentifier` 为 `com.vela.desktop`。
- zip 解开后顶层只有一个 `Vela.app`；dmg 能正常挂载。

### 6. 签名

```bash
pnpm sign:release
```

生成 `SHA256SUMS.txt` 和 `SHA256SUMS.txt.sig`，并打印 `gh release upload` 命令。脚本会拒绝使用未内置到应用里的私钥。

- 私钥在 `~/.vela-release/update-signing.key`（可用 `VELA_UPDATE_KEY` 指定）。**绝不提交、绝不打印、绝不上传。** 找不到私钥时停下来告诉用户，不要自己重新生成：新密钥对应的公钥没有随旧版本发布，旧版本将无法验证更新。
- 密钥轮换见 [docs/updates.md](docs/updates.md)。

### 7. 创建 Release

```bash
gh release create vX.Y.Z --target main --title "VelaHarness vX.Y.Z" --notes-file RELEASE_NOTES.md \
  apps/desktop/dist/Vela-X.Y.Z-arm64.dmg \
  apps/desktop/dist/Vela-X.Y.Z-arm64.zip \
  apps/desktop/dist/SHA256SUMS.txt \
  apps/desktop/dist/SHA256SUMS.txt.sig
```

要求：

- 标签必须是 `vX.Y.Z`，且是 semver 最高的正式版本。
- **不要**加 `--draft` 或 `--prerelease`，也不要把旧版本标为 latest：更新器读取的 `releases/latest` 会忽略草稿和预发布版本。
- 四个文件缺一不可。缺少签名文件的 Release 会让所有用户的更新失败并提示「缺少签名文件」。
- 创建后若要补传或替换文件，用 `gh release upload ... --clobber`，并重新核对下一步。

### 8. 发布后核对

```bash
gh release view vX.Y.Z --json assets,isDraft,isPrerelease --jq '{draft:.isDraft, pre:.isPrerelease, assets:[.assets[].name]}'
gh release list --limit 1        # 应显示 Latest
```

- 资产恰好是上述四个，`draft` 与 `pre` 均为 false。
- 从 Release 下载 `SHA256SUMS.txt` 和 `.sig`，用应用内的 `verifySignature` 与 `updatePublicKeys` 验证通过（参考 `apps/desktop/test/update-verify.test.ts`）。
- 条件允许时，用上一个已安装的版本实际走一遍更新：设置 → 关于与更新 → 检查更新，确认下载、提示重启并升级成功；失败时看 `~/.vela/updates/installer.log`。

## 约定

- 不要提交 `~/.vela-release` 下的任何文件，也不要把私钥内容写进代码、文档、日志或对话。
- 修改更新相关逻辑（`apps/desktop/src/main/update-*.ts`）后跑 `pnpm --filter @vela/desktop test:updates` 和 `test:updates:ui`。
- 新增界面文案要同时提供 zh-CN、en，并在 `packages/shared/src/i18n-messages/` 补齐 zh-TW、ja、ko 译文，缺失的会退回英文。
- 版本 1.0.5 及更早的安装没有更新器，第一个带更新器的版本需要用户手动安装一次。
