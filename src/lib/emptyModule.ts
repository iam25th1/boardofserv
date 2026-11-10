// What the two Solana-only packages Privy 3 imports resolve to in the
// bundle (see PRIVY_SOLANA_ONLY in next.config.mjs). The app has no Solana,
// so nothing here is ever called; the bundler only needs the name Privy
// imports to exist.
export function getTransferSolInstruction(): never {
  throw new Error("Solana isn't part of boardofserv.");
}
