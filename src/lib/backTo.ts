// Where a page may send someone back to once they are done there (Connect
// Typeform from the chat goes back to the same chat): a path inside the
// app, never another site.
export function backTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const path = raw.trim();
  if (!path.startsWith("/app/") || path.startsWith("//") || /[\\\s]|\/\/|:/.test(path.split("?")[0]!)) return null;
  return path.slice(0, 500);
}
