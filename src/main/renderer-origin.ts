import { join } from "path";
import { pathToFileURL } from "url";

/**
 * The only file the main window is allowed to load/navigate to in production,
 * and the only frame URL that privileged IPC accepts as a sender. Its preload
 * exposes terminal + full IPC, so this must stay pinned to the packaged renderer.
 */
export const RENDERER_INDEX_PATH = join(__dirname, "../renderer/index.html");

/**
 * True when `frameUrl` belongs to the app's own renderer: the dev server's exact
 * origin in development, or the packaged index file (ignoring hash/query used by
 * client-side routing) in production. Parses the URL so a look-alike host or a
 * sibling local file cannot pass a naive string-prefix check.
 */
export function isTrustedRendererUrl(
  frameUrl: string,
  opts: { devServerUrl?: string; rendererIndexPath: string },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(frameUrl);
  } catch {
    return false;
  }
  if (opts.devServerUrl) {
    try {
      return parsed.origin === new URL(opts.devServerUrl).origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol !== "file:" || parsed.username || parsed.password)
    return false;
  try {
    const expectedUrl = pathToFileURL(opts.rendererIndexPath);
    const caseInsensitive = process.platform === "win32";
    const normalize = (value: string): string =>
      caseInsensitive ? value.toLowerCase() : value;
    // A UNC renderer path has a meaningful file URL host; a local path must
    // keep an empty host. Comparing it prevents a different network share from
    // being accepted merely because its pathname happens to match.
    if (normalize(parsed.host) !== normalize(expectedUrl.host)) return false;

    const expected = expectedUrl.pathname;
    const actual = parsed.pathname;
    const nativeMatch = normalize(actual) === normalize(expected);
    if (nativeMatch) return true;
    // On a Windows test seam a POSIX-looking fixture path is converted to a
    // drive-qualified URL by pathToFileURL, while the incoming URL stays POSIX.
    // Keep this compatibility branch limited to Windows and compare using the
    // platform's actual case rules.
    if (
      caseInsensitive &&
      opts.rendererIndexPath.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/.test(opts.rendererIndexPath)
    ) {
      return (
        normalize(decodeURIComponent(actual)) ===
        normalize(opts.rendererIndexPath.replace(/\\/g, "/"))
      );
    }
    return false;
  } catch {
    return false;
  }
}
