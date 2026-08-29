import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPathWithin, isAuthorizedAttachmentPath } from "./path-authorization";

const ROOT = join("/home", "alice", "project");

test("accepts a file directly inside the root", () => {
  assert.equal(isPathWithin(ROOT, join(ROOT, "notes.md")), true);
});

test("accepts a deeply nested file inside the root", () => {
  assert.equal(isPathWithin(ROOT, join(ROOT, "src", "a", "b.ts")), true);
});

test("accepts the root itself", () => {
  assert.equal(isPathWithin(ROOT, ROOT), true);
});

test("rejects a path outside the root", () => {
  assert.equal(isPathWithin(ROOT, join("/etc", "passwd")), false);
});

test("rejects a parent-traversal escape", () => {
  assert.equal(isPathWithin(ROOT, join(ROOT, "..", "..", "secret.txt")), false);
});

test("rejects a sibling directory that shares the root prefix", () => {
  // /home/alice/project-secrets must NOT count as inside /home/alice/project.
  assert.equal(isPathWithin(ROOT, `${ROOT}-secrets/leak.txt`), false);
});

test("authorizes an attachment inside the workspace", () => {
  const ok = isAuthorizedAttachmentPath(join(ROOT, "img.png"), {
    workspaceRoot: ROOT,
    approvedPaths: new Set(),
  });
  assert.equal(ok, true);
});

test("authorizes a dialog-approved attachment outside the workspace", () => {
  const picked = resolve("/tmp", "screenshot.png");
  const ok = isAuthorizedAttachmentPath(picked, {
    workspaceRoot: ROOT,
    approvedPaths: new Set([picked]),
  });
  assert.equal(ok, true);
});

test("rejects an arbitrary path that is neither approved nor in the workspace", () => {
  const ok = isAuthorizedAttachmentPath(join("/etc", "passwd"), {
    workspaceRoot: ROOT,
    approvedPaths: new Set([resolve("/tmp", "screenshot.png")]),
  });
  assert.equal(ok, false);
});

test("rejects a workspace symlink that points outside the workspace", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "path-auth-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "secret.txt");
  const link = join(workspace, "linked.txt");
  await mkdir(workspace);
  await writeFile(outside, "secret");
  try {
    await symlink(outside, link, "file");
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }

  assert.equal(
    isAuthorizedAttachmentPath(link, {
      workspaceRoot: workspace,
      approvedPaths: new Set(),
    }),
    false,
  );
  await rm(base, { recursive: true, force: true });
});

test("rejects everything outside approvals when there is no active workspace", () => {
  const ok = isAuthorizedAttachmentPath(join("/etc", "passwd"), {
    workspaceRoot: null,
    approvedPaths: new Set(),
  });
  assert.equal(ok, false);
});
