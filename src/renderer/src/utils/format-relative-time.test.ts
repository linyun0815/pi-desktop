import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRelativeTime } from "./format-relative-time";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A fixed "now" so the absolute-date fallback is deterministic.
const NOW = Date.parse("2026-07-12T12:00:00Z");
const ago = (ms: number): string => formatRelativeTime(NOW - ms, NOW);

test('sub-45s reads "刚刚" (incl. clock-skew future timestamps)', () => {
  assert.equal(ago(0), "刚刚");
  assert.equal(ago(44 * SECOND), "刚刚");
  assert.equal(ago(-5 * SECOND), "刚刚"); // timestamp slightly in the future
});

test("minutes bucket (singular at the boundary)", () => {
  assert.equal(ago(60 * SECOND), "1 分钟前");
  assert.equal(ago(5 * MINUTE), "5 分钟前");
  assert.equal(ago(59 * MINUTE), "59 分钟前");
});

test("hours bucket (singular at the boundary)", () => {
  assert.equal(ago(HOUR), "1 小时前");
  assert.equal(ago(20 * HOUR), "20 小时前");
});

test("yesterday, then days — never a unit coarser than days", () => {
  assert.equal(ago(25 * HOUR), "昨天");
  assert.equal(ago(3 * DAY), "3 天前");
  assert.equal(ago(29 * DAY), "29 天前");
});

test("falls back to an absolute date beyond ~30 days", () => {
  // The date is localized, not rendered as "N days ago". Checking for the
  // Chinese date parts keeps this independent of the local timezone.
  const dateShape = /\d{4}年\d{1,2}月\d{1,2}日/;
  assert.match(ago(30 * DAY), dateShape);
  assert.match(ago(200 * DAY), dateShape);
  assert.doesNotMatch(ago(29 * DAY), dateShape);
});
