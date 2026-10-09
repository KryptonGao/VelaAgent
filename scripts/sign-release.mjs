#!/usr/bin/env node
// 发版时给更新包签名：为 dist 里当前版本的 dmg / zip 生成 SHA256SUMS.txt，
// 并用 Ed25519 私钥签出 SHA256SUMS.txt.sig。三者一起上传到 GitHub Release，应用内更新才会接受。
//
//   node scripts/sign-release.mjs [dist 目录]
//
// 私钥默认读取 ~/.vela-release/update-signing.key，可用 VELA_UPDATE_KEY 指定其他路径。
// 签名前会确认私钥对应的公钥已内置在应用里（update-public-keys.ts），否则用户收不到这次更新。
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const distDir = resolve(process.argv[2] ?? join(desktop, "dist"));
const keyPath = process.env.VELA_UPDATE_KEY?.trim() || join(homedir(), ".vela-release", "update-signing.key");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", chunk => hash.update(chunk)).on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

const version = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version;
const names = [`Vela-${version}-arm64.dmg`, `Vela-${version}-arm64.zip`];
for (const name of names) if (!existsSync(join(distDir, name))) fail(`缺少 ${join(distDir, name)}，请先打包（pnpm package:mac）。`);
if (!existsSync(keyPath)) fail(`找不到私钥：${keyPath}\n先运行 node scripts/update-keygen.mjs 生成。`);

const privateKey = createPrivateKey(readFileSync(keyPath));
const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const rawPublic = spki.subarray(spki.length - 32).toString("base64");
const trusted = [...readFileSync(join(desktop, "src/main/update-public-keys.ts"), "utf8").matchAll(/"([A-Za-z0-9+/]{43}=)"/g)].map(match => match[1]);
if (!trusted.includes(rawPublic)) fail(`这把私钥对应的公钥（${rawPublic}）没有内置在 update-public-keys.ts 中，已停止。`);

const lines = [];
for (const name of names) lines.push(`${await sha256(join(distDir, name))}  ${name}`);
const sums = Buffer.from(`${lines.join("\n")}\n`);
const signature = sign(null, sums, privateKey);
if (!verify(null, sums, createPublicKey(privateKey), signature)) fail("签名自检失败。");

writeFileSync(join(distDir, "SHA256SUMS.txt"), sums);
writeFileSync(join(distDir, "SHA256SUMS.txt.sig"), `${signature.toString("base64")}\n`);
console.log(`已生成并签名（版本 ${version}）：`);
console.log(`  ${join(distDir, "SHA256SUMS.txt")}`);
console.log(`  ${join(distDir, "SHA256SUMS.txt.sig")}`);
console.log("\n上传到 Release：");
console.log(`  gh release upload v${version} ${names.map(name => join(distDir, name)).join(" ")} ${join(distDir, "SHA256SUMS.txt")} ${join(distDir, "SHA256SUMS.txt.sig")} --clobber`);
