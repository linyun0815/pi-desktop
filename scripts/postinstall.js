#!/usr/bin/env node
/**
 * Pi Desktop postinstall validates the native node-pty files installed by the
 * package and verifies that Electron's binary was placed on disk.
 *
 * node-pty 1.1 uses Node-API and ships prebuilt binaries for Windows and macOS.
 * Linux builds its Node-API binary during node-pty's own install hook. Rebuilding
 * either form against Electron is unnecessary and, on Windows, would require
 * Visual Studio's optional Spectre-mitigated libraries.
 *
 * Steps:
 *   1. Verify that node-pty has a complete native binary set for this platform.
 *   2. Verify the Electron binary. If its download was silently skipped,
 *      automatically re-run Electron's own install.js and report next steps if
 *      that still fails.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function log(msg) {
  console.log(`[postinstall] ${msg}`);
}

function requiredNodePtyFiles(platform) {
  if (platform === "win32") {
    return [
      "conpty.node",
      "conpty_console_list.node",
      "pty.node",
      "winpty-agent.exe",
      "winpty.dll",
      "conpty/conpty.dll",
      "conpty/OpenConsole.exe",
    ];
  }
  if (platform === "darwin") return ["pty.node", "spawn-helper"];
  return ["pty.node"];
}

function findNodePtyBinaryDirectory(root, platform, arch) {
  const nodePtyRoot = path.join(root, "node_modules", "node-pty");
  const candidates = [
    path.join(nodePtyRoot, "build", "Release"),
    path.join(nodePtyRoot, "build", "Debug"),
    path.join(nodePtyRoot, "prebuilds", `${platform}-${arch}`),
  ];
  const requiredFiles = requiredNodePtyFiles(platform);
  return candidates.find((directory) =>
    requiredFiles.every((file) => fs.existsSync(path.join(directory, file))),
  );
}

function verifyNodePtyNativeFiles() {
  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const binaryDirectory = findNodePtyBinaryDirectory(ROOT, platform, arch);
  if (binaryDirectory) {
    log(
      `node-pty native files present (${path.relative(ROOT, binaryDirectory)})`,
    );
    return;
  }

  console.error("");
  console.error(
    `[postinstall] node-pty native files are missing for ${platform}-${arch}.`,
  );
  console.error("Reinstall node-pty without forcing a source build:");
  console.error("  npm config delete build-from-source");
  console.error("  npm install");
  console.error(
    "For an unsupported platform, install the native compiler prerequisites and run:",
  );
  console.error("  npm rebuild node-pty");
  console.error("");
  process.exit(1);
}

function electronBinaryPath(root = ROOT, env = process.env) {
  const electronRoot = path.join(root, "node_modules", "electron");
  const pathTxt = path.join(electronRoot, "path.txt");
  const distDir =
    env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronRoot, "dist");
  try {
    const relativePath = fs.readFileSync(pathTxt, "utf8").trim();
    return relativePath ? path.join(distDir, relativePath) : null;
  } catch {
    return null;
  }
}

function verifyElectronBinary() {
  const binaryPath = electronBinaryPath();
  if (binaryPath && fs.existsSync(binaryPath)) {
    log("electron binary present");
    return;
  }

  log("electron binary missing — re-running electron/install.js");
  const installJs = path.join(ROOT, "node_modules", "electron", "install.js");
  if (!fs.existsSync(installJs)) {
    console.error("");
    console.error("[postinstall] the Electron package is missing.");
    if (
      process.env.NODE_ENV === "production" ||
      process.env.npm_config_omit?.split(",").includes("dev")
    ) {
      console.error(
        "Development dependencies were omitted. Pi Desktop source builds require them:",
      );
      console.error("  npm install --include=dev");
    } else {
      console.error("Run `npm install electron --save-dev` and retry.");
    }
    console.error("");
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [installJs], {
    cwd: path.dirname(installJs),
    stdio: "inherit",
  });

  const binaryPathAfterInstall = electronBinaryPath();
  if (
    result.status !== 0 ||
    !binaryPathAfterInstall ||
    !fs.existsSync(binaryPathAfterInstall)
  ) {
    console.error("");
    console.error(
      "[postinstall] electron binary still missing after install.js retry.",
    );
    console.error("Common causes:");
    console.error(
      "  - Antivirus blocking the extraction (add the repo and ~/AppData/Local/electron to exclusions)",
    );
    console.error(
      "  - Corporate proxy blocking github.com (set ELECTRON_MIRROR to your internal mirror)",
    );
    console.error("  - Disk space or permission issues");
    console.error("");
    console.error("Manual recovery:");
    console.error("  cd node_modules/electron && node install.js");
    process.exit(1);
  }

  log("electron binary downloaded and extracted");
}

function main() {
  verifyNodePtyNativeFiles();
  verifyElectronBinary();
}

if (require.main === module) main();

module.exports = {
  findNodePtyBinaryDirectory,
  requiredNodePtyFiles,
  electronBinaryPath,
};
