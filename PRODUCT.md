# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner and sole operator of the router. They run it on an always-on host, point their
coding agents (Claude Code, Codex CLI) at it, and share a pool of subscription accounts across those
agents. They are not watching it. They glance at it between other work and dig in only when something
looks wrong.

Two viewing contexts, confirmed:

- **`cc-router status` (terminal UI)**: mostly inside a tmux window split 2x2 or 2x3, next to other
  panes. It is often seen clipped. The pane, not the full screen, is the real canvas.
- **Web page at `/cc-router/dashboard`**: opened in a browser for the same question plus token history.
  Phone-width layouts are supported; how often a phone is actually used is not confirmed.

## Product Purpose

CC-Router lets several Claude Max and OpenAI ChatGPT/Codex subscription accounts act as one pool behind
a single local endpoint, so the operator's agents keep working while individual accounts hit 5-hour and
7-day limits. The two status surfaces exist so the operator can answer one question quickly: **is
anything wrong right now?** (an account cooling down, a burst of 429s, a quota window about to run out).
Success is that a healthy pool is quiet and a problem is unmistakable within about three seconds, without
reading the whole screen.

## Positioning

It routes by subscription quota rather than by key: sessions stay pinned to one account to keep its
prompt cache warm, and are moved before an account runs dry. The status surfaces therefore carry
quota-window state (5h / 7d utilization and reset times) that a generic proxy dashboard has no reason to
show.

## Operating Context

- The router runs on a long-lived host (systemd user unit); the operator's workstation reads it remotely.
  `cc-router status` runs in client mode against the router's `/cc-router/health`.
- The terminal UI is interactive (account focus, enable/disable, per-account caps, add/delete, model
  selection, selecting a log row for details) and is meant to stay open all day.
- The web page is read-only, refreshes every few seconds, and is served without the proxy secret.
- Quota and rate-limit numbers come from upstream response headers; an account that has not served a
  request since the router started has no reading yet.

## Capabilities and Constraints

- Data on hand per account: provider, status/cooldown, request and error counts, token expiry, last-used
  time, 5-hour and 7-day utilization with reset time. Pool-wide: request, error, refresh and token
  totals, cache hit ratio, a 20-entry (terminal) / 100-entry (server buffer) recent-activity log with
  per-request detail, and, on the web only, 90 days of hourly token history by model.
- **Web page constraints**: one inline script and one inline style under a sha256 CSP, no inline
  `style=""` attributes, DOM built with `textContent` only, no third-party assets, works with
  forced-colors, light and dark.
- **"No reading" is a real state, not zero.** Unmeasured values show as "no reading" / "not measured
  yet"; a fake 0% is never acceptable. Recorded-zero and no-data are also distinct in the history grid.
- **Terminal constraints**: Ink (React) renderer; must tolerate arbitrary pane sizes and not rely on a
  full-screen terminal. The current layout is not height-aware (fixed 20 log rows plus a details box) and
  not width-aware; this is a known defect, not a design choice.
- Undecided: whether the web page and the terminal UI should show the same information in the same
  order, or deliberately different jobs.

## Evidence on Hand

- `assets/dashboard.png` (README screenshot of the web page).
- The live router's real health and usage-history data (read through `/cc-router/health` and
  `/cc-router/usage-history`); no usability research, analytics, or user quotes exist and none should be
  invented.

## Product Principles

1. **Quiet when healthy, loud when not.** A normal pool should look uneventful; abnormal state is the
   first thing seen, not a row to be found.
2. **Answer "is anything wrong?" before showing totals.** Cumulative counters and history are context,
   not the headline.
3. **Honest about what is unknown.** Missing readings say so; nothing is rounded to a reassuring zero.
4. **The canvas is whatever pane it lands in.** Surfaces degrade by dropping detail in a stated order,
   never by clipping the part that matters.
5. **One operator, one glance.** Optimize for a trained eye returning every few minutes, not for
   onboarding or persuasion.

## Accessibility & Inclusion

Web page: honors `prefers-color-scheme` and forced-colors, and status words and symbols accompany color
(existing behavior, kept). Terminal: legibility without relying on color is assumed, not user-stated
(inferred). No further product-specific requirement has been established.
