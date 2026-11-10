// How long an answer each kind of model call may give (its max_tokens), in
// one place. SERV checks a call against the account's credit by the limit
// sent, not by what the answer uses, so each limit is sized to what its
// answer needs, with room: a call that asks for far more than it needs can
// be refused for credit it would never have spent. Too small is no better:
// servpit measured SERV answering empty, after about three seconds, when the
// limit was too small for the answer (a lender's judgement failed at 120 and
// 400 and answered at 800), so none is cut close.
//
// The measured answers are completion tokens from the live runs of phases 6
// to 8 (docs: the PR bodies). The limits for the chat, the plan call before
// a reply, a helper's instructions and an agent's plan can still be set by
// the environment (CHAT_MAX_TOKENS, SKETCH_MAX_TOKENS, COMPILE_MAX_TOKENS,
// AGENT_PLAN_MAX_TOKENS).

export const ANSWER_LIMITS = {
  // A reply in the chat, and a published helper's answer: what a person reads.
  chat: 700,
  helper_use: 700,
  // The small plan call before a reply (which kind of helper, what's missing).
  sketch: 320,
  // A published helper's instructions.
  compile: 600,
  // An agent's whole plan: every step, rule and question.
  agent_plan: 3500,
  // Dolphin writing one step's code (not SERV).
  code: 4000,
  // SERV's review of one step's code: measured 59 to 63.
  code_review: 300,
  // The review before publishing, a list of findings: measured 8 to 72.
  publish_review: 400,
  // A decision in a run: one outcome and a short reason, measured 20 to 32.
  decision: 160,
  // The safety check before an action: allow, ask or block, and why.
  guard: 160,
  // Screening what a run reads: a verdict, an excerpt and a reason.
  screen: 200,
  // Screening a listing, request or offer: ok or hold and a reason,
  // measured 27 to 30.
  post_screen: 120,
  // Checking a person's own SERV key: the answer is never read.
  key_check: 1,
} as const;

export type ModelPurpose = keyof typeof ANSWER_LIMITS;

export const MODEL_PURPOSES = Object.keys(ANSWER_LIMITS) as ModelPurpose[];
