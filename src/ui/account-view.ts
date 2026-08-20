/** Shape the dashboard needs to label an account; a subset of the health view. */
export interface AccountTagInput {
  provider?: "anthropic_subscription" | "openai_subscription";
  rateLimits?: { plan: string };
}

/**
 * Fixed column width for the provider tag. The dashboard lays rows out by
 * padding, so a tag wider than this would shift every column after it.
 */
export const PROVIDER_TAG_WIDTH = 14;

/**
 * The bracketed label after an account's status.
 *
 * Anthropic accounts show their plan alone ("[Max 20x]") because the provider
 * is the unmarked default. OpenAI accounts name the provider, and append the
 * plan when Codex reported one — the plan arrives in response headers, so it is
 * absent until that account has served a request.
 */
export function accountProviderTag(account: AccountTagInput): string {
  const plan = account.rateLimits?.plan?.trim();
  if (account.provider === "openai_subscription") {
    return plan ? ` [OpenAI ${plan}]` : " [OpenAI]";
  }
  return plan ? ` [${plan}]` : "";
}

/** The tag padded to its column, truncated rather than allowed to overflow. */
export function paddedProviderTag(account: AccountTagInput): string {
  return accountProviderTag(account).slice(0, PROVIDER_TAG_WIDTH).padEnd(PROVIDER_TAG_WIDTH);
}
