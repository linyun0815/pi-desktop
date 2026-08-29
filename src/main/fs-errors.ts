/**
 * Translate low-level filesystem write failures into actionable messages.
 *
 * On Windows, the most common cause of a denied write to a project file is
 * Controlled Folder Access (the "Ransomware protection" feature), which
 * silently blocks untrusted apps from modifying files under Documents,
 * Desktop, Pictures, etc. The raw EPERM/EACCES it produces is opaque, so we
 * rewrite it into a message that tells the user exactly how to resolve it.
 */

const IS_WINDOWS = process.platform === "win32";

// Codes Windows raises when a write is blocked by Controlled Folder Access
// or an ordinary permission/lock denial.
const BLOCKED_WRITE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

interface ErrnoLike {
 code?: string;
}

function errorCode(err: unknown): string | undefined {
 if (typeof err === "object" && err !== null) {
  const code = (err as ErrnoLike).code;
  if (typeof code === "string") return code;
 }
 return undefined;
}

/**
 * Return an Error suitable for surfacing to the user. When a write is blocked
 * on Windows, the message explains Controlled Folder Access and the two fixes;
 * otherwise the original error is preserved.
 */
export function describeWriteError(err: unknown, filePath: string): Error {
 const code = errorCode(err);
 if (IS_WINDOWS && code !== undefined && BLOCKED_WRITE_CODES.has(code)) {
  return new Error(
   `无法写入“${filePath}”（${code}）。在 Windows 上，这通常是“受控文件夹访问”（勒索软件防护）阻止了更改。` +
    "请在 Windows 安全中心 → 病毒和威胁防护 → 勒索软件防护 → “允许应用通过受控文件夹访问”中允许 Pi Desktop，" +
    "或将此项目移出 Documents/Desktop，放到未受保护的文件夹（例如 C:\\dev）。",
  );
 }
 return err instanceof Error ? err : new Error(String(err));
}
