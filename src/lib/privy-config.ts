// The Privy app id the browser uses, or null when sign-in is not set up.
// Privy rejects any id that is not 25 characters long, and it does so by
// throwing while it renders, which would break the build. So the same rule
// decides here: a missing id, the CI placeholder ("ci-placeholder") or any
// other id Privy would refuse means Privy is never mounted.
const PRIVY_APP_ID_LENGTH = 25;

export function privyAppId(raw: string | undefined = process.env.NEXT_PUBLIC_PRIVY_APP_ID): string | null {
  return raw && raw.length === PRIVY_APP_ID_LENGTH ? raw : null;
}
