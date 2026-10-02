#!/usr/bin/env node
/**
 * 测试中心入口:
 *   node test-center/server.mjs                          启动看板服务(默认 127.0.0.1:5190)
 *   node test-center/server.mjs --list                   列出发现的任务(JSON)
 *   node test-center/server.mjs --run all|failed|<ids>   无头运行,stdout 输出 NDJSON 进度
 *   node test-center/server.mjs --port 5200              指定端口
 */
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { browserFixtures } from "./fixtures.mjs";
import { desktopDir, discoverTasks, repoRoot } from "./discovery.mjs";
import { RunBusyError, RunManager, readLastRun, resolveElectronPath } from "./runner.mjs";

const defaultPort = 5190;
const portAttempts = 20;
const ssePingMs = 20_000;

function parseArgs(argv) {
  const options = { list: false, run: null, port: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") options.list = true;
    else if (arg === "--run") options.run = argv[++index] ?? "";
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.run && !arg.startsWith("--")) options.run = arg;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Vela 测试中心

用法:
  node test-center/server.mjs                    启动看板(浏览器打开打印的地址)
  node test-center/server.mjs --list             列出全部任务
  node test-center/server.mjs --run all          无头运行全部任务
  node test-center/server.mjs --run failed       只重跑上次失败的任务
  node test-center/server.mjs --run <id,id>      运行指定任务
  node test-center/server.mjs --port 5200        指定端口

环境变量:
  VELA_TEST_CENTER_PORT   固定端口(默认 5190,占用时自动向后尝试)
  VELA_TEST_CONCURRENCY   node --test 并发数
  VELA_TEST_TIMEOUT_MS    Node 批次超时(默认 10 分钟)
  VELA_TEST_CENTER_SHOW   设为 1 时显示浏览器检查窗口`);
}

async function electronVersion() {
  try {
    const packageJson = JSON.parse(await readFile(join(desktopDir, "package.json"), "utf8"));
    return packageJson.devDependencies?.electron ?? null;
  } catch {
    return null;
  }
}

function resolveSelection(selection, tasks, lastRun) {
  const allIds = tasks.map((task) => task.id);
  if (selection === "all") return allIds;
  if (selection === "failed") {
    const failed = lastRun ? Object.entries(lastRun.results ?? {}).filter(([, result]) => result.status === "failed").map(([id]) => id) : [];
    if (failed.length === 0) throw new Error("上次运行没有失败的任务");
    return failed.filter((id) => allIds.includes(id));
  }
  const requested = selection.split(",").map((id) => id.trim()).filter(Boolean);
  const known = new Set(allIds);
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`未知任务: ${unknown.join(", ")}`);
  if (requested.length === 0) throw new Error("没有指定任务");
  return requested;
}

async function listCommand() {
  const { tasks, groups, features } = discoverTasks();
  const payload = {
    root: repoRoot,
    counts: {
      total: tasks.length,
      node: tasks.filter((task) => task.kind === "node").length,
      ui: tasks.filter((task) => task.kind === "ui").length,
    },
    groups: groups.map((group) => ({ id: group.id, title: group.title, count: group.taskIds.length })),
    features: features.map((feature) => ({ id: feature.id, title: feature.title, count: feature.taskIds.length })),
    tasks,
  };
  console.log(JSON.stringify(payload, null, 2));
}

async function runCommand(selection) {
  const discovery = discoverTasks();
  const { tasks } = discovery;
  const lastRunPath = join(desktopDir, "test-center/.runs/last-run.json");
  const lastRun = await readLastRun(lastRunPath);
  const taskIds = resolveSelection(selection, tasks, lastRun);
  const selectedTasks = taskIds.map((id) => tasks.find((task) => task.id === id)).filter(Boolean);
  const needsServer = selectedTasks.some((task) => task.kind === "ui");

  const manager = new RunManager({ tasks, lastRunPath });
  let server = null;
  if (needsServer) {
    server = await startServer({ manager, discovery, quiet: true });
    manager.port = server.port;
  }

  manager.on("message", (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });

  const finished = new Promise((resolve) => {
    manager.on("message", (message) => {
      if (message.type === "run:end") resolve(message.run);
    });
  });
  const onSignal = () => manager.stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const runId = manager.start(taskIds);
  process.stderr.write(`开始运行 ${runId}: ${taskIds.length} 个任务\n`);
  const run = await finished;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  if (server) {
    await server.close();
  }
  const summary = run?.summary ?? { total: 0, passed: 0, failed: 0, cancelled: 0 };
  process.stderr.write(
    `运行结束: ${summary.passed} 通过, ${summary.failed} 失败, ${summary.cancelled} 取消, ${Math.round(summary.durationMs / 1000)}s\n`,
  );
  process.exitCode = run?.status === "finished" && summary.failed === 0 ? 0 : 1;
}

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

async function readJsonBody(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveHtml(vite, filePath, urlPath, response) {
  const html = await vite.transformIndexHtml(urlPath, await readFile(filePath, "utf8"));
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

async function startServer({ manager, discovery, quiet = false, port: requestedPort = null }) {
  const { tasks, groups, features } = discovery;
  const httpServer = createHttpServer();
  const { createServer: createViteServer } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const vite = await createViteServer({
    root: desktopDir,
    configFile: false,
    appType: "custom",
    plugins: [react()],
    resolve: { alias: { "@vela/shared": join(repoRoot, "packages/shared/src/index.ts") } },
    optimizeDeps: {
      entries: ["test-center/dashboard.html", ...browserFixtures.map((fixture) => fixture.page.split("?")[0])],
    },
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
      watch: { ignored: ["**/.runs/**"] },
    },
  });

  const clients = new Set();
  // 所有事件都用默认 message 事件名,类型放在 JSON 的 type 字段里,客户端只挂一个 onmessage。
  const writeToClient = (client, payload) => {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      return;
    }
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  };
  const broadcast = (message) => {
    const payload = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) writeToClient(client, payload);
  };
  manager.on("message", broadcast);

  const dashboardPath = join(desktopDir, "test-center/dashboard.html");
  const environment = { node: process.version, electron: await electronVersion(), platform: process.platform };

  const statePayload = () => ({
    root: repoRoot,
    env: environment,
    groups,
    features,
    tasks,
    run: manager.snapshot(),
    running: manager.running,
  });

  httpServer.on("request", (request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort ?? defaultPort}`);
        if (url.pathname === "/api/state") {
          jsonResponse(response, 200, statePayload());
          return;
        }
        if (url.pathname === "/api/run" && request.method === "POST") {
          let body;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            jsonResponse(response, 400, { error: `请求体无效: ${String(error?.message ?? error)}` });
            return;
          }
          const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((id) => typeof id === "string") : [];
          try {
            const runId = manager.start(taskIds);
            jsonResponse(response, 202, { runId });
          } catch (error) {
            if (error instanceof RunBusyError) jsonResponse(response, 409, { error: error.message });
            else jsonResponse(response, 400, { error: String(error?.message ?? error) });
          }
          return;
        }
        if (url.pathname === "/api/stop" && request.method === "POST") {
          const stopped = manager.stop();
          jsonResponse(response, stopped ? 202 : 409, { stopped });
          return;
        }
        if (url.pathname === "/api/events") {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });
          response.write("retry: 1000\n\n");
          clients.add(response);
          writeToClient(response, `data: ${JSON.stringify({ type: "snapshot", ...statePayload() })}\n\n`);
          response.on("error", () => clients.delete(response));
          request.on("close", () => clients.delete(response));
          return;
        }
        if (url.pathname === "/" || url.pathname === "/index.html") {
          await serveHtml(vite, dashboardPath, url.pathname, response);
          return;
        }
        // middleware 模式下 Vite 不自己服务 HTML,预览页和看板都由这里转译。
        if (url.pathname.endsWith(".html")) {
          const filePath = resolve(desktopDir, `.${url.pathname}`);
          if (filePath !== desktopDir && !filePath.startsWith(desktopDir + sep)) {
            response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            response.end("Not found");
            return;
          }
          await serveHtml(vite, filePath, url.pathname, response);
          return;
        }
        vite.middlewares(request, response, (error) => {
          if (error) {
            vite.ssrFixStacktrace(error);
            response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            response.end(String(error?.stack ?? error));
            return;
          }
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("Not found");
        });
      } catch (error) {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(String(error?.stack ?? error));
      }
    })();
  });

  const pingTimer = setInterval(() => {
    for (const client of clients) writeToClient(client, ": ping\n\n");
  }, ssePingMs);
  pingTimer.unref?.();

  const port = await listen(httpServer, requestedPort);
  httpServer.requestTimeout = 0;

  if (!quiet) {
    const url = `http://127.0.0.1:${port}/`;
    console.log("Vela 测试中心");
    console.log(`  看板:     ${url}`);
    console.log(`  任务数:   ${tasks.length}(Node ${tasks.filter((task) => task.kind === "node").length} + 浏览器 ${tasks.filter((task) => task.kind === "ui").length})`);
    console.log("  Ctrl+C 退出");
  }

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      clearInterval(pingTimer);
      for (const client of clients) client.end();
      clients.clear();
      manager.off("message", broadcast);
      await vite.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function listen(server, requestedPort) {
  const fixed = requestedPort ?? (Number(process.env.VELA_TEST_CENTER_PORT) || null);
  const attempts = fixed ? 1 : portAttempts;
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = (fixed ?? defaultPort) + offset;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      if (fixed) throw new Error(`端口 ${port} 已被占用(VELA_TEST_CENTER_PORT)`);
    }
  }
  throw new Error(`从 ${fixed ?? defaultPort} 开始连续 ${attempts} 个端口都被占用`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.list) {
    await listCommand();
    return;
  }
  if (options.run) {
    await runCommand(options.run);
    return;
  }

  const discovery = discoverTasks();
  const lastRunPath = join(desktopDir, "test-center/.runs/last-run.json");
  const manager = new RunManager({ tasks: discovery.tasks, lastRunPath });
  manager.run = await readLastRun(lastRunPath);
  const server = await startServer({ manager, discovery, port: options.port });
  manager.port = server.port;

  const shutdown = async () => {
    manager.dispose();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
