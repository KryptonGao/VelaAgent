# 应用内更新

Vela 只依赖 GitHub Release 实现自动更新：安装版在后台检查最新 Release，自动下载并校验新版本，下载完成后提示重启；不引入额外的更新服务器，也不需要 Apple 开发者账号。

实现位于 `apps/desktop/src/main/` 的 `update-service.ts`（检查、下载、校验、暂存）、`update-installer.ts`（退出后替换应用）、`update-verify.ts`（版本比较与 Ed25519 验签）和 `update-host.ts`（IPC、菜单入口）。界面在设置的「关于与更新」页（`UpdatesPage`）和重启提示（`UpdateNotice`）。

## 使用者看到的行为

- **自动检查**：安装版启动约 20 秒后检查一次，之后每 4 小时一次。开发版（`pnpm dev`）不会在后台联网，只提供手动检查。
- **自动下载**：发现新版本且这份安装可以被替换时，自动下载并校验，设置页显示进度。
- **提示重启**：下载完成后窗口右下角出现「立即重启」和「稍后」。选「稍后」后可以继续工作，退出 Vela 时更新会自动安装，下次打开就是新版本。
- **手动检查**：应用菜单和帮助菜单的「检查更新…」，或设置 → 关于与更新。
- **关闭自动更新**：设置页的开关保存在 `<资料目录>/updates.json`。关闭后只在手动检查时联网，发现新版本后需要点「下载更新」。
- **不能自动替换时**：在安装镜像（`/Volumes`）里直接运行、被 App Translocation 隔离，或应用所在目录当前用户没有写权限时，只提示新版本并给出「前往发布页」。

## 信任链

更新包只有同时满足以下条件才会被安装：

1. Release 的 `tag_name` 是 semver，且高于当前版本（预发布版本低于同号正式版）。
2. 下载地址属于 `https://github.com/KryptonGao/VelaHarness/releases/download/`，其他来源的资产被忽略。
3. `SHA256SUMS.txt.sig` 能被内置公钥（`update-public-keys.ts`）验证为 `SHA256SUMS.txt` 的 Ed25519 签名。**先验签，再下载大文件。**
4. 已签名的 `SHA256SUMS.txt` 里列有 `Vela-<版本>-arm64.zip`，下载内容的 SHA-256 与之一致。版本号因此被签名绑定，旧版本的签名文件不能冒充新版本。
5. 解压出的 `.app` 恰好一个，`CFBundleIdentifier` 为 `com.vela.desktop`，`CFBundleShortVersionString` 等于 Release 版本。

即使有人获得了仓库的写权限并替换了 Release 里的文件，没有私钥也签不出有效签名，应用会拒绝安装。

## 替换过程

退出时（`will-quit`）启动一个脱离主进程的 `/bin/sh` 脚本（`installScript`）：

1. 等待 Vela 进程退出（最多 60 秒）。
2. 用 `ditto` 把暂存的新版复制到 `Vela.app.vela-new`。复制期间被中断（注销、关机）时旧版仍然完整。
3. 两次 `mv` 换位：旧版移到 `.vela-old`，新版移到原位；任何一步失败都会还原旧版。
4. 清理 `.vela-old` 和暂存目录；若用户点了「立即重启」，再 `open` 新版。

脚本输出写入 `<资料目录>/updates/installer.log`，更新没有生效时先看这里。暂存目录是 `<资料目录>/updates/staging`，每次下载前清空。

## 发版步骤

私钥由维护者保管，不在仓库里。

**首次（已完成一次）**：

```bash
pnpm update:keygen
```

私钥写入 `~/.vela-release/update-signing.key`（权限 600），公钥打印出来填进 `update-public-keys.ts`。**请把私钥备份到密码管理器或加密介质。** 私钥丢失后，已安装的旧版本无法验证新版本，用户只能手动重新安装；私钥泄露则别人可以签出恶意更新。可用 `node scripts/update-keygen.mjs --show` 查看现有私钥对应的公钥。

**每次发版**：

```bash
pnpm package:mac                 # 生成 dmg 和 zip
pnpm sign:release               # 生成并签名 SHA256SUMS.txt
```

`sign-release.mjs` 会为 `apps/desktop/dist` 里当前版本的 dmg 和 zip 生成 `SHA256SUMS.txt`，签出 `SHA256SUMS.txt.sig`，并打印可直接执行的 `gh release upload` 命令。签名前会确认私钥对应的公钥已内置在应用里，否则停止。Release 必须同时包含这四个文件，缺少签名文件的版本会被应用拒绝（提示「缺少签名文件」）。

**轮换密钥**：先发布一个 `updatePublicKeys` 同时包含新旧公钥的版本，等用户升级后，再改用新私钥签名。

## 首次升级与限制

- **已安装的 1.0.5 及更早版本没有更新器**，需要手动安装一次带更新器的版本；之后的更新才是自动的。
- 应用目前使用 ad-hoc 签名且未公证。更新由 Vela 自己下载，不带隔离属性，不会触发 Gatekeeper；但每个版本的代码签名身份（cdhash）都不同，macOS 的隐私授权或钥匙串访问提示在升级后可能需要重新确认，这和手动覆盖安装一致。
- 只发布 Apple Silicon（arm64）版本，更新包名为 `Vela-<版本>-arm64.zip`。
- 未登录的 GitHub API 每小时限 60 次请求，正常使用远低于此；超限时设置页提示稍后再试。
- 若将来加入 Developer ID 签名与公证，可改用 `electron-updater` 并支持增量更新；设置页和提示界面不需要改。

## 验证

```bash
pnpm --filter @vela/desktop test:updates      # 验签、版本比较、更新流程、安装脚本、解压
pnpm --filter @vela/desktop test:updates:ui   # 设置页与重启提示的渲染层行为
```

- `update-service.test.ts` 用真实的 Ed25519 密钥和伪造的 GitHub 响应覆盖：正常更新、错误签名、被篡改的压缩包、缺少签名、外部下载地址、标识或版本不符、关闭自动更新、不可替换的安装以及各类网络错误。
- `update-installer.test.ts` 在 macOS 上用真实 shell 与 `ditto` 验证替换、失败还原、残留清理、等待进程退出和带空格引号的路径。
- `settings-electron-smoke.mjs` 在真实 Electron 里确认设置页能通过 IPC 取得更新状态。
