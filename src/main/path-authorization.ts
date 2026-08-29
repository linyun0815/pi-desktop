import { basename, dirname, isAbsolute, relative, resolve } from "path";
import { realpathSync } from "fs";

/**
 * True when `candidate` resolves to `root` itself or a path nested inside it.
 * Uses a lexical `relative` comparison (resolving `..` first) so parent-traversal
 * escapes and sibling directories that merely share the root's string prefix
 * (e.g. `/a/project-secrets` vs `/a/project`) are rejected. Platform path rules
 * (case-insensitivity, separators, cross-drive on Windows) come from `path`.
 */
export function isPathWithin(root: string, candidate: string): boolean {
 const resolvedRoot = resolve(root);
 const resolvedCandidate = resolve(candidate);
 if (resolvedCandidate === resolvedRoot) return true;
 const rel = relative(resolvedRoot, resolvedCandidate);
 return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Authorize a path for the attachment reader. A path is allowed only if the user
 * picked it through the native open dialog (tracked in `approvedPaths`, stored
 * pre-resolved) or it lives inside the active workspace. This keeps a compromised
 * renderer from reading arbitrary files (e.g. `~/.ssh/id_rsa`) via the reader.
 */
function realpathSyncDeepest(path: string): string | null {
 let current = resolve(path);
 const tail: string[] = [];
 for (;;) {
  try {
   const real = realpathSync(current);
   return tail.length > 0 ? resolve(real, ...[...tail].reverse()) : real;
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
   const parent = dirname(current);
   if (parent === current) return resolve(path);
   tail.push(basename(current));
   current = parent;
  }
 }
}

export function isAuthorizedAttachmentPath(
 candidate: string,
 opts: { workspaceRoot: string | null; approvedPaths: ReadonlySet<string> },
): boolean {
 const resolved = resolve(candidate);
 // A native file picker is an explicit user grant, even when the selected file
 // is outside the active workspace. Keep this check lexical and exact.
 if (opts.approvedPaths.has(resolved)) return true;
 if (!opts.workspaceRoot) return false;

 // Workspace paths are not trusted merely because their spelling is nested:
 // a symlink inside the workspace can point at a sensitive file elsewhere.
 const realRoot = realpathSyncDeepest(opts.workspaceRoot);
 const realCandidate = realpathSyncDeepest(resolved);
 return (
  realRoot !== null &&
  realCandidate !== null &&
  isPathWithin(realRoot, realCandidate)
 );
}
