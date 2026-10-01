import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * node-pty 的 prebuilt spawn-helper 在 pnpm 解包后可能丢掉可执行位,
 * POSIX 上会导致 pty.fork 直接失败(posix_spawnp failed)。
 * 安装后统一补上执行位,让 pnpm install 后开箱可用。
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const prebuildRoots = [
  join(root, "node_modules", "node-pty", "prebuilds"),
  join(root, "apps", "desktop", "node_modules", "node-pty", "prebuilds"),
];

let fixed = 0;
for (const prebuildRoot of prebuildRoots) {
  if (!existsSync(prebuildRoot)) continue;
  for (const target of readdirSync(prebuildRoot)) {
    const helper = join(prebuildRoot, target, "spawn-helper");
    if (!existsSync(helper)) continue;
    chmodSync(helper, 0o755);
    fixed += 1;
  }
}

if (fixed > 0) console.log(`[vela] 已修正 node-pty spawn-helper 执行权限(${fixed} 个)`);
