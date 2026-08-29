import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVERY_MAX_MODELS,
  buildDiscoveryQuery,
  buildDiscoveryRequestHeaders,
  buildModelsEndpoint,
  fetchWithAuthRedirectGuard,
  parseDiscoveredModelsPayload,
  parseModelsListResponse,
} from "./model-discovery";

// ─── Endpoint construction ───────────────────────────────────────────────────

test("buildModelsEndpoint normalizes trailing slashes and version segments", () => {
  assert.equal(
    buildModelsEndpoint("https://api.example.com", "openai-completions")?.toString(),
    "https://api.example.com/v1/models",
  );
  assert.equal(
    buildModelsEndpoint("https://api.example.com/", "openai-completions")?.toString(),
    "https://api.example.com/v1/models",
  );
  assert.equal(
    buildModelsEndpoint("https://api.example.com/v1/", "openai-completions")?.toString(),
    "https://api.example.com/v1/models",
  );
  assert.equal(
    buildModelsEndpoint("https://api.example.com/v1beta", "google-generative-ai")?.toString(),
    "https://api.example.com/v1beta/models",
  );
  assert.equal(
    buildModelsEndpoint("https://generativelanguage.googleapis.com", "google-generative-ai")?.toString(),
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  assert.equal(
    buildModelsEndpoint("https://api.anthropic.com", "anthropic-messages")?.toString(),
    "https://api.anthropic.com/v1/models",
  );
});

test("buildModelsEndpoint rejects non-http schemes and unknown APIs", () => {
  assert.equal(buildModelsEndpoint("file:///etc/passwd", "openai-completions"), null);
  assert.equal(buildModelsEndpoint("ftp://api.example.com", "openai-completions"), null);
  assert.equal(buildModelsEndpoint("not a url", "openai-completions"), null);
  assert.equal(buildModelsEndpoint("https://api.example.com", "unknown-api"), null);
});

// ─── Response parsing ────────────────────────────────────────────────────────

test("parseModelsListResponse accepts bare arrays and common wrappers", () => {
  const rows = [{ id: "b" }, { id: "models/a" }, { id: "a" }, { id: "b" }];
  for (const payload of [
    rows,
    { data: rows },
    { models: rows },
    { results: rows },
    { items: rows },
  ]) {
    const parsed = parseModelsListResponse(payload);
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.deepEqual(
        parsed.models.map((m) => m.id),
        ["a", "b"], // prefix stripped, deduped, sorted
      );
    }
  }
});

test("parseModelsListResponse supports string items and name fields", () => {
  const parsed = parseModelsListResponse({
    data: ["solo", { id: "x", display_name: "X Ray" }, { model: "y", name: "Why" }],
  });
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(parsed.models, [
      { id: "solo" },
      { id: "x", name: "X Ray" },
      { id: "y", name: "Why" },
    ]);
  }
});

test("parseModelsListResponse caps the result and rejects junk", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}` }));
  const capped = parseModelsListResponse(many, 10);
  assert.ok(capped.ok && capped.ok && capped.models.length === 10);

  for (const junk of [null, undefined, 42, "data", { nope: [] }, { data: "x" }]) {
    assert.equal(parseModelsListResponse(junk).ok, false);
  }
  const parsed = parseModelsListResponse({ data: [{ id: "" }, 3, null, { id: "keep" }] });
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(parsed.models.map((m) => m.id), ["keep"]);
});

// ─── Response payload narrowing (admin helper → parent) ─────────────────────

test("parseDiscoveredModelsPayload drops credential-like extra fields", () => {
  const rows = parseDiscoveredModelsPayload({
    models: [
      { id: "m1", name: "One", apiKey: "sk-secret", headers: { Authorization: "x" } },
      { id: "m2" },
      { id: "" },
      "junk",
      null,
    ],
    apiKey: "sk-root-secret",
  });
  assert.deepEqual(rows, [{ id: "m1", name: "One" }, { id: "m2" }]);
  assert.deepEqual(parseDiscoveredModelsPayload(null), []);
  assert.deepEqual(parseDiscoveredModelsPayload({ nope: 1 }), []);
});

// ─── Redirect guard ──────────────────────────────────────────────────────────

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

test("redirect guard keeps auth headers on same-origin redirects", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    return redirectResponse("https://api.example.com/v1/models");
  }) as typeof fetch;

  const response = await fetchWithAuthRedirectGuard(
    fetchImpl,
    "https://api.example.com/v1/models?old=1",
    { Authorization: "Bearer sk-test" },
  );
  assert.equal(response.ok, true);
  assert.deepEqual(seen, [
    { url: "https://api.example.com/v1/models?old=1", auth: "Bearer sk-test" },
    // Same origin → the credential rides along.
    { url: "https://api.example.com/v1/models", auth: "Bearer sk-test" },
  ]);
});

test("redirect guard drops auth headers on cross-origin redirects", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    if (url === "https://evil.example.net/steal") {
      return new Response("{}", { status: 200 });
    }
    return redirectResponse("https://evil.example.net/steal");
  }) as typeof fetch;

  await fetchWithAuthRedirectGuard(
    fetchImpl,
    "https://api.example.com/v1/models",
    { Authorization: "Bearer sk-test", "x-api-key": "secret" },
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[1].url, "https://evil.example.net/steal");
  assert.equal(seen[1].auth, null);
});

// ─── Per-API request shape ───────────────────────────────────────────────────

test("request headers and query parameters are per-API", () => {
  assert.deepEqual(buildDiscoveryRequestHeaders("openai-completions", "sk-1"), {
    Accept: "application/json",
    Authorization: "Bearer sk-1",
  });
  const anthropic = buildDiscoveryRequestHeaders("anthropic-messages", "sk-2");
  assert.equal(anthropic["x-api-key"], "sk-2");
  assert.equal(anthropic["anthropic-version"], "2023-06-01");
  const google = buildDiscoveryRequestHeaders("google-generative-ai", "sk-3");
  assert.equal(google["x-goog-api-key"], "sk-3");
  // Keyless providers send no auth header at all.
  assert.deepEqual(buildDiscoveryRequestHeaders("openai-responses", null), {
    Accept: "application/json",
  });

  assert.deepEqual(buildDiscoveryQuery("anthropic-messages"), {
    limit: String(DISCOVERY_MAX_MODELS),
  });
  assert.deepEqual(buildDiscoveryQuery("google-generative-ai"), {
    pageSize: String(DISCOVERY_MAX_MODELS),
  });
  assert.deepEqual(buildDiscoveryQuery("openai-completions"), {});
});
