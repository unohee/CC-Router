/** Who an OAuth access token belongs to, as Anthropic reports it. */
export interface OAuthProfile {
  email?: string;
  name?: string;
  organization?: string;
  tier?: string;
}

/**
 * GET /api/oauth/profile. Returns null when the token is refused or the call
 * fails — the caller decides whether that blocks anything.
 */
export async function fetchOAuthProfile(accessToken: string): Promise<OAuthProfile | null> {
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      account?: { email?: string; display_name?: string };
      organization?: { name?: string; rate_limit_tier?: string };
    };
    return {
      email: body.account?.email,
      name: body.account?.display_name,
      organization: body.organization?.name,
      tier: body.organization?.rate_limit_tier,
    };
  } catch {
    return null;
  }
}

/** One line for a person to check before a seat is replaced. */
export function describeProfile(p: OAuthProfile): string {
  const parts = [p.email ?? "unknown email", p.organization, p.tier].filter(Boolean);
  return parts.join(" · ");
}
