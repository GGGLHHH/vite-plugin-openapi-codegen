import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { stringify as stringifyYaml } from "yaml";

const root = process.cwd();
const specPath = resolve(root, "example/openapi.json");
const specSource = stringifyYaml(JSON.parse(readFileSync(specPath, "utf-8")));
const mockPort = 8080;
const vpCommand = process.platform === "win32" ? "vp.cmd" : "vp";

const children = new Map();
let shuttingDown = false;

function startExample(name, args) {
  const child = spawn(vpCommand, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  children.set(name, child);

  child.on("exit", (code, signal) => {
    children.delete(name);

    if (shuttingDown) {
      return;
    }

    const reason = signal ?? code ?? 1;
    console.error(`[examples] ${name} exited unexpectedly (${reason}).`);
    shutdown(code ?? 1);
  });

  child.on("error", (error) => {
    if (shuttingDown) {
      return;
    }

    console.error(`[examples] Failed to start ${name}.`, error);
    shutdown(1);
  });
}

function stopChildren() {
  for (const child of children.values()) {
    child.kill("SIGTERM");
  }
}

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  stopChildren();

  server.close(() => {
    process.exit(exitCode);
  });

  setTimeout(() => {
    process.exit(exitCode);
  }, 1000).unref();
}

const server = createServer((request, response) => {
  if (request.url?.split("?", 1)[0] !== "/openapi.yaml") {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/yaml; charset=utf-8",
  });
  response.end(specSource);
});

server.on("error", (error) => {
  console.error("[examples] Mock OpenAPI server failed to start.", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  shutdown(0);
});

process.on("SIGTERM", () => {
  shutdown(0);
});

server.listen(mockPort, () => {
  console.log(`[examples] Mock OpenAPI server ready at http://localhost:${mockPort}/openapi.yaml`);
  startExample("local example", [
    "dev",
    "example/local",
    "--config",
    "./example/local/vite.config.ts",
    "--port",
    "5173",
    "--strictPort",
  ]);
  startExample("online example", [
    "dev",
    "example/online",
    "--config",
    "./example/online/vite.config.ts",
    "--port",
    "5174",
    "--strictPort",
  ]);
});
