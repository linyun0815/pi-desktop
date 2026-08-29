import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { lookup } from "node:dns";
import { join } from "node:path";
import { isIP, BlockList, type LookupFunction } from "node:net";
import { Agent } from "undici";
import {
  validateThemeFile,
  themeIdFromName,
  MAX_THEME_FILE_BYTES,
  MAX_THEME_AUTHOR_LENGTH,
  MAX_THEME_DESCRIPTION_LENGTH,
  type ThemeFile,
} from "../shared/theme/theme-file";
import { BUILTIN_THEME_IDS } from "../shared/theme/builtin-ids";
import type { GalleryTheme } from "../shared/ipc-contracts";

const THEME_FILE_EXT = ".json";
const VALID_THEME_ID = /^[a-z0-9-]+$/;

export interface UserThemeList {
  themes: Array<{ id: string; file: ThemeFile }>;
  warnings: string[];
}

export async function listUserThemes(dir: string): Promise<UserThemeList> {
  await mkdir(dir, { recursive: true });
  const themes: UserThemeList["themes"] = [];
  const warnings: string[] = [];
  for (const entry of (await readdir(dir))
    .filter((f) => f.endsWith(THEME_FILE_EXT))
    .sort()) {
    const id = entry.slice(0, -THEME_FILE_EXT.length);
    try {
      const file = validateThemeFile(
        JSON.parse(await readFile(join(dir, entry), "utf8")),
      );
      // Theme files are untrusted input (imported from disk or installed
      // from arbitrary URLs). saveUserTheme refuses to *create* a file whose
      // id collides with a built-in, but a colliding file can still land in
      // this directory by other means (predates that fix, external write,
      // future bug). If loaded, it would silently replace the real built-in
      // in the renderer's theme registry (Map.set) on every launch, so any
      // such file must be excluded here regardless of how it got there.
      if ((BUILTIN_THEME_IDS as readonly string[]).includes(id)) {
        warnings.push(
          `${entry}: id '${id}' collides with a built-in theme and was ignored`,
        );
        continue;
      }
      themes.push({ id, file });
    } catch (error) {
      warnings.push(
        `${entry}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { themes, warnings };
}

const IDENTITY_SEPARATOR = " ";

function themeIdentity(file: ThemeFile): string {
  return `${file.name}${IDENTITY_SEPARATOR}${file.kind}`;
}

// A real theme's identity is always `${name}${IDENTITY_SEPARATOR}${kind}`
// with kind restricted to 'dark' | 'light', so it can never equal this
// sentinel. Seeding the taken-id map with it for every built-in id forces
// the numeric-suffix loop below to run whenever a fresh save's base id
// collides with a built-in, without disturbing the legitimate "resave of an
// existing user theme file" identity-match path (a built-in is never itself
// a file in the user themes directory, so it can never be the thing a
// resave is legitimately updating).
const BUILTIN_IDENTITY_SENTINEL = "\0builtin";

const SUFFIX_START = 2;

// Windows treats these as device names even with a file extension, so a slug
// matching one cannot be written as "<id>.json" on Windows (fs writes fail or
// hit the device). Blocking them in the id search makes the suffix loop yield
// a safe id (e.g. "con" -> "con-2", which is not reserved), keeping user-theme
// files portable across macOS, Windows, and Linux. Appending "-N" always
// de-reserves, so this can never loop forever.
const WINDOWS_RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Finds the first id starting at `base` that is neither reserved nor rejected
// by `isBlocked`, appending `-2`, `-3`, ... until one is free. Shared by both
// save paths below; only the caller's definition of "blocked" differs.
function nextAvailableId(
  base: string,
  isBlocked: (id: string) => boolean,
): string {
  let id = base;
  for (
    let n = SUFFIX_START;
    WINDOWS_RESERVED_ID.test(id) || isBlocked(id);
    n += 1
  )
    id = `${base}-${n}`;
  return id;
}

// `existingId` is set only when the theme editor is re-saving a theme it is
// already editing (isUserTheme === true). It must NOT be derived from
// name+kind identity like the fresh-save path below: two different user
// themes can share a name+kind (e.g. after one of them gets renamed to
// match the other), and identity-matching on the *new* name would let the
// save silently overwrite the OTHER theme's file while the editor's
// rename-cleanup then deletes the theme actually being edited — destroying
// both. Restricting overwrite to the exact id under edit closes that path:
// any collision with any other id, built-in or user, is suffixed instead.
export async function saveUserTheme(
  dir: string,
  file: ThemeFile,
  existingId?: string,
): Promise<{ id: string }> {
  const theme = validateThemeFile(file);
  if (existingId !== undefined) {
    if (!VALID_THEME_ID.test(existingId))
      throw new Error(`invalid theme id: ${existingId}`);
    if ((BUILTIN_THEME_IDS as readonly string[]).includes(existingId)) {
      throw new Error(`cannot overwrite built-in theme id: ${existingId}`);
    }
  }
  await mkdir(dir, { recursive: true });
  const base = themeIdFromName(theme.name) || "theme";
  const { themes } = await listUserThemes(dir);

  let id: string;
  if (existingId !== undefined) {
    const takenIds = new Set<string>(BUILTIN_THEME_IDS);
    for (const t of themes) takenIds.add(t.id);
    id = nextAvailableId(
      base,
      (candidate) => takenIds.has(candidate) && candidate !== existingId,
    );
  } else {
    // Fresh create, file import, or URL install: dedupe by identity
    // (name+kind), so re-importing/re-installing the same theme keeps
    // updating the same file instead of piling up numbered duplicates. This
    // is intentionally different from the existingId path above — here
    // there is no "theme under edit" to protect, so identity is a safe and
    // desirable match key.
    const taken = new Map<string, string>(
      BUILTIN_THEME_IDS.map((builtinId) => [
        builtinId,
        BUILTIN_IDENTITY_SENTINEL,
      ]),
    );
    for (const t of themes) taken.set(t.id, themeIdentity(t.file));
    const identity = themeIdentity(theme);
    id = nextAvailableId(
      base,
      (candidate) => taken.has(candidate) && taken.get(candidate) !== identity,
    );
  }

  await writeFile(
    join(dir, `${id}${THEME_FILE_EXT}`),
    JSON.stringify(theme, null, 2),
  );
  return { id };
}

export async function deleteUserTheme(dir: string, id: string): Promise<void> {
  if (!VALID_THEME_ID.test(id)) throw new Error(`invalid theme id: ${id}`);
  await unlink(join(dir, `${id}${THEME_FILE_EXT}`));
}

// Reads the response body incrementally, aborting as soon as the byte
// count exceeds limitBytes, so an oversized or unbounded response is never
// fully buffered into memory before the size check applies.
async function readCappedText(
  response: Response,
  limitBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > limitBytes) {
      await reader.cancel();
      throw new Error(`theme file too large (limit ${limitBytes} bytes)`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

// --- SSRF guard for installThemeFromUrl -----------------------------------
//
// installThemeFromUrl fetches an arbitrary attacker-influenced URL from the
// Electron MAIN process, outside the renderer's CSP connect-src. Without
// host classification this is a blind SSRF primitive: pointing it (or a
// redirect target) at a private/loopback/link-local/cloud-metadata host
// makes the main process issue a real GET against internal infrastructure
// with no per-URL consent. Today the URL is user-typed; a planned in-app
// theme gallery would install from URLs listed in a fetched index.json, at
// which point a single poisoned gallery entry could target an internal
// host with no user interaction at all. This guard, plus manual redirect
// validation below, is the mitigation for both.

const THEME_FETCH_TIMEOUT_MS = 10_000;
const MAX_THEME_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

// Private, loopback, link-local, unspecified, and CGNAT ranges. BlockList
// delegates address parsing to Node, including expanded and IPv4-mapped IPv6
// spellings, so URL literals and DNS answers use the same classification.
const BLOCKED_NETWORKS = new BlockList();
BLOCKED_NETWORKS.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_NETWORKS.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_NETWORKS.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_NETWORKS.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_NETWORKS.addSubnet("::", 128, "ipv6");
BLOCKED_NETWORKS.addSubnet("::1", 128, "ipv6");
BLOCKED_NETWORKS.addSubnet("fc00::", 7, "ipv6");
BLOCKED_NETWORKS.addSubnet("fe80::", 10, "ipv6");

function isBlockedNetworkAddress(address: string): boolean {
  const normalized = address.split("%", 1)[0];
  const family = isIP(normalized);
  if (family === 4) return BLOCKED_NETWORKS.check(normalized, "ipv4");
  if (family === 6) return BLOCKED_NETWORKS.check(normalized, "ipv6");
  return false;
}

// Node's fetch resolves a hostname inside its connector. Supplying a lookup
// callback to an undici dispatcher lets us validate the exact address selected
// for each new connection, closing the DNS-rebinding gap between a URL check and
// the actual socket connection. Reject all answers when a hostname is dual-stack
// with one private address; allowing a later fallback could still reach it.
const safeThemeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, verbatim: false }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => isBlockedNetworkAddress(address))
    ) {
      callback(
        new Error(`theme URL host "${hostname}" resolved to a blocked address`),
        "",
      );
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  });
};

const SAFE_THEME_DISPATCHER = new Agent({
  connect: {
    lookup: safeThemeLookup,
  },
  keepAliveTimeout: 1_000,
  keepAliveMaxTimeout: 1_000,
});

// Rejects any URL that would send the main process's fetch at an internal
// or well-known-local host. Must be called on the initial URL AND on every
// redirect hop's target before that hop is fetched (see installThemeFromUrl)
// — validating only the first URL is not sufficient because redirects can
// change the destination host.
function assertSafeThemeUrl(parsed: URL): void {
  if (parsed.protocol !== "https:") {
    throw new Error(`theme URLs must use https, got ${parsed.protocol}`);
  }
  // WHATWG URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]").
  // Unwrap them before handing the address to Node's canonical classifier.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error(
      `theme URL host "${hostname}" is blocked (local/loopback hostname)`,
    );
  }
  const family = isIP(hostname);
  if (family === 4 && isBlockedNetworkAddress(hostname)) {
    throw new Error(
      `theme URL host "${hostname}" is blocked (private/reserved IPv4 address)`,
    );
  }
  if (family === 6 && isBlockedNetworkAddress(hostname)) {
    throw new Error(
      `theme URL host "${hostname}" is blocked (private/reserved IPv6 address)`,
    );
  }
}

// Fetches `url` following redirects manually, re-running the SSRF guard on
// every hop's target before it is fetched, with a per-request timeout and a
// redirect cap. Returns the first non-redirect Response (the caller checks
// `.ok` and reads the body under a size cap). Shared by installThemeFromUrl
// and fetchGalleryThemes so both get identical redirect/SSRF protection.
async function guardedFetch(
  url: string,
  fetchFn: typeof fetch,
): Promise<Response> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error("theme URL is invalid");
  }
  assertSafeThemeUrl(current);

  let response: Response;
  let redirects = 0;
  for (;;) {
    // Each hop's target depends on the previous hop's response, so this
    // await must stay sequential rather than being parallelized.
    const fetchOptions: NonNullable<Parameters<typeof fetch>[1]> = {
      redirect: "manual",
      signal: AbortSignal.timeout(THEME_FETCH_TIMEOUT_MS),
    };
    if (fetchFn === globalThis.fetch) {
      // `dispatcher` is supported by Node's fetch but omitted from the DOM
      // RequestInit type used by this project; assign it without widening the
      // options object passed to injected test fetch functions.
      Object.assign(fetchOptions, { dispatcher: SAFE_THEME_DISPATCHER });
    }
    response = await fetchFn(current.toString(), fetchOptions);
    if (!REDIRECT_STATUS_CODES.has(response.status)) break;
    redirects += 1;
    if (redirects > MAX_THEME_REDIRECTS) {
      throw new Error(`theme URL exceeded ${MAX_THEME_REDIRECTS} redirects`);
    }
    const location = response.headers.get("location");
    if (!location)
      throw new Error(
        `theme URL redirect (${response.status}) had no location header`,
      );
    // Resolve relative to the current hop, then re-validate before the next
    // hop is fetched: this is what stops a public URL from bouncing the
    // GET onto an internal host via a redirect the guard never saw.
    current = new URL(location, current);
    assertSafeThemeUrl(current);
  }
  return response;
}

export async function installThemeFromUrl(
  dir: string,
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string; file: ThemeFile }> {
  const response = await guardedFetch(url, fetchFn);
  if (!response.ok)
    throw new Error(`theme download failed: ${response.status}`);
  const body = await readCappedText(response, MAX_THEME_FILE_BYTES);
  let parsedTheme: unknown;
  try {
    parsedTheme = JSON.parse(body) as unknown;
  } catch {
    throw new Error("theme file is not valid JSON");
  }
  const file = validateThemeFile(parsedTheme);
  const { id } = await saveUserTheme(dir, file);
  return { id, file };
}

// --- Community gallery ------------------------------------------------------
//
// The gallery is a first-party GitHub repo whose index.json lists themes as
// { name, kind, file } where `file` is a repo-relative path. The install URL
// is built here as GALLERY_RAW_BASE + '/' + file, NOT taken from the entry as
// a full URL: this pins every gallery install to the gallery's own raw host
// and path, so even a compromised index can only reference files inside the
// (PR-reviewed, CI-validated) gallery repo — it can never point an install at
// an arbitrary or internal host. Each `file` is still validated against a
// strict pattern to block path traversal, and installs go through
// installThemeFromUrl, which re-validates content and re-runs the SSRF guard.

const GALLERY_RAW_BASE =
  "https://raw.githubusercontent.com/FaqFirebase/pi-desktop-themes/main";
const GALLERY_INDEX_URL = `${GALLERY_RAW_BASE}/index.json`;
// The index embeds each theme's full content for gallery preview cards, so
// its cap is a multiple of the single-file cap rather than equal to it.
const MAX_GALLERY_INDEX_BYTES = 1048576;
// Accepts both gallery layouts: the current per-theme folder form
// (themes/<slug>/theme.json) and the original flat form (themes/<slug>.json),
// so the app keeps working across the repo's layout migration. The character
// class has no '.', '/' or '\', so neither form can smuggle traversal or an
// absolute/other-host URL into the pinned base join.
const GALLERY_FILE_PATH = /^themes\/[a-z0-9-]+(?:\/theme)?\.json$/;
// An optional author screenshot lives beside the theme file. Only these exact
// shapes are ever fetched, so a poisoned index can at most reference an image
// already committed under themes/<slug>/ in the pinned repo.
const GALLERY_SCREENSHOT_PATH =
  /^themes\/[a-z0-9-]+\/screenshot\.(?:png|jpe?g|webp)$/;
const MAX_GALLERY_IMAGE_BYTES = 2097152;
// Content types allowed for a fetched screenshot. An allowlist, not an
// `image/` prefix: it keeps out image/svg+xml (SVG can carry script) and any
// other exotic image type even if the pinned path check were ever loosened.
const GALLERY_IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"];

// Untrusted display string from the gallery index: usable only when it is a
// non-empty string within the cap; anything else is treated as absent.
function displayText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
  return trimmed;
}

export async function fetchGalleryThemes(
  fetchFn: typeof fetch = fetch,
): Promise<GalleryTheme[]> {
  const response = await guardedFetch(GALLERY_INDEX_URL, fetchFn);
  if (!response.ok)
    throw new Error(`gallery index download failed: ${response.status}`);
  const body = await readCappedText(response, MAX_GALLERY_INDEX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("gallery index is not a JSON array");
  }
  if (!Array.isArray(parsed))
    throw new Error("gallery index is not a JSON array");

  const themes: GalleryTheme[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, kind, file, author, description, theme } = entry as Record<
      string,
      unknown
    >;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    if (kind !== "dark" && kind !== "light") continue;
    if (typeof file !== "string" || !GALLERY_FILE_PATH.test(file)) continue;

    // The embedded theme content and metadata come from the same untrusted
    // index bytes as everything else, so they get the full theme validator
    // (which also caps author/description). An entry whose embedded theme
    // fails validation is kept, but without a preview — installing it still
    // fetches and validates the canonical file, which is the real gate.
    let embedded: ThemeFile | undefined;
    try {
      embedded = theme === undefined ? undefined : validateThemeFile(theme);
    } catch {
      embedded = undefined;
    }
    const galleryTheme: GalleryTheme = {
      name,
      kind,
      url: `${GALLERY_RAW_BASE}/${file}`,
    };
    if (embedded) galleryTheme.theme = embedded;
    // Metadata: the embedded theme's own fields win (the file is the source
    // of truth); entry-level fields fill the gaps. Entry-level strings do not
    // pass through the theme validator, so cap them here the same way.
    galleryTheme.author =
      embedded?.author ?? displayText(author, MAX_THEME_AUTHOR_LENGTH);
    galleryTheme.description =
      embedded?.description ??
      displayText(description, MAX_THEME_DESCRIPTION_LENGTH);
    const { screenshot } = entry as Record<string, unknown>;
    if (
      typeof screenshot === "string" &&
      GALLERY_SCREENSHOT_PATH.test(screenshot)
    ) {
      galleryTheme.screenshotUrl = `${GALLERY_RAW_BASE}/${screenshot}`;
    }
    themes.push(galleryTheme);
  }
  return themes;
}

// Reads a response body as bytes, aborting once the cap is exceeded — the
// binary counterpart of readCappedText, for screenshots.
async function readCappedBytes(
  response: Response,
  limitBytes: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) {
      throw new Error(`screenshot too large (limit ${limitBytes} bytes)`);
    }
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw new Error(`screenshot too large (limit ${limitBytes} bytes)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Fetches an author screenshot and returns it as a data: URI (the renderer's
// CSP allows data: images but not remote hosts, so the fetch must happen here).
// The URL is re-pinned to the gallery base + screenshot path even though it
// was built here, and the response must actually be an image — the renderer
// hands the URL back over IPC, so it is treated as untrusted on the way in.
export async function fetchGalleryImage(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ dataUri: string }> {
  const prefix = `${GALLERY_RAW_BASE}/`;
  if (
    !url.startsWith(prefix) ||
    !GALLERY_SCREENSHOT_PATH.test(url.slice(prefix.length))
  ) {
    throw new Error("screenshot URL is not an allowed gallery path");
  }
  const response = await guardedFetch(url, fetchFn);
  if (!response.ok)
    throw new Error(`screenshot download failed: ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!GALLERY_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error(
      `screenshot is not an allowed image type (content-type: ${contentType || "none"})`,
    );
  }
  const bytes = await readCappedBytes(response, MAX_GALLERY_IMAGE_BYTES);
  return {
    dataUri: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
  };
}
