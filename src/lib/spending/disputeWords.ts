// What a renter reads about disputes, on the server and on screen.

export const DISPUTE_REASONS = ["not_done", "not_wanted", "wrong_amount", "wrong_payee", "not_working", "other"] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export const DISPUTE_REASON_WORDS: Record<DisputeReason, string> = {
  not_done: "It paid for something that wasn't done",
  not_wanted: "I didn't want this payment made",
  wrong_amount: "It paid the wrong amount",
  wrong_payee: "It paid the wrong payee",
  not_working: "The agent didn't work that week",
  other: "Something else",
};

export const REASONS_FOR: Record<"payment" | "rent", readonly DisputeReason[]> = {
  payment: ["not_done", "not_wanted", "wrong_amount", "wrong_payee", "other"],
  rent: ["not_working", "other"],
};

export const CANT_PULL_BACK = "A payment on Base can't be pulled back once it is sent. If your dispute is upheld, it counts against the agent's trust score, but the money stays with the payee.";
export const RENT_REFUND = "If your dispute is upheld, the week's rent comes back to your balance.";

export const NOTE_MIN = 10;
export const NOTE_MAX = 1000;
