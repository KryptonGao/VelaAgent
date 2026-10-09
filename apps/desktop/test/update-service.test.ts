import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type { UpdateState } from "@vela/shared";
import { unzipSync, zipSync } from "fflate";
import type { InstallPlan } from "../src/main/update-installer.ts";
import { UpdateService, type UpdateServiceOptions } from "../src/main/update-service.ts";

const owner = "KryptonGao";
const repo = "VelaHarness";
const download = `https://github.com/${owner}/${repo}/releases/download`;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, raw: spki.subarray(spki.length - 32).toString("base64") };
}
const trusted = keys();

/** 用 JSON 冒充 Info.plist 的最小 .app 压缩包。 */
function appZip(id: string, version: string): Buffer {
  const info = new TextEncoder().encode(JSON.stringify({ id, version }));
  return Buffer.from(zipSync({ "Vela.app/Contents/Info.plist": info, "Vela.app/Contents/MacOS/Vela": new TextEncoder().encode("binary") }));
}

interface FakeRelease {
  tag: string;
  zip: Buffer;
  zipName?: string;
  /** 签名所用私钥；默认是受信任的那把。 */
  signer?: KeyObject;
  sums?: string;
  omit?: string[];
  assetHost?: string;
  body?: string;
}

function publish(release: FakeRelease) {
  const version = release.tag.replace(/^v/, "");
  const zipName = release.zipName ?? `Vela-${version}-arm64.zip`;
  const sums = release.sums ?? `${createHash("sha256").update(release.zip).digest("hex")}  ${zipName}\n`;
  const signature = `${sign(null, Buffer.from(sums), release.signer ?? trusted.privateKey).toString("base64")}\n`;
  const host = release.assetHost ?? `${download}/${release.tag}`;
  const files: Record<string, Buffer | string> = { [zipName]: release.zip, "SHA256SUMS.txt": sums, "SHA256SUMS.txt.sig": signature };
  const assets = Object.entries(files)
    .filter(([name]) => !release.omit?.includes(name))
    .map(([name, content]) => ({ name, size: Buffer.byteLength(content), browser_download_url: `${host}/${name}` }));
  const payload = { tag_name: release.tag, body: release.body ?? "Notes", html_url: `https://github.com/${owner}/${repo}/releases/tag/${release.tag}`, published_at: "2026-10-10T00:00:00Z", assets };
  return { payload, files, urlFor: (name: string) => `${host}/${name}` };
}

let work: string;
let requests: string[];
let latest: ReturnType<typeof publish> | { status: number } | Error;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "vela-update-"));
  requests = [];
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (latest instanceof Error) throw latest;
    if ("status" in latest) return new Response("nope", { status: latest.status });
    if (url.endsWith("/releases/latest")) return Response.json(latest.payload);
    const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const content = latest.files[name];
    return content === undefined ? new Response("missing", { status: 404 }) : new Response(content);
  }) as typeof fetch;
}

interface Harness {
  service: UpdateService;
  states: UpdateState[];
  plans: InstallPlan[];
  quits: number;
}

function harness(overrides: Partial<UpdateServiceOptions> & { target?: string | null } = {}): Harness {
  const state: Harness = { states: [], plans: [], quits: 0, service: undefined as never };
  const { target = "/Applications/Vela.app", ...rest } = overrides;
  state.service = new UpdateService({
    currentVersion: "1.0.5",
    owner,
    repo,
    bundleId: "com.vela.desktop",
    arch: "arm64",
    publicKeys: [trusted.raw],
    stagingDir: join(work, "updates", "staging"),
    settingsFile: join(work, "updates.json"),
    logFile: join(work, "updates", "installer.log"),
    fetch: fakeFetch(),
    installTarget: async () => target,
    extract: async (zip, destination) => {
      for (const [path, content] of Object.entries(unzipSync(new Uint8Array(await readFile(zip))))) {
        await mkdir(dirname(join(destination, path)), { recursive: true });
        await writeFile(join(destination, path), content);
      }
    },
    readBundleInfo: async app => JSON.parse(await readFile(join(app, "Contents", "Info.plist"), "utf8")),
    spawnInstaller: plan => { state.plans.push(plan); },
    quit: () => { state.quits++; },
    ...rest,
  });
  state.service.subscribe(next => state.states.push(next));
  return state;
}

async function settled(h: Harness, status: UpdateState["status"], timeoutMs = 3000): Promise<UpdateState> {
  const deadline = Date.now() + timeoutMs;
  while (h.service.getState().status !== status) {
    if (Date.now() > deadline) assert.fail(`expected ${status}, still ${h.service.getState().status}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return h.service.getState();
}

test("reports up to date when the latest release is not newer", async () => {
  latest = publish({ tag: "v1.0.5", zip: appZip("com.vela.desktop", "1.0.5") });
  const h = harness();
  const state = await h.service.check();
  assert.equal(state.status, "up-to-date");
  assert.equal(state.version, undefined);
  assert.equal(requests.length, 1, "nothing but the release lookup");
});

test("downloads, verifies and stages a signed update, then installs on quit", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6"), body: "## What's new" });
  const h = harness();
  const found = await h.service.check();
  assert.equal(found.version, "1.0.6");
  assert.equal(found.notes, "## What's new");
  const ready = await settled(h, "ready");
  assert.equal(ready.installable, true);
  assert.deepEqual(h.states.map(state => state.status).filter((status, index, all) => status !== all[index - 1]), ["checking", "available", "downloading", "ready"]);
  assert.ok(h.states.some(state => state.status === "downloading" && state.progress), "progress is reported");

  h.service.onWillQuit();
  h.service.onWillQuit();
  assert.equal(h.plans.length, 1, "the installer is started once");
  const [plan] = h.plans;
  assert.equal(plan.target, "/Applications/Vela.app");
  assert.equal(plan.relaunch, false, "a plain quit installs without reopening");
  assert.equal(readFileSync(join(plan.stagedApp, "Contents", "MacOS", "Vela"), "utf8"), "binary");
  assert.equal(existsSync(join(work, "updates", "staging", "Vela-1.0.6-arm64.zip")), false, "the zip is removed once extracted");
});

test("restart quits the app and asks the installer to reopen it", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6") });
  const h = harness();
  h.service.restart();
  assert.equal(h.quits, 0, "nothing to install yet");
  await h.service.check();
  await settled(h, "ready");
  h.service.restart();
  assert.equal(h.quits, 1);
  h.service.onWillQuit();
  assert.equal(h.plans[0].relaunch, true);
});

test("rejects a checksum file signed with an untrusted key before downloading the archive", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6"), signer: keys().privateKey });
  const h = harness();
  await h.service.check();
  const state = await settled(h, "error");
  assert.equal(state.error?.code, "signature");
  assert.equal(requests.some(url => url.endsWith(".zip")), false, "the archive is never fetched");
  h.service.onWillQuit();
  assert.equal(h.plans.length, 0);
});

test("rejects an archive that does not match the signed checksum", async () => {
  const signed = appZip("com.vela.desktop", "1.0.6");
  const evil = appZip("com.vela.desktop", "1.0.6-evil");
  latest = publish({ tag: "v1.0.6", zip: signed });
  latest.files["Vela-1.0.6-arm64.zip"] = evil;
  const h = harness();
  await h.service.check();
  const state = await settled(h, "error");
  assert.equal(state.error?.code, "hash");
  assert.equal(existsSync(join(work, "updates", "staging")), false, "staging is cleaned up");
});

test("requires the signed checksums to list the archive for this version", async () => {
  const zip = appZip("com.vela.desktop", "1.0.6");
  latest = publish({ tag: "v1.0.6", zip, sums: `${createHash("sha256").update(zip).digest("hex")}  Vela-1.0.5-arm64.zip\n` });
  const h = harness();
  await h.service.check();
  assert.equal((await settled(h, "error")).error?.code, "signature");
});

test("refuses releases without a signature or from foreign download hosts", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6"), omit: ["SHA256SUMS.txt.sig"] });
  let h = harness();
  await h.service.check();
  assert.equal((await settled(h, "error")).error?.code, "unsigned");

  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6"), assetHost: "https://evil.example/releases" });
  h = harness();
  await h.service.check();
  assert.equal((await settled(h, "error")).error?.code, "unsigned");
  assert.equal(requests.some(url => url.startsWith("https://evil.example")), false);
});

test("rejects a bundle whose identifier or version differs from the release", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.example.other", "1.0.6") });
  let h = harness();
  await h.service.check();
  assert.equal((await settled(h, "error")).error?.code, "mismatch");

  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.4") });
  h = harness();
  await h.service.check();
  assert.equal((await settled(h, "error")).error?.code, "mismatch");
});

test("waits for confirmation when automatic updates are off and remembers the choice", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6") });
  let h = harness();
  assert.equal(h.service.setAutoUpdate(false).autoUpdate, false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(JSON.parse(readFileSync(join(work, "updates.json"), "utf8")).autoUpdate, false);

  h = harness();
  assert.equal(h.service.getState().autoUpdate, false, "reloaded from disk");
  const found = await h.service.check();
  assert.equal(found.status, "available");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.service.getState().status, "available", "no download without consent");
  assert.equal(requests.some(url => url.endsWith(".zip")), false);

  const after = await h.service.download();
  assert.equal(after.status, "ready");
});

test("turning automatic updates back on downloads a pending update", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6") });
  const h = harness();
  h.service.setAutoUpdate(false);
  await h.service.check();
  assert.equal(h.service.getState().status, "available");
  h.service.setAutoUpdate(true);
  await settled(h, "ready");
});

test("only points to the release page when this installation cannot replace itself", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6") });
  const h = harness({ target: null });
  const state = await h.service.check();
  assert.equal(state.status, "available");
  assert.equal(state.installable, false);
  assert.equal(state.releaseUrl, `https://github.com/${owner}/${repo}/releases/tag/v1.0.6`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests.some(url => url.endsWith(".zip")), false);
  assert.equal((await h.service.download()).status, "available");
});

test("maps GitHub failures to error codes and recovers on the next check", async () => {
  const h = harness();
  latest = { status: 404 };
  assert.equal((await h.service.check()).error?.code, "no-release");
  latest = { status: 403 };
  assert.equal((await h.service.check()).error?.code, "rate-limited");
  latest = new TypeError("fetch failed");
  const failed = await h.service.check();
  assert.equal(failed.error?.code, "network");
  latest = publish({ tag: "v1.0.5", zip: appZip("com.vela.desktop", "1.0.5") });
  const recovered = await h.service.check();
  assert.equal(recovered.status, "up-to-date");
  assert.equal(recovered.error, undefined);
});

test("ignores tags that are not versions", async () => {
  latest = publish({ tag: "nightly", zip: appZip("com.vela.desktop", "1.0.6") });
  const state = await harness().service.check();
  assert.equal(state.error?.code, "no-release");
});

test("keeps a ready update untouched by later checks", async () => {
  latest = publish({ tag: "v1.0.6", zip: appZip("com.vela.desktop", "1.0.6") });
  const h = harness();
  await h.service.check();
  await settled(h, "ready");
  const before = requests.length;
  assert.equal((await h.service.check()).status, "ready");
  assert.equal(requests.length, before);
});
