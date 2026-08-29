/**
 * Packaging verifier for the embedded Pi SDK runtime.
 *
 * Default mode checks the on-disk artifacts a release needs: the exact pinned
 * SDK version, the built utility worker, and the SDK's dist resources (HTML
 * export template + vendor scripts, TUI theme JSON, Photon WASM) plus the
 * optional native modules that must survive asar/asar.unpacking.
 *
 * `--smoke` additionally boots a minimal in-memory SDK session on the Node
 * bundled with Electron (ELECTRON_RUN_AS_NODE) with a scrubbed PATH — proving
 * the embedded runtime needs neither a system `pi` nor a system `node`.
 *
 * Usage: node scripts/verify-embedded-pi.mjs [--smoke]
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(root, 'package.json'))
const smoke = process.argv.includes('--smoke')

const PINNED_SDK = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).dependencies[
  '@earendil-works/pi-coding-agent'
]

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures++
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ─── Dependency pinning ──────────────────────────────────────────────────────

section('依赖锁定')
check(
  'Pi SDK 精确固定版本',
  typeof PINNED_SDK === 'string' && /^\d+\.\d+\.\d+$/.test(PINNED_SDK),
  `package.json pins "${PINNED_SDK}"`,
)

// The SDK is ESM-only with a restricted exports map, so subpath require
// fails by design: read its package.json from the node_modules tree instead.
const sdkRoot = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent')
const sdkPackageJsonPath = join(sdkRoot, 'package.json')
let installedVersion
try {
  installedVersion = JSON.parse(readFileSync(sdkPackageJsonPath, 'utf-8')).version
} catch {
  installedVersion = undefined
}
check(
  '已安装的 SDK 版本与锁定一致',
  installedVersion === PINNED_SDK,
  `installed ${installedVersion ?? 'MISSING'}`,
)

// ─── Built worker ────────────────────────────────────────────────────────────

section('构建产物')
const workerPath = join(root, 'out', 'main', 'embedded-pi-worker.js')
check('utility worker 入口已构建', existsSync(workerPath), workerPath)
const mainEntry = join(root, 'out', 'main', 'index.js')
check('main 入口已构建', existsSync(mainEntry), mainEntry)

// ─── SDK dist resources ──────────────────────────────────────────────────────

if (sdkRoot && existsSync(join(sdkRoot, 'dist', 'index.js'))) {
  section('SDK 资源（必须随发行包分发）')
  const resources = [
    'dist/core/export-html/template.html',
    'dist/core/export-html/template.css',
    'dist/core/export-html/template.js',
    'dist/modes/interactive/theme/dark.json',
    join('node_modules', '@silvia-odwyer', 'photon-node', 'photon_rs_bg.wasm'),
  ]
  for (const rel of resources) {
    check(rel, existsSync(join(sdkRoot, rel)))
  }

  section('可选原生模块（asar.unpack 目标）')
  const clipboardPrebuilds = join(
    sdkRoot,
    'node_modules',
    '@mariozechner',
    'clipboard',
  )
  check(
    '@mariozechner/clipboard 预编译目录存在',
    existsSync(clipboardPrebuilds),
    existsSync(clipboardPrebuilds) ? '' : '缺失时剪贴板功能降级，不影响聊天',
  )
} else {
  failures++
  console.error('  ✘ 无法解析 SDK 安装目录')
}

// ─── Minimal smoke session (no system pi/node) ──────────────────────────────

if (smoke) {
  section('最小 SDK 会话（ELECTRON_RUN_AS_NODE + 空 PATH）')
  const electronDist = dirname(req.resolve('electron'))
  const electronBinary =
    process.platform === 'win32'
      ? join(electronDist, 'dist', 'electron.exe')
      : process.platform === 'darwin'
        ? join(electronDist, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(electronDist, 'dist', 'electron')
  if (!existsSync(electronBinary)) {
    failures++
    console.error('  ✘ 未找到 Electron 二进制，先运行 npm install')
  } else {
    // No model request happens: the smoke proves the SDK constructs a full
    // in-memory agent session without a system node/pi and without network.
    const harness = `
      const sdk = await import(${JSON.stringify(sdkRoot ? 'file://' + join(sdkRoot, 'dist', 'index.js') : '@earendil-works/pi-coding-agent')});
      const sessionManager = sdk.SessionManager.inMemory();
      const settingsManager = sdk.SettingsManager.create(process.cwd(), process.env.PI_CODING_AGENT_DIR);
      const modelRuntime = await sdk.ModelRuntime.create();
      const loader = new sdk.DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: process.env.PI_CODING_AGENT_DIR,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await loader.reload();
      const { session } = await sdk.createAgentSession({
        cwd: process.cwd(),
        agentDir: process.env.PI_CODING_AGENT_DIR,
        sessionManager,
        settingsManager,
        modelRuntime,
        resourceLoader: loader,
      });
      if (!session.sessionId) throw new Error('in-memory session has no id');
      console.log('SMOKE_OK ' + session.sessionId);
      process.exit(0);
    `
    try {
      const out = execFileSync(electronBinary, ['-e', harness], {
        encoding: 'utf-8',
        timeout: 120_000,
        env: {
          // A scrubbed PATH: the SDK must not depend on a system node/pi.
          PATH: '',
          ELECTRON_RUN_AS_NODE: '1',
          PI_CODING_AGENT_DIR: join(root, '.verify-pi-agent'),
          HOME: process.env.HOME ?? process.env.USERPROFILE ?? root,
        },
        cwd: root,
      })
      check('in-memory 会话创建成功', out.includes('SMOKE_OK'), out.trim().split('\n').pop() ?? '')
    } catch (err) {
      failures++
      console.error(`  ✘ 冒烟会话失败: ${err?.message ?? err}`)
      if (err?.stdout) console.error(err.stdout)
      if (err?.stderr) console.error(err.stderr)
    }
  }
}

// ─── Result ──────────────────────────────────────────────────────────────────

console.log('')
if (failures > 0) {
  console.error(`verify-embedded-pi: FAIL（${failures} 项未通过）`)
  process.exit(1)
}
console.log('verify-embedded-pi: OK')
