// Why a payment to an address is high risk, in words a renter reads (on
// the server and on screen).

export type AddressFlag = "maker_wallet" | "treasury" | "other_maker" | "crowded";

export const FLAG_WORDS: Record<AddressFlag, string> = {
  maker_wallet: "This address is a wallet of the agent's own maker: a payment here goes to the person who made the agent.",
  treasury: "This address is boardofserv's own treasury.",
  other_maker: "This address is a wallet of someone who makes agents on boardofserv.",
  crowded: "Renters of other agents have saved this same address too. Make sure it really is who you mean to pay.",
};
