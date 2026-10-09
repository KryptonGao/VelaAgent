import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BundleInfo } from "./update-service";

const run = promisify(execFile);

/** ditto 保留符号链接、权限和扩展属性，.app 里的 Frameworks 依赖这些。 */
export async function extractZip(zip: string, destination: string): Promise<void> {
  await run("/usr/bin/ditto", ["-x", "-k", zip, destination]);
}

export async function readBundleInfo(bundle: string): Promise<BundleInfo> {
  const plist = join(bundle, "Contents", "Info.plist");
  const read = async (key: string) => (await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist])).stdout.trim();
  return { id: await read("CFBundleIdentifier"), version: await read("CFBundleShortVersionString") };
}
