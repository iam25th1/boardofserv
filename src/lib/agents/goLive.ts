import "server-only";
import type { Agent, AgentVersion, User } from "../db/schema";
import type { ConnectAnswers } from "../journey";
import { setListing } from "../market/listings";
import { offerVersion } from "../market/versions";
import { paymentsConfig } from "../payments/config";
import { priceProblem } from "../payments/uses";
import { activeFreeze } from "../safety/freeze";
import { screenListing } from "../safety/moderation";
import { PayeeRefused, savePayee } from "../spending/payees";
import type { InstallationDTO, MakerListingDTO } from "../types";
import { REVIEW_BLOCKED, REVIEW_DOWN, vetVersion } from "./publish";
import type { Runtime } from "./runtime/context";
import { install, installationDTO, InstallRefused, loadInstallation } from "./runtime/installations";
import { draftOf, publishDraft, updateDraft, versionsOf } from "./store";
import { liveDiagnosis } from "./diagnosis";
import type { Diagnosis } from "./types";

// Go live, from the chat: the steps the maker built and tried become a
// version that never changes (with the code review every version gets),
// then either run for the maker with what they gave at Connect, or go on
// the board for others to rent. Refusals say why in plain words.

export class NotLive extends Error {
  constructor(
    message: string,
    readonly status = 409,
    // What the review before going live found, for the build to heal.
    readonly diagnosis: Diagnosis | null = null,
  ) {
    super(message);
  }
}

// The version it goes live with: the draft, published now, or the newest
// published one when nothing has changed since. Publishing a version is
// not putting it on the board: only "Put it on the board" moves the
// board's listing to it and offers it to renters (offer).
export async function publishedFor(rt: Runtime, user: User, agent: Agent, o: { offer: boolean }): Promise<AgentVersion> {
  const draft = await draftOf(agent.id);
  if (!draft) {
    const published = (await versionsOf(agent.id)).find((v) => v.state === "published");
    if (!published) throw new NotLive("There's nothing built to put live yet.");
    return published;
  }
  if (!draft.definition) throw new NotLive("There are no steps yet.");
  if (draft.buildState !== "idle") throw new NotLive("Wait for it to finish building.");
  if (draft.definition.steps.some((s) => s.kind === "code" && draft.code[s.id]?.status !== "approved")) throw new NotLive("Some of its steps aren't built yet.");
  if (draft.testResult?.status !== "passed") throw new NotLive("Try it first: it goes live once its test passes.");
  const frozen = await activeFreeze(rt, { agentId: agent.id, makerId: user.id });
  if (frozen) throw new NotLive(`It can't go live now: boardofserv froze it. ${frozen.reason}`);
  const review = await vetVersion(rt, user, draft);
  if (review.status === "unreviewed") throw new NotLive(REVIEW_DOWN, 503);
  if (review.status === "blocked") throw new NotLive(`${REVIEW_BLOCKED} ${review.findings.find((f) => f.severity === "blocking")?.finding ?? ""}`.trim(), 409, liveDiagnosis(draft.definition, review.findings, draft.code));
  const published = await publishDraft(agent.id);
  if (!published) throw new NotLive("It couldn't go live just now. Try again.");
  if (o.offer) await offerVersion(rt, agent.id, published);
  return published;
}

// Run it for me: the maker's own copy, live from now, with their answers
// and, for an agent that pays, the payee it pays. Running never publishes:
// what is on the board, and what renters run, stay as they were.
export async function runForMaker(rt: Runtime, user: User, agent: Agent, answers: ConnectAnswers): Promise<InstallationDTO> {
  const version = await publishedFor(rt, user, agent, { offer: false });
  try {
    const row = await install(rt, { ownerUserId: user.id, agent, version, answers: { settings: answers.settings, rules: answers.rules, timezone: answers.timezone, schedule: answers.schedule ?? null }, live: true });
    if (answers.payee) await savePayee(rt, user, row.id, answers.payee);
    const loaded = await loadInstallation(rt, row.id);
    return installationDTO(rt, loaded!);
  } catch (err) {
    if (err instanceof InstallRefused || err instanceof PayeeRefused) throw new NotLive(err.message, 400);
    throw err;
  }
}

// Whole USDC as typed ("2", "0.50"), in minor units, or null when it isn't
// an amount.
export function usdcUnits(text: string): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

// Put it on the board: its description as the maker last worded it, a
// weekly price (free is 0), screened before it shows.
export async function putOnBoard(rt: Runtime, user: User, agent: Agent, o: { weeklyPrice: string; description: string }): Promise<MakerListingDTO> {
  const price = usdcUnits(o.weeklyPrice || "0");
  if (price === null) throw new NotLive("Give a weekly price in USDC, like 2 or 0.50, or 0 for free.", 400);
  if (price > 0n && !paymentsConfig().enabled) throw new NotLive("Payments aren't on here yet, so it can only go on the board for free.", 400);
  const problem = price > 0n ? priceProblem("USDC", price) : null;
  if (problem) throw new NotLive(problem, 400);
  const description = o.description.replace(/\s+/g, " ").trim().slice(0, 400);
  const draft = await draftOf(agent.id);
  if (draft?.definition && description && description !== draft.definition.job.does) await updateDraft(draft.id, { definition: { ...draft.definition, job: { ...draft.definition.job, does: description } } });
  const version = await publishedFor(rt, user, agent, { offer: false });
  const listing = await setListing(rt, agent, { weeklyPrice: price, jobFee: 0n, listed: true });
  if (!listing) throw new NotLive("It couldn't go on the board just now. Try again.");
  // The board's listing and its renters move to it now, and only now: a
  // version published earlier for the maker's own use included.
  await offerVersion(rt, agent.id, version);
  await screenListing(rt, user, agent.id);
  return listing;
}
