import type { AgentDefinition } from "../definition";
import { emptyBench } from "../types";
import { callKey } from "../../connections/reads";
import type { Recipe, RecipeFill } from "./types";

// A price alert: a coin's price from CoinGecko against the owner's target,
// a message when it crosses to the side they asked about, and none again
// until it has gone back (the offline suite's ETH watcher, as the catalog
// reads it). A comparison, not a judgement: no model call on a quiet run.

// CoinGecko's ids for the tickers makers write ("ETH" is "ethereum").
const TICKERS: Record<string, string> = { btc: "bitcoin", eth: "ethereum", sol: "solana", doge: "dogecoin", ada: "cardano", xrp: "ripple", bnb: "binancecoin", usdc: "usd-coin", usdt: "tether", dot: "polkadot", ltc: "litecoin", avax: "avalanche-2", link: "chainlink", trx: "tron" };
export function coinId(said: string): string {
  const id = said.trim().toLowerCase().replace(/\s+/g, "-");
  return TICKERS[id] ?? id;
}

const checkCode = [
  "async function run(input, tools) {",
  "  const s = input.settings || {};",
  `  const tickers = ${JSON.stringify(TICKERS)};`,
  '  const said = String(s.coin || "").trim().toLowerCase().replace(/\\s+/g, "-");',
  "  const coin = tickers[said] || said;",
  "  const goal = Number(s.target);",
  '  const above = String(s.direction || "").toLowerCase() === "above";',
  '  if (!coin || !Number.isFinite(goal)) return { price: null, price_way: "quiet" };',
  "  const got = await tools.coingecko.read({ coins: [coin] });",
  "  const found = (got && Array.isArray(got.prices) ? got.prices : []).find(function (p) { return p.coin === coin; });",
  '  if (!found) return { price: null, price_way: "quiet" };',
  "  const crossed = above ? found.price > goal : found.price < goal;",
  '  const side = crossed ? "crossed" : "clear";',
  '  const was = String((input.memory || {}).last_side || "clear");',
  '  if (side !== was) await tools.memory.set({ key: "last_side", value: side });',
  '  return { price: { coin: coin, price: found.price, change_24h: found.change_24h, goal: goal, above: above }, price_way: crossed && was !== "crossed" ? "alert" : "quiet" };',
  "}",
].join("\n");

const messageCode = [
  "async function run(input) {",
  "  const p = input.price;",
  "  if (!p) return { message: null };",
  '  const money = function (n) { return "$" + String(Math.round(Number(n) * 100) / 100); };',
  "  const name = p.coin.charAt(0).toUpperCase() + p.coin.slice(1);",
  '  const move = p.change_24h ? " (" + (p.change_24h > 0 ? "+" : "") + p.change_24h.toFixed(1) + "% in 24 hours)" : "";',
  '  return { message: { text: name + " is at " + money(p.price) + move + ", " + (p.above ? "above" : "below") + " your target of " + money(p.goal) + "." } };',
  "}",
].join("\n");

export const alert: Recipe = {
  id: "alert",
  fits: "watch a coin's or token's price (bitcoin, ethereum, any coin) and tell the owner when it goes below or above their target, once each time it crosses",
  asks: { coin: "CoinGecko's id for the coin, like bitcoin or ethereum", target: "the target price in US dollars", direction: "below or above" },
  uses: ["coingecko"],
  inferred: ["direction"],
  variants: [],
  task: { says: "nothing: it compares numbers, so leave it empty", byDefault: () => "" },
  build(f: RecipeFill) {
    const direction = /above/i.test(f.given.direction ?? "") ? "above" : f.given.direction ? "below" : undefined;
    const given = (key: string) => (f.given[key] ? { given: f.given[key] } : {});
    return {
      definition: {
        format: 1,
        name: f.name,
        job: { does: f.does, done: f.done },
        triggers: [f.trigger],
        settings: [
          { key: "coin", label: "Which coin", type: "text", help: "CoinGecko's id for it, like bitcoin or ethereum.", choices: [], ...given("coin") },
          { key: "target", label: "Your target price in US dollars", type: "number", help: "It tells you when the price crosses it.", choices: [], ...given("target") },
          { key: "direction", label: "Tell you when it goes", type: "choice", help: "Below your target, or above it.", choices: ["below", "above"], ...(direction ? { given: direction } : {}) },
        ],
        rules: [],
        memory: [{ key: "last_side", type: "text", description: "Whether the price had crossed the target at the last check, so it tells you once each time." }],
        services: ["coingecko"],
        steps: [
          {
            id: "check_price",
            kind: "code",
            title: "Check the price",
            plain: "Read the coin's price from CoinGecko and compare it with your target.",
            description: "Read the price of the coin in settings.coin with coingecko.read, compare it with settings.target in the direction of settings.direction, and note in memory.last_side whether it has crossed. Return price { coin, price, change_24h, goal, above } and price_way: alert when it has just crossed, else quiet.",
            inputs: ["settings", "memory"],
            outputs: ["price", "price_way"],
            shapes: { price: "{ coin: text, price: number, change_24h: number, goal: number, above: boolean }", price_way: "text" },
            tools: ["coingecko.read", "memory.set"],
            next: "crossed",
          },
          { id: "crossed", kind: "decision", title: "Has it just crossed your target?", prompt: "Has the price just gone past the owner's price?", from: "price_way", inputs: ["price_way"], outputs: [], outcomes: [{ id: "alert", label: "It just crossed", next: "write_alert" }, { id: "quiet", label: "Not yet", next: null }] },
          {
            id: "write_alert",
            kind: "code",
            title: "Write the alert",
            plain: "Write the price and your target in one line.",
            description: "Fill in one line from price: the name, the price, its change in 24 hours and the price it went past. Return message, telegram.send's arguments { text }.",
            inputs: ["price"],
            outputs: ["message"],
            shapes: { message: "{ text: text }" },
            tools: [],
            next: "send",
          },
          { id: "send", kind: "action", title: "Send it to you", plain: "Send it to you on Telegram.", action: "tell", inputs: ["message"], outputs: [], next: null },
        ],
        actions: [{ id: "tell", tool: "telegram.send", description: "Send you the price alert" }],
        limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.05 },
      },
      code: { check_price: checkCode, write_alert: messageCode },
    };
  },
  sample(d: AgentDefinition) {
    const bench = emptyBench();
    const setting = (k: string) => d.settings.find((s) => s.key === k)?.given;
    const coin = coinId(setting("coin") ?? "ethereum");
    const target = Number(setting("target")) > 0 ? Number(setting("target")) : 2000;
    const above = setting("direction") === "above";
    bench.settings = { coin, target, direction: above ? "above" : "below" };
    const price = Math.round(target * (above ? 1.08 : 0.92) * 100) / 100;
    bench.calls = { [callKey("coingecko.read", { coins: [coin] })]: { prices: [{ coin, price, change_24h: above ? 4.2 : -3.6, market_cap: 1_000_000_000 }] } };
    return { bench, items: { noun: "price", plural: "prices", labels: [`${coin} at $${price}`] } };
  },
};
