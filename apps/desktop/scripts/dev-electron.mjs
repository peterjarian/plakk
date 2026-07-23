import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appName = "Plakk (Dev)";
const bundleId = "app.plakk.dev";
const deeplinkProtocol = "plakk-dev";
const linuxDesktopEntryName = "plakk-dev.desktop";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const runtimeDir = join(desktopDir, ".electron-runtime");
const metadataPath = join(runtimeDir, "metadata.json");
const iconPath = join(desktopDir, "resources", "icon.icns");
const linuxIconPath = join(desktopDir, "resources", "icon.png");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) return;
  throw new Error(
    [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim() ||
      `${command} failed.`,
  );
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  throw new Error(
    [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim() ||
      `${command} failed.`,
  );
}

function setPlistString(plistPath, key, value) {
  const args = [key, "-string", value, plistPath];
  const replace = spawnSync("plutil", ["-replace", ...args], { encoding: "utf8" });
  if (replace.status === 0) return;
  run("plutil", ["-insert", ...args]);
}

function patchPlist(plistPath, name, id) {
  setPlistString(plistPath, "CFBundleDisplayName", name);
  setPlistString(plistPath, "CFBundleName", name);
  setPlistString(plistPath, "CFBundleIdentifier", id);
}

function setPlistUrlScheme(plistPath, scheme) {
  const json = JSON.stringify([{ CFBundleURLName: bundleId, CFBundleURLSchemes: [scheme] }]);
  const replace = spawnSync("plutil", ["-replace", "CFBundleURLTypes", "-json", json, plistPath], {
    encoding: "utf8",
  });
  if (replace.status === 0) return;
  run("plutil", ["-insert", "CFBundleURLTypes", "-json", json, plistPath]);
}

function resolveElectronExecPath() {
  if (process.platform !== "darwin") return undefined;

  const require = createRequire(import.meta.url);
  const electronExecPath = require("electron");
  const sourceBundle = resolve(dirname(electronExecPath), "../..");
  const targetBundle = join(runtimeDir, `${appName}.app`);
  const targetExecPath = join(targetBundle, "Contents", "MacOS", "Electron");
  const metadata = JSON.stringify({
    sourceBundle,
    sourceMtimeMs: statSync(sourceBundle).mtimeMs,
    iconMtimeMs: existsSync(iconPath) ? statSync(iconPath).mtimeMs : null,
    appName,
    bundleId,
    deeplinkProtocol,
  });

  mkdirSync(runtimeDir, { recursive: true });
  if (
    !existsSync(targetExecPath) ||
    !existsSync(metadataPath) ||
    readFileSync(metadataPath, "utf8") !== metadata
  ) {
    rmSync(targetBundle, { recursive: true, force: true });
    cpSync(sourceBundle, targetBundle, { recursive: true, verbatimSymlinks: true });
    patchPlist(join(targetBundle, "Contents", "Info.plist"), appName, bundleId);
    setPlistUrlScheme(join(targetBundle, "Contents", "Info.plist"), deeplinkProtocol);
    if (existsSync(iconPath)) {
      cpSync(iconPath, join(targetBundle, "Contents", "Resources", "icon.icns"));
      setPlistString(join(targetBundle, "Contents", "Info.plist"), "CFBundleIconFile", "icon");
    }

    for (const [name, suffix, displayName] of [
      ["Electron Helper.app", "helper", `${appName} Helper`],
      ["Electron Helper (GPU).app", "helper.gpu", `${appName} Helper (GPU)`],
      ["Electron Helper (Plugin).app", "helper.plugin", `${appName} Helper (Plugin)`],
      ["Electron Helper (Renderer).app", "helper.renderer", `${appName} Helper (Renderer)`],
    ]) {
      const plist = join(targetBundle, "Contents", "Frameworks", name, "Contents", "Info.plist");
      if (existsSync(plist)) patchPlist(plist, displayName, `${bundleId}.${suffix}`);
    }

    writeFileSync(metadataPath, metadata);
  }

  return targetExecPath;
}

function quoteDesktopExecArgument(value) {
  return '"' + value.replaceAll(/(["`$\\])/g, "\\$1") + '"';
}

function resolveLinuxElectronArgs() {
  if (process.platform !== "linux") return [];

  const require = createRequire(import.meta.url);
  const electronExecPath = require("electron");
  const sandboxPath = join(dirname(electronExecPath), "chrome-sandbox");
  if (existsSync(sandboxPath)) {
    const sandbox = statSync(sandboxPath);
    if (sandbox.uid === 0 && (sandbox.mode & 0o4000) !== 0) return [];
  }

  return ["--no-sandbox"];
}

function registerLinuxProtocolHandler(electronArgs) {
  if (process.platform !== "linux") return undefined;

  const require = createRequire(import.meta.url);
  const electronExecPath = require("electron");
  const configuredProfilePath = process.env.PLAKK_DESKTOP_USER_DATA_PATH?.trim();
  const profilePath = configuredProfilePath ? resolve(configuredProfilePath) : undefined;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const applicationsDir = join(dataHome, "applications");
  const desktopEntryPath = join(applicationsDir, linuxDesktopEntryName);
  const desktopExec = [
    ...(profilePath ? ["env", `PLAKK_DESKTOP_USER_DATA_PATH=${profilePath}`] : []),
    electronExecPath,
    ...electronArgs,
    desktopDir,
  ]
    .map(quoteDesktopExecArgument)
    .join(" ");
  const desktopEntry = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${appName}`,
    `Exec=${desktopExec} %u`,
    `Icon=${linuxIconPath}`,
    "Terminal=false",
    "NoDisplay=true",
    `MimeType=x-scheme-handler/${deeplinkProtocol};`,
    "",
  ].join("\n");

  mkdirSync(applicationsDir, { recursive: true });
  if (!existsSync(desktopEntryPath) || readFileSync(desktopEntryPath, "utf8") !== desktopEntry) {
    writeFileSync(desktopEntryPath, desktopEntry, { mode: 0o644 });
  }

  run("update-desktop-database", [applicationsDir]);
  run("xdg-mime", ["default", linuxDesktopEntryName, `x-scheme-handler/${deeplinkProtocol}`]);

  const registeredEntry = output("xdg-mime", [
    "query",
    "default",
    `x-scheme-handler/${deeplinkProtocol}`,
  ]);
  if (registeredEntry !== linuxDesktopEntryName) {
    throw new Error(
      `Could not register ${linuxDesktopEntryName} as the ${deeplinkProtocol} protocol handler.`,
    );
  }

  return linuxDesktopEntryName;
}

const electronExecPath = resolveElectronExecPath();
const linuxElectronArgs = resolveLinuxElectronArgs();
const linuxDesktopName = registerLinuxProtocolHandler(linuxElectronArgs);
const electronViteArgs = ["dev", ...process.argv.slice(2)];
if (linuxElectronArgs.some((argument) => !electronViteArgs.includes(argument))) {
  if (!electronViteArgs.includes("--")) electronViteArgs.push("--");
  for (const argument of linuxElectronArgs) {
    if (!electronViteArgs.includes(argument)) electronViteArgs.push(argument);
  }
}

const child = spawn("electron-vite", electronViteArgs, {
  cwd: desktopDir,
  env: {
    ...process.env,
    ...(electronExecPath ? { ELECTRON_EXEC_PATH: electronExecPath } : {}),
    ...(linuxDesktopName ? { PLAKK_LINUX_DESKTOP_NAME: linuxDesktopName } : {}),
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
