import assert from "node:assert/strict";
import { test } from "node:test";
import { isTrustedRendererUrl } from "./renderer-origin";

const INDEX = "/opt/app/resources/renderer/index.html";

test("dev: accepts the dev server origin (any path/hash)", () => {
  const opts = {
    devServerUrl: "http://localhost:5173",
    rendererIndexPath: INDEX,
  };
  assert.equal(isTrustedRendererUrl("http://localhost:5173/", opts), true);
  assert.equal(
    isTrustedRendererUrl("http://localhost:5173/#/chat", opts),
    true,
  );
});

test("dev: rejects a look-alike host that only shares a prefix", () => {
  const opts = {
    devServerUrl: "http://localhost:5173",
    rendererIndexPath: INDEX,
  };
  assert.equal(
    isTrustedRendererUrl("http://localhost:5173.evil.com/", opts),
    false,
  );
  assert.equal(
    isTrustedRendererUrl("http://evil.com/localhost:5173", opts),
    false,
  );
});

test("prod: accepts the packaged index file, ignoring hash routing", () => {
  const opts = { rendererIndexPath: INDEX };
  assert.equal(
    isTrustedRendererUrl("file:///opt/app/resources/renderer/index.html", opts),
    true,
  );
  assert.equal(
    isTrustedRendererUrl(
      "file:///opt/app/resources/renderer/index.html#/settings",
      opts,
    ),
    true,
  );
});

test("prod: rejects any other local file", () => {
  const opts = { rendererIndexPath: INDEX };
  assert.equal(
    isTrustedRendererUrl("file:///opt/app/resources/renderer/evil.html", opts),
    false,
  );
  assert.equal(isTrustedRendererUrl("file:///etc/passwd", opts), false);
  assert.equal(
    isTrustedRendererUrl(
      "file://evil/opt/app/resources/renderer/index.html",
      opts,
    ),
    false,
  );
  assert.equal(
    isTrustedRendererUrl(
      "file://user@evil/opt/app/resources/renderer/index.html",
      opts,
    ),
    false,
  );
});

test("prod: keeps UNC renderer shares bound to the expected host", () => {
  const opts = { rendererIndexPath: "//server/share/app/index.html" };
  assert.equal(
    isTrustedRendererUrl("file://server/share/app/index.html#/chat", opts),
    true,
  );
  assert.equal(
    isTrustedRendererUrl("file://other/share/app/index.html", opts),
    false,
  );
});

test("prod: treats Windows paths case-insensitively", () => {
  if (process.platform !== "win32") return;
  const opts = {
    rendererIndexPath:
      "C:\\Program Files\\Pi Desktop\\resources\\renderer\\index.html",
  };
  assert.equal(
    isTrustedRendererUrl(
      "file:///c:/program%20files/pi%20desktop/resources/renderer/INDEX.HTML",
      opts,
    ),
    true,
  );
});

test("rejects unparseable input", () => {
  assert.equal(
    isTrustedRendererUrl("not a url", { rendererIndexPath: INDEX }),
    false,
  );
});
