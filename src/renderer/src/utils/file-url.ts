function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Build a file URL without treating path characters like #, ?, or % as URI syntax. */
export function toFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");

  // UNC paths use the host portion after the double slash.
  if (normalized.startsWith("//")) {
    return `file://${encodePathSegments(normalized.slice(2))}`;
  }

  // Keep the colon in a Windows drive prefix; encode every path segment after it.
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2);
    return `file:///${drive}${encodePathSegments(normalized.slice(2))}`;
  }

  if (normalized.startsWith("/")) {
    return `file://${encodePathSegments(normalized)}`;
  }

  return `file:///${encodePathSegments(normalized)}`;
}
