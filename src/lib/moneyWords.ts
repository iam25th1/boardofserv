// What the money on screen is, while boardofserv is a beta: test USDC on
// Base Sepolia, worth nothing. (On mainnet, which this build never turns
// on, it would be plain USDC on Base.)

export interface MoneyKind {
  network: string;
  test: boolean;
}

export const BETA_MONEY: MoneyKind = { network: "Base Sepolia", test: true };

export const moneyName = (m: MoneyKind = BETA_MONEY) => (m.test ? `test USDC on ${m.network}` : `USDC on ${m.network}`);

// A line under amounts.
export const moneyNote = (m: MoneyKind = BETA_MONEY) => (m.test ? `Amounts here are ${moneyName(m)}, worth nothing while boardofserv is a beta.` : `Amounts here are ${moneyName(m)}.`);
