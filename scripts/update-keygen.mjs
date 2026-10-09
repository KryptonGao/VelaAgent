#!/usr/bin/env node
// 生成应用内更新用的 Ed25519 签名密钥对（只需做一次）。
//
// 私钥写到 ~/.vela-release/update-signing.key（权限 600），不在仓库里，也永远不要提交或外传。
// 公钥只打印到终端，把它放进 apps/desktop/src/main/update-public-keys.ts 随应用发布。
// 私钥丢了，已安装的旧版本就验证不了新版本，只能让用户手动重新安装；私钥泄露，别人就能签出
// 看似合法的恶意更新。请把私钥文件备份到密码管理器或加密介质。
//
//   node scripts/update-keygen.mjs            生成密钥（已存在则拒绝覆盖）
//   node scripts/update-keygen.mjs --show     只打印现有私钥对应的公钥
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const defaultKeyPath = join(homedir(), ".vela-release", "update-signing.key");

/** 32 字节原始公钥（base64），与应用内置格式一致。 */
export function rawPublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("base64");
}

function main() {
  const keyPath = process.env.VELA_UPDATE_KEY?.trim() || defaultKeyPath;
  if (process.argv.includes("--show")) {
    if (!existsSync(keyPath)) {
      console.error(`找不到私钥：${keyPath}`);
      process.exit(1);
    }
    console.log(rawPublicKey(createPrivateKey(readFileSync(keyPath))));
    return;
  }
  if (existsSync(keyPath)) {
    console.error(`私钥已存在：${keyPath}\n为避免覆盖，已停止。要查看公钥请加 --show。`);
    process.exit(1);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  chmodSync(keyPath, 0o600);
  console.log(`私钥已写入：${keyPath}（权限 600）`);
  console.log("请立即备份这个文件，并且不要提交到 git。\n");
  console.log("公钥（放进 apps/desktop/src/main/update-public-keys.ts）：");
  console.log(rawPublicKey(privateKey));
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
