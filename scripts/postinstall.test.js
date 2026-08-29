const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  findNodePtyBinaryDirectory,
  requiredNodePtyFiles,
  electronBinaryPath,
} = require("./postinstall");

function createTempRoot(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-desktop-postinstall-"),
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

function createFiles(directory, files) {
  for (const file of files) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  }
}

test("requires the complete Windows node-pty runtime set", () => {
  assert.deepEqual(requiredNodePtyFiles("win32"), [
    "conpty.node",
    "conpty_console_list.node",
    "pty.node",
    "winpty-agent.exe",
    "winpty.dll",
    "conpty/conpty.dll",
    "conpty/OpenConsole.exe",
  ]);
});

test("finds Windows prebuilds when a failed source build left an incomplete directory", (t) => {
  const root = createTempRoot(t);
  const failedBuild = path.join(
    root,
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );
  const prebuild = path.join(
    root,
    "node_modules",
    "node-pty",
    "prebuilds",
    "win32-x64",
  );
  createFiles(failedBuild, ["conpty.node"]);
  createFiles(prebuild, requiredNodePtyFiles("win32"));

  assert.equal(findNodePtyBinaryDirectory(root, "win32", "x64"), prebuild);
});

test("finds a source-built Linux Node-API binary", (t) => {
  const root = createTempRoot(t);
  const release = path.join(
    root,
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );
  createFiles(release, ["pty.node"]);

  assert.equal(findNodePtyBinaryDirectory(root, "linux", "x64"), release);
});

test("rejects incomplete native binary sets", (t) => {
  const root = createTempRoot(t);
  const prebuild = path.join(
    root,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
  );
  createFiles(prebuild, ["pty.node"]);

  assert.equal(findNodePtyBinaryDirectory(root, "darwin", "arm64"), undefined);
});

test("resolves the configured Electron executable path", (t) => {
  const root = createTempRoot(t);
  const electronRoot = path.join(root, "node_modules", "electron");
  const executable = path.join(electronRoot, "dist", "electron.exe");
  createFiles(electronRoot, ["path.txt", "dist/electron.exe"]);
  fs.writeFileSync(path.join(electronRoot, "path.txt"), "electron.exe\n");

  assert.equal(electronBinaryPath(root, {}), executable);
});

test("returns null for an empty or missing Electron path file", (t) => {
  const root = createTempRoot(t);
  const electronRoot = path.join(root, "node_modules", "electron");
  createFiles(electronRoot, ["path.txt"]);

  assert.equal(electronBinaryPath(root, {}), null);
  fs.rmSync(path.join(electronRoot, "path.txt"));
  assert.equal(electronBinaryPath(root, {}), null);
});
