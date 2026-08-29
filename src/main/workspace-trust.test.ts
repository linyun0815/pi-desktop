import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceTrustStore } from './workspace-trust'

function tmpFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-trust-'))
  return { path: join(dir, 'trusted-workspaces.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('an unknown workspace is not trusted', () => {
  const { path, cleanup } = tmpFile()
  try {
    const store = new WorkspaceTrustStore(path)
    assert.equal(store.isTrusted('/home/alice/project'), false)
  } finally {
    cleanup()
  }
})

test('trust() marks a workspace trusted and persists across instances', async () => {
  const { path, cleanup } = tmpFile()
  try {
    const store = new WorkspaceTrustStore(path)
    await store.trust('/home/alice/project')
    assert.equal(store.isTrusted('/home/alice/project'), true)
    // A fresh instance reading the same file sees the persisted trust.
    assert.equal(new WorkspaceTrustStore(path).isTrusted('/home/alice/project'), true)
  } finally {
    cleanup()
  }
})

test('revoke() removes trust and persists', async () => {
  const { path, cleanup } = tmpFile()
  try {
    const store = new WorkspaceTrustStore(path)
    await store.trust('/home/alice/project')
    await store.revoke('/home/alice/project')
    assert.equal(store.isTrusted('/home/alice/project'), false)
    assert.equal(new WorkspaceTrustStore(path).isTrusted('/home/alice/project'), false)
  } finally {
    cleanup()
  }
})

test('paths are normalized so trailing slashes and .. segments match', async () => {
  const { path, cleanup } = tmpFile()
  try {
    const store = new WorkspaceTrustStore(path)
    await store.trust('/home/alice/project/')
    assert.equal(store.isTrusted('/home/alice/project'), true)
    assert.equal(store.isTrusted('/home/alice/x/../project'), true)
  } finally {
    cleanup()
  }
})

test('an empty path is never trusted', () => {
  const { path, cleanup } = tmpFile()
  try {
    assert.equal(new WorkspaceTrustStore(path).isTrusted(''), false)
  } finally {
    cleanup()
  }
})

test('a malformed trust file is treated as no trust, not a crash', () => {
  const { path, cleanup } = tmpFile()
  try {
    writeFileSync(path, '{ not json', 'utf-8')
    assert.equal(new WorkspaceTrustStore(path).isTrusted('/home/alice/project'), false)
  } finally {
    cleanup()
  }
})

// ─── Versioned format + legacy migration ─────────────────────────────────────

test('a legacy v1 trust array is demoted to pending, not trusted', () => {
  const { path, cleanup } = tmpFile()
  try {
    writeFileSync(path, JSON.stringify(['/home/alice/project']), 'utf-8')
    const store = new WorkspaceTrustStore(path)
    // Legacy records predate the unified trust switch: nothing is trusted.
    assert.equal(store.isTrusted('/home/alice/project'), false)
    assert.equal(store.isPendingReconfirmation('/home/alice/project'), true)
    assert.deepEqual(store.status('/home/alice/project'), {
      trusted: false,
      pendingReconfirmation: true,
    })
  } finally {
    cleanup()
  }
})

test('re-confirming a pending workspace promotes it to trusted and rewrites v2', () => {
  const { path, cleanup } = tmpFile()
  try {
    writeFileSync(path, JSON.stringify(['/home/alice/project']), 'utf-8')
    const store = new WorkspaceTrustStore(path)
    void store.trust('/home/alice/project')
    assert.equal(store.isTrusted('/home/alice/project'), true)
    assert.equal(store.isPendingReconfirmation('/home/alice/project'), false)
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as { version: number; trusted: string[]; pendingReconfirmation: string[] }
    assert.equal(onDisk.version, 2)
    assert.ok(onDisk.trusted.length > 0)
    assert.equal(onDisk.pendingReconfirmation.length, 0)
  } finally {
    cleanup()
  }
})

test('a v2 file round-trips trusted and pending records', () => {
  const { path, cleanup } = tmpFile()
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        trusted: ['/home/alice/kept'],
        pendingReconfirmation: ['/home/alice/pending'],
      }),
      'utf-8',
    )
    const store = new WorkspaceTrustStore(path)
    assert.equal(store.isTrusted('/home/alice/kept'), true)
    assert.equal(store.isPendingReconfirmation('/home/alice/pending'), true)
    // A fresh instance agrees.
    const fresh = new WorkspaceTrustStore(path)
    assert.equal(fresh.isTrusted('/home/alice/kept'), true)
    assert.equal(fresh.isPendingReconfirmation('/home/alice/pending'), true)
  } finally {
    cleanup()
  }
})

test('revoking a pending workspace clears the pending record', async () => {
  const { path, cleanup } = tmpFile()
  try {
    writeFileSync(path, JSON.stringify(['/home/alice/project']), 'utf-8')
    const store = new WorkspaceTrustStore(path)
    await store.revoke('/home/alice/project')
    assert.equal(store.isPendingReconfirmation('/home/alice/project'), false)
    assert.equal(new WorkspaceTrustStore(path).isPendingReconfirmation('/home/alice/project'), false)
  } finally {
    cleanup()
  }
})
