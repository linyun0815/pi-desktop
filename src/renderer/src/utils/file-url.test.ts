import assert from "node:assert/strict";
import { test } from "node:test";
import { toFileUrl } from "./file-url";

test("encodes URI-significant characters in POSIX paths", () => {
  assert.equal(
    toFileUrl("/work/a#b ?%.html"),
    "file:///work/a%23b%20%3F%25.html",
  );
});

test("keeps the drive prefix while encoding Windows path segments", () => {
  assert.equal(toFileUrl("C:\\work\\a#b.html"), "file:///C:/work/a%23b.html");
});

test("encodes UNC path segments", () => {
  assert.equal(
    toFileUrl("\\\\server\\share\\a?b.html"),
    "file://server/share/a%3Fb.html",
  );
});
