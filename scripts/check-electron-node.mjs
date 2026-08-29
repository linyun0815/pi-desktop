/**
 * Build gate for the embedded Pi SDK runtime.
 *
 * The shipped release executes `@earendil-works/pi-coding-agent` on the Node
 * runtime bundled inside Electron — never on a system Node. If Electron's
 * Node is older than the SDK's floor, the build must fail here so the release
 * cannot ship a runtime the SDK silently cannot run on. Fix: upgrade Electron.
 *
 * Usage: `node scripts/check-electron-node.mjs` (wired into `npm run build`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MIN_NODE = '22.19.0'

function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const left = pa[i] ?? 0
    const right = pb[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

function resolveElectronBinary() {
  const req = createRequire(join(root, 'package.json'))
  // `electron` resolves to its JS entry; the binary lives in the dist/ folder
  // that the install script downloads (matching electron's own path.txt).
  const electronDist = join(dirname(req.resolve('electron')), 'dist')
  const binary =
    process.platform === 'win32'
      ? join(electronDist, 'electron.exe')
      : process.platform === 'darwin'
        ? join(electronDist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(electronDist, 'electron')
  if (!existsSync(binary)) {
    console.error(
      `[check-electron-node] Electron binary not found at ${binary}. Run \`npm install\` first.`,
    )
    process.exit(1)
  }
  return binary
}

let electronNodeVersion
try {
  const binary = resolveElectronBinary()
  // ELECTRON_RUN_AS_NODE turns the binary into a plain Node that prints the
  // exact version the packaged app will execute the SDK on.
  electronNodeVersion = execFileSync(binary, ['-p', 'process.versions.node'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim()
} catch (err) {
  console.error(
    `[check-electron-node] Failed to read Electron's Node version: ${err?.message ?? err}`,
  )
  process.exit(1)
}

if (compareVersions(electronNodeVersion, MIN_NODE) < 0) {
  console.error(
    `\n[check-electron-node] FAIL: Electron bundles Node ${electronNodeVersion}, ` +
      `but the embedded Pi SDK requires >= ${MIN_NODE}.\n` +
      `Upgrade Electron in package.json — the release must never fall back to a system Node.\n`,
  )
  process.exit(1)
}

// Also verify the pinned SDK dependency is present and exact.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const sdkSpec = pkg.dependencies?.['@earendil-works/pi-coding-agent']
if (!sdkSpec) {
  console.error('[check-electron-node] FAIL: @earendil-works/pi-coding-agent is not a dependency.')
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+$/.test(sdkSpec)) {
  console.error(
    `[check-electron-node] FAIL: @earendil-works/pi-coding-agent must be pinned exactly ` +
      `(got "${sdkSpec}"). Floating semver invites unreviewed SDK upgrades.`,
  )
  process.exit(1)
}

console.log(
  `[check-electron-node] OK: Electron Node ${electronNodeVersion} >= ${MIN_NODE}; ` +
    `Pi SDK pinned at ${sdkSpec}.`,
)
