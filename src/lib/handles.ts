// Handles: a user's public name, shown with an @ in front on the board and on
// helper pages. 3 to 20 lower case letters, digits and underscores, unique
// ignoring case, and none of a few reserved words. Typed in any case or with
// a leading @, a handle is kept in lower case without it.
//
// Shared by the browser (to say what is wrong while typing) and the server
// (which decides).

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const RESERVED_HANDLES = ["admin", "board", "serv", "boardofserv", "support", "help"];
export const HANDLE_TAKEN = "That handle is taken.";

export function normalHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

// Why a (normal) handle can't be used, or null when it can, if no one has it.
export function handleProblem(handle: string): string | null {
  if (!/^[a-z0-9_]*$/.test(handle)) return "Use only letters, numbers and underscores.";
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) return `Use ${HANDLE_MIN} to ${HANDLE_MAX} characters.`;
  if (RESERVED_HANDLES.includes(handle)) return "That handle is reserved.";
  return null;
}
