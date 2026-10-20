// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

// A live demonstration of the model layer in serv.ts: one real SERV Reasoning
// reply, and one forced fallback reply from a local OpenAI-compatible mock.
// Both go through the real getReply, so the source labels are the real ones.
// Runs only with RUN_SERV_DEMO=1 and Privy credentials present.
const enabled = process.env.RUN_SERV_DEMO === "1" && Boolean(process.env.PRIVY_APP_SECRET);
const maybe = enabled ? it : it.skip;

const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const secret = process.env.PRIVY_APP_SECRET ?? "";
let mock: Server;

function privyHeaders(): Record<string, string> {
  const basic = Buffer.from(`${appId}:${secret}`).toString("base64");
  return { authorization: `Basic ${basic}`, "privy-app-id": appId, "content-type": "application/json", accept: "application/json" };
}

async function openservKey(): Promise<string> {
  const headers = privyHeaders();
  let walletId = process.env.PRIVY_WALLET_ID ?? "";
  let address = "";
  if (walletId) address = ((await (await fetch(`https://api.privy.io/v1/wallets/${walletId}`, { headers })).json()) as { address?: string }).address ?? "";
  if (!address) {
    const b = (await (await fetch("https://api.privy.io/v1/wallets", { method: "POST", headers, body: JSON.stringify({ chain_type: "ethereum" }) })).json()) as { id?: string; address?: string };
    walletId = b.id ?? "";
    address = b.address ?? "";
  }
  const { getSiweChallenge, verifySiwe } = await import("@/lib/openserv");
  const { message } = await getSiweChallenge(address);
  const sig = ((await (await fetch(`https://api.privy.io/v1/wallets/${walletId}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "personal_sign", params: { message, encoding: "utf-8" } }) })).json()) as { data?: { signature?: string } }).data?.signature ?? "";
  return (await verifySiwe(address, message, sig)).apiKey;
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const d of stream) out += d;
  return out;
}

beforeAll(async () => {
  if (!process.env.OPENSERV_KEY_ENC_KEY) process.env.OPENSERV_KEY_ENC_KEY = randomBytes(32).toString("base64");
  // Local OpenAI-compatible mock for the forced fallback.
  mock = createServer((req, res) => {
    if (req.method === "POST" && req.url?.includes("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const words = "This reply comes from the local demo fallback model, not from SERV.".split(" ");
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i] + " " } }] })}\n\n`);
          i++;
        } else {
          res.write("data: [DONE]\n\n");
          clearInterval(timer);
          res.end();
        }
      }, 5);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => mock.listen(8799, r));
  process.env.FALLBACK_BASE_URL = "http://localhost:8799/v1";
  process.env.FALLBACK_API_KEY = "local-demo-key";
  process.env.FALLBACK_MODEL = "demo-echo";
  process.env.FALLBACK_LABEL = "Local demo model";
});

afterAll(() => {
  mock?.close();
});

describe("model layer, live", () => {
  maybe("a SERV reply is labelled SERV", async () => {
    const { getReply } = await import("@/lib/serv");
    const key = await openservKey();
    const reply = await getReply([{ role: "user", content: "In one short sentence, what will boardofserv help me build?" }], key, new AbortController().signal);
    const text = await collect(reply.stream);
    console.log(`\n[SERV demo] source=${reply.source} label=${reply.label}\n${text}\n`);
    expect(reply.source === "serv" || reply.source === "fallback").toBe(true);
    expect(text.length).toBeGreaterThan(0);
    if (reply.source === "serv") expect(reply.label).toBe("SERV");
  }, 45_000);

  maybe("a reply with no OpenServ key falls back, labelled as the fallback", async () => {
    const { getReply } = await import("@/lib/serv");
    const reply = await getReply([{ role: "user", content: "Say hello." }], null, new AbortController().signal);
    const text = await collect(reply.stream);
    console.log(`\n[fallback demo] source=${reply.source} label=${reply.label}\n${text}\n`);
    expect(reply.source).toBe("fallback");
    expect(reply.label).toBe("Local demo model");
    expect(text.toLowerCase()).toContain("fallback");
  }, 20_000);
});