import "server-only";

// A canned reply for local development when no model is set up at all. It is
// only imported behind a NODE_ENV === "development" check in model.ts, so a
// production build never contains it (src/test/demo-unreachable.test.ts).

export const DEMO_LABEL = "Demo reply";
export const DEMO_TEXT =
  "This is a demo reply from the boardofserv development build. No model is set up, so nothing real answered. " +
  "Add SERV_API_KEY to .env.local and restart to talk to SERV Reasoning.";

export async function* demoStream(signal: AbortSignal): AsyncGenerator<string> {
  for (const part of DEMO_TEXT.match(/\S+\s*/g) ?? [DEMO_TEXT]) {
    if (signal.aborted) return;
    yield part;
    await new Promise((r) => setTimeout(r, 15));
  }
}
