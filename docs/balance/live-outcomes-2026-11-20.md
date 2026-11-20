# Live outcomes vs the simulator, 2026-11-20

Measured: health `balance.seats[].outcomes` from build d45639b, fetched 2026-11-20T08:59:00Z, over the last 7 days (saved as `docs/balance/capture-2026-11-20/health.json`).
Predicted: scenario `live-week` (start 2026-11-19T09:00:00.000Z, 2 days) simulated under policy d45639b (#54; placement as of PR #49–#52) for the 24 h that had elapsed at the fetch, seed 3101 with a band over seeds 3101–3108; soft cap 98%.

## Seats with a weekly reset

### rigel

- Measured: 1 reset, 2% of the week left unused at it, 793 stranded minutes.
- Predicted: 1 reset, 2% unused (seeds 2–2%), 780 stranded minutes (seeds 780–780).
- Unused share: within (measured − predicted +0 points).
- Stranded minutes: OUTSIDE (measured − predicted +13 min).
- From the scenario's start on (router rows): 778 stranded minutes (15 before it), reset 2026-11-19T22:00:00.000Z at 98% (2% unused): OUTSIDE (-2 min).

### lyra

- Measured: 1 reset, 3% of the week left unused at it, 1393 stranded minutes.
- Predicted: 1 reset, 2% unused (seeds 2–2%), 956 stranded minutes (seeds 956–1125).
- Unused share: within (measured − predicted +1 points).
- Stranded minutes: OUTSIDE (measured − predicted +437 min).
- From the scenario's start on (router rows): 1378 stranded minutes (15 before it), reset 2026-11-20T08:00:00.000Z at 97% (3% unused): OUTSIDE (+422 min).

## Every seat

| seat | resets | unused at reset | stranded min | predicted resets | predicted unused | predicted stranded (band) | unused | stranded |
|---|---|---|---|---|---|---|---|---|
| heewon | 0 | none | 0 | 0 | none | 0 (0–0) | no verdict | within |
| vega | 0 | none | 0 | 0 | none | 0 (0–0) | no verdict | within |
| rigel | 1 | 2% | 793 | 1 | 2% | 780 (780–780) | within | OUTSIDE |
| lyra | 1 | 3% | 1393 | 1 | 2% | 956 (956–1125) | within | OUTSIDE |
| kyte | 0 | none | 0 | 0 | none | 0 (0–0) | no verdict | within |

Pool: measured 2 resets, 2.5% unused share, 2186 stranded seat-minutes; predicted 2 resets, 2% unused share, 1736 stranded seat-minutes (seeds 1736–1905).

## How the error is judged

- Unused share: within when the measured share, in whole hundredths, lies in [min - 1, max + 1] of the seed band: readings are hundredths, so two readings of one true share can differ by one.
- Stranded minutes: within when the measured minutes lie in [min - 1, max + 1] of the seed band: each side adds one minute per tick and the ticks do not line up.
- The measured outcomes cover health's window (7 days) and may include minutes recorded before the scenario's start; the simulated ones start at it. The router's own rows (`docs/balance/capture-2026-11-20/quota-outcomes.json`) give the minutes from the start on, judged on the same band.

## Notes

- The router's first stranded row is the 08:00Z hour of the 19th with 15 minutes: outcomes have been recorded since about 08:45Z that day (the run-2 deploy), 15 minutes before the scenario's start, when rigel and lyra were already at the cap. Health's figures carry those 15 minutes; the from-the-start figures do not.
- lyra's reset row carries 97% from its last hourly reading, while the stranded judgment read the pool's live value at or past the 98% cap: the hundredth between them is the reading's age, not quota left. Both seats stopped at the soft cap; the 2% they leave is the cap.
- lyra's stranded minutes miss because of the captured starting state, not placement: the scenario starts lyra at 97% from a reading four hours old, so the simulated seat reaches the cap hours into the run, while the live seat was at the cap from the first minute (59 minutes stranded in the 09:00Z hour).
- rigel from the start on: 778 measured against 780 predicted. The 09:00Z and 10:00Z hour buckets hold 59 minutes each, around the deploys of #52, #53 and #54; a supervisor handoff can skip one tick.
