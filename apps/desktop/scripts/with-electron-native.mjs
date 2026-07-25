import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Expected a command to run with Electron native modules.");

const require = createRequire(import.meta.url);
const sqlitePackagePath = require.resolve("@effect/sql-sqlite-node/package.json");
const sqliteRequire = createRequire(sqlitePackagePath);
const betterSqlitePackagePath = sqliteRequire.resolve("better-sqlite3/package.json");
const betterSqliteVersion = JSON.parse(readFileSync(betterSqlitePackagePath, "utf8")).version;
const nativeModulePath = join(
  dirname(betterSqlitePackagePath),
  "build",
  "Release",
  "better_sqlite3.node",
);
const nativeBackupPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".electron-runtime",
  "native",
  `better-sqlite3-${betterSqliteVersion}-node-v${process.versions.modules}-${process.platform}-${process.arch}.node`,
);

mkdirSync(dirname(nativeBackupPath), { recursive: true });
if (!existsSync(nativeBackupPath)) {
  try {
    writeFileSync(nativeBackupPath, readFileSync(nativeModulePath), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
const nodeNativeModule = readFileSync(nativeBackupPath);
let restored = false;

function restoreNodeNativeModule() {
  if (restored) return;
  mkdirSync(dirname(nativeModulePath), { recursive: true });
  writeFileSync(nativeModulePath, nodeNativeModule);
  restored = true;
}

process.on("exit", restoreNodeNativeModule);

let activeChild;
let receivedSignal;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    receivedSignal ??= signal;
    activeChild?.kill(signal);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function finish({ code, signal }) {
  restoreNodeNativeModule();
  const exitSignal = receivedSignal ?? signal;
  if (exitSignal) {
    process.removeAllListeners(exitSignal);
    process.kill(process.pid, exitSignal);
    return;
  }
  process.exit(code ?? 1);
}

activeChild = spawn("electron-rebuild", ["-f", "-w", "better-sqlite3"], {
  shell: process.platform === "win32",
  stdio: "inherit",
});
const rebuildResult = await waitForExit(activeChild);
if (rebuildResult.code !== 0 || rebuildResult.signal) finish(rebuildResult);

activeChild = spawn(command, args, {
  shell: process.platform === "win32",
  stdio: "inherit",
});
finish(await waitForExit(activeChild));
