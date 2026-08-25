# Deadlock stats rate-limit optimization plan

Status: implemented in source; automated contracts pass; live browser and Panorama verification remain

Confidence: 9/10

This plan covers both GitHub Pages surfaces:

- `index.html`, the browser explorer
- `bridge.html`, the one-shot Panorama HTML bridge

The plan preserves the profile's Ranked and Standard modes, its 50, 100, and 150 match choices, the explorer's 25, 50, 100, and 200 choices, the title protocol, the visible statistics, and raw response inspection for live network results.

## Why confidence is not 10/10

Two changes still require live proof:

1. A reduced metadata query must produce the same 12 player metrics as the current query.
2. Cross-page request coordination must work in both normal Chrome and Deadlock's embedded HTML browser.

The external API also has a global quota. No client implementation can guarantee that a global 429 will never occur.

## Goals

- Cut bulk metadata requests, which have the restrictive quota.
- Reuse account-independent community results.
- Stop retries while the API says to wait.
- Preserve useful stale results during outages and rate limits.
- Keep the bridge one-shot. It must not poll or run while the custom profile view is closed.
- Bound browser storage, response memory, and DOM work.
- Keep API keys out of public GitHub Pages code.

## Non-goals

- Do not change the visible match-count semantics.
- Do not replace the 50, 100, and 150 profile choices with time windows.
- Do not add a server, service worker, build system, or client API key in the first implementation.
- Do not bundle the static modules for performance. The deployed page transferred about 26 KB of static resources during the audit, so bundling would solve the wrong problem.
- Do not prefetch profiles or filter combinations the user has not requested.

## Grounded API facts

### Bulk metadata

`/v1/matches/metadata` documents these limits:

- IP: 10 requests per minute
- API key: 10 requests per 10 seconds
- Global: 100 requests per minute

The route supports an ordered result with a limit up to 10,000. Filtering by one account and one mode, ordering by `start_time desc`, and requesting 150 or 200 rows provides a stable response from which smaller prefixes can be calculated locally.

### Player analytics

`/v1/analytics/player-stats/metrics` documents these shared analytics limits:

- IP: 200 requests per minute
- API key: 400 requests per minute
- Global: 2,000 requests per minute

The route caches identical query results for one hour. Its HTTP response advertises 10 minutes of freshness and 20 minutes of stale-while-revalidate.

The route's `max_matches` behavior is not player-centric. The server selects the latest N matches globally before applying `account_ids`. Therefore this is not equivalent to the player's latest N matches:

```text
/player-stats/metrics?account_ids=<account>&max_matches=150
```

Do not use that shortcut.

### Rate-limit response data

Successful and rate-limited responses expose:

```text
RateLimit-Limit
RateLimit-Period
RateLimit-Remaining
RateLimit-Reset
Retry-After
```

A 429 body also reports the limiting bucket and the next-request delay. Header names are case-insensitive.

## Current request pressure

Every uncached lookup currently starts two fetches in `src/api.js`:

1. Bulk metadata for the viewed account.
2. Community analytics.

The cache identity includes account, count, and mode. It cannot reuse:

- 150 metadata rows for the 100 or 50 choices
- one community response across different accounts
- one in-flight request across separate pages

A profile using three counts and two modes starts six metadata requests and six analytics requests. Two fully explored profiles start 12 metadata requests, exceeding the 10-per-minute metadata IP quota.

The deployed explorer audit confirmed:

- A lookup starts metadata and analytics together.
- The explorer's community request is `match_mode=ranked` without `max_matches`, so it is identical for every explorer account and count.
- A metadata 429 leaves the lookup control usable immediately. `Retry-After` is displayed but not enforced.
- The failed metadata request aborts or discards the analytics sibling instead of retaining any independent success.

## Additional web-app findings

### Persistent cache is too large and unbounded

The explorer stores full metadata and community response bodies plus the derived analysis in localStorage. It has no entry-count or total-size limit. Writes that exceed the browser quota fail silently, after which repeat lookups lose the intended cache protection.

Old cache namespaces are ignored but not removed. They can continue consuming storage after a cache-version change.

### Raw response sections are not lazy

The explorer creates and pretty-prints the complete response body before the collapsed `<details>` element is opened. That duplicates large response strings and DOM text even when the user never inspects the raw body.

### Cache clocks disagree

Explorer reads use the injected application clock, while writes use `Date.now()` directly. Negative ages are clamped to zero, so a future timestamp can remain fresh incorrectly.

### Deep links repeat local work

Opening an account through URL parameters synchronizes controls once in `start()` and again in `runLookup()`. This does not duplicate network traffic, but it repeats localStorage and history writes.

### Already-aborted requests still construct both fetches

`fetchDeadlockData()` creates both endpoint calls even when its caller signal is already aborted. The browser rejects them promptly, but the fetch invocations are avoidable.

## Target data model

Replace the combined response cache with resource-specific entries.

### Player aggregate entry

Key:

```text
deadlock-stats-player:v1:<account>:<mode>
```

Value:

```js
{
  savedAt,
  fetchedAt,
  accountId,
  mode,
  maxMatches,
  samples: {
    "25": playerAggregate,
    "50": playerAggregate,
    "100": playerAggregate,
    "150": playerAggregate,
    "200": playerAggregate
  }
}
```

Only prefixes at or below `maxMatches` are present. A player aggregate contains the player-side values, sample size, total duration, and explorer supplemental values. It does not contain the raw metadata body or community values.

### Community entry

Key:

```text
deadlock-stats-community:v1:<mode>:<scope>
```

`scope` is one of:

- `50`, `100`, or `150` for the profile bridge
- `all` for the current explorer behavior

Value:

```js
{
  savedAt,
  fetchedAt,
  mode,
  scope,
  metrics
}
```

Community entries are independent of account ID.

### Rate state

Key:

```text
deadlock-stats-rate:v1:<endpoint-family>
```

Value:

```js
{
  blockedUntil,
  limit,
  period,
  remaining,
  observedAt
}
```

The state is updated from successful responses and 429 responses.

## Target request flow

### Player metadata

For the profile bridge:

- Fetch at most once per `(account, mode)` while fresh.
- Request 150 matches.
- Calculate 50, 100, and 150 from the same returned array.

For the explorer:

- Prefer one 200-match request per ranked account.
- Calculate 25, 50, 100, and 200 locally.
- Gate this on the reduced-query payload test. If the 200-match payload is still too large, use a progressive high-water mark and only fetch again when the requested count exceeds the cached maximum.

Do not retain the full metadata body in persistent localStorage. Keep it in memory for the active explorer page only.

### Community analytics

For the profile bridge, fetch and cache only the requested `(mode, count)` combination.

For the explorer, fetch `ranked:all` once per fresh period and reuse it for every account and count. An explicit player refresh must not refresh this account-independent value while it remains fresh.

### Independent completion

Split `fetchDeadlockData()` into independently cacheable metadata and community operations.

When both are missing, they may run concurrently, but one failure must not abort or discard the other's successful result. Cache each successful resource immediately. A superseded page request may still abort both through its parent cancellation signal.

This avoids refetching community analytics after a metadata 429.

## Cache policy

Use one clock source for reads and writes.

Suggested lifetimes:

| Resource | Fresh | Stale fallback |
|---|---:|---:|
| Player aggregate | 10 minutes | 24 hours |
| Community analytics | 1 hour | 24 hours |
| Rate cooldown | API-provided expiry | None |

Rules:

- Reject entries with timestamps in the future.
- Keep stale entries until the 24-hour fallback expires.
- Do not let normal startup cleanup delete entries at the fresh boundary.
- Use least-recently-used eviction.
- Start with a 64-entry and 1 MiB total serialized budget, then confirm it against measured compact-entry sizes.
- On quota failure, evict expired entries and then the oldest valid entries before retrying one write.
- Purge obsolete `deadlock-stats-cache:v2:`, `deadlock-stats-cache:v3:`, and `deadlock-stats-bridge-cache:v1:` entries once after the clean cutover.

## Raw-response handling in the explorer

Persistent cache entries contain compact analysis and response summaries, not complete raw bodies.

For a network result:

- Keep raw bodies in page memory.
- Create the `<pre>` content only when the user opens that response's `<details>` element.
- Release the raw body when another account replaces the result or the page unloads.

For a persistent cache hit:

- Render the calculated metrics immediately.
- Show request URL, status, headers, and generated time from the compact summary.
- State that the raw body was not retained and requires an explicit refresh.

This keeps the explorer useful without making localStorage and DOM size proportional to hundreds of full match objects.

## Metadata payload gate

Implement request-count reduction first with the current proven metadata fields. Then compare it against a reduced candidate.

Candidate query fields:

```text
include_info=false
extra_match_columns=duration_s
include_player_kda=true
extra_player_columns=
  net_worth,
  max_player_damage,
  max_player_damage_taken,
  max_boss_damage,
  max_self_healing,
  max_player_healing,
  max_shots_hit,
  max_shots_missed,
  max_hero_bullets_hit_crit,
  max_hero_bullets_hit,
  mvp_rank
```

The reduced query omits `include_player_final_stats` only after proving that the selected materialized fields are present and equivalent.

Keep `mvp_rank` in the shared player superset. Removing one scalar saves little and would make the explorer's MVP calculation require a different capability or another request. The profile bridge can ignore the supplemental result.

Equivalence must cover several accounts in both modes and all supported prefix sizes. Every displayed player value and sample size must match the current query.

## Rate-limit behavior

Before any request:

1. Read the endpoint-family rate state.
2. If `blockedUntil` is in the future, do not call fetch.
3. Serve a valid stale resource when available.
4. Otherwise return the existing rate-limit error with the remaining delay.

After a response:

- Persist the latest rate headers.
- If remaining is zero and reset is positive, block until reset.
- On 429, block for the larger of `Retry-After` and `RateLimit-Reset`.
- Add a small random delay before the first request after expiry.

The explorer must disable lookup and refresh actions during a known cooldown. Use a bounded one-shot timer to restore controls, not a polling loop.

## Request coordination

### Same-page coordination

Maintain one in-flight promise per resource key:

```text
player:<account>:<mode>
community:<mode>:<scope>
```

Same-key callers await the existing promise. A filter change must not abort a still-useful community request solely because the player request changed.

### Cross-page coordination

Feature-test coordination in both Chrome and Deadlock's HTML panel.

Preferred order:

1. `navigator.locks` when available.
2. A verified same-origin localStorage lease with owner token, expiry, and post-write ownership check.
3. Sequential cache reuse only if neither method can guarantee one owner.

A lease waiter watches for the resulting cache entry and has a bounded timeout. Expired owners can be replaced. Do not add a service worker unless these simpler mechanisms fail the live compatibility test.

## Explorer refresh semantics

An explicit explorer refresh:

- bypasses only the player aggregate's fresh state
- respects rate cooldown and request ownership
- revalidates browser HTTP cache for player metadata
- keeps fresh community analytics
- retains stale player data if the refresh fails

The current implementation bypasses localStorage but does not explicitly revalidate the browser's HTTP cache. The new behavior must be named and tested rather than implied.

## Profile debounce

Wait about 250 milliseconds after a mode or match-count change before assigning a new bridge URL. A newer choice cancels the pending assignment.

This prevents requests that would otherwise start and then be aborted. Once fetch begins, cancellation does not refund quota.

## Request-count model

Let `P` be the number of profiles for which all three profile counts and both modes are viewed during one cache period.

Current cold traffic:

```text
metadata  = 6P
analytics = 6P
total     = 12P
```

Target cold traffic with an empty community cache:

```text
metadata  = 2P
analytics = 6
total     = 2P + 6
```

Examples:

| Profiles | Current metadata | Target metadata | Current total | Target total |
|---:|---:|---:|---:|---:|
| 1 | 6 | 2 | 12 | 8 |
| 2 | 12 | 4 | 24 | 10 |
| 5 | 30 | 10 | 60 | 16 |

Five fully explored profiles can still consume the full metadata IP quota in one minute. The persisted rate state and request ownership remain necessary even after cache redesign.

## Implementation order

### Phase 1: resource interfaces and tests

Files:

- `src/api.js`
- `src/cache.js`
- `src/metrics.js`
- corresponding tests

Work:

- Separate metadata and community fetch functions.
- Separate player-only aggregation from community composition.
- Define versioned compact cache entries.
- Pass the same clock to every read and write.
- Add bounded eviction and legacy-key cleanup.

### Phase 2: explorer integration

Files:

- `src/app.js`
- `src/ui.js`
- `index.html` only if explanatory text changes
- corresponding tests

Work:

- Resolve player and community resources independently.
- Reuse the unbounded ranked community result across accounts and counts.
- Make raw-response serialization lazy and memory-only.
- Define player-only refresh behavior.
- Remove the duplicate deep-link control synchronization.
- Reject already-aborted work before creating fetches.

### Phase 3: bridge integration

Files:

- `src/bridge.js`
- `src/title-protocol.js` only if composition requires a contract change
- corresponding tests

Work:

- Reuse one player superset per account and mode.
- Reuse community entries per mode and count.
- Compose the existing validated title without changing `DLSTATS2:`.
- Preserve one-shot page cancellation.
- Add stale fallback and persistent cooldown behavior.

### Phase 4: coordination and payload reduction

Work:

- Add same-page resource deduplication.
- Run Chrome and Deadlock capability tests for cross-page ownership.
- Add the proven coordination mechanism.
- Run old-versus-reduced metadata equivalence fixtures and live probes.
- Enable the reduced query only after equivalence passes.

### Phase 5: Panorama debounce and deployment

Files:

- `profile_stats_community/panorama/scripts/profile_stats_community.js`
- its focused runtime tests
- profile build only if the Panorama source changes

Work:

- Debounce bridge navigation for filter changes.
- Keep stock mode free of recurring callbacks.
- Deploy GitHub Pages first, then rebuild and install the profile VPK if required.

## Required automated contracts

- One 150 metadata response produces identical 50, 100, and 150 profile aggregates.
- One 200 response produces identical 25, 50, 100, and 200 explorer aggregates, if maximum-first fetching passes the payload gate.
- Switching to a smaller count starts no metadata request.
- A higher count either reuses the maximum entry or performs one high-water-mark upgrade.
- A second account reuses the same fresh community entry.
- Explorer count changes reuse `ranked:all` community data.
- Ranked and Standard player caches never cross.
- A successful community request remains cached when metadata fails.
- An active persisted cooldown starts zero requests.
- Stale data renders after a 429 or network error.
- Future timestamps are rejected.
- Cache writes recover from quota pressure through bounded eviction.
- Obsolete cache namespaces are removed once.
- Raw response JSON is not serialized before its details element opens.
- Same-page duplicate requests share one promise.
- Cross-page duplicates start one upstream request when the selected coordination feature is supported.
- Expired ownership can recover without deadlock.
- Superseded requests cannot write stale results.
- The explorer retains MVP and kill-participation output.
- The profile title remains byte-valid and within its existing length limit.
- Stock profile mode schedules no bridge work.

## Live verification

### GitHub Pages explorer

Use browser network inspection to prove:

1. First account lookup starts one player request and, if absent, one community request.
2. Changing only the explorer count starts zero requests when the maximum aggregate is cached.
3. A second account with the same community scope starts only the player request.
4. Repeated lookup during a known cooldown starts zero requests.
5. A failed player refresh retains stale metrics.
6. Raw response content is created only when opened.
7. Storage remains within the configured budget after many accounts.

### Panorama bridge

After a fresh Deadlock restart:

1. Open the community profile view and inspect 50 matches.
2. Switch to 100 and 150. No additional metadata request should start.
3. Switch mode. Exactly one new metadata request should start for that mode.
4. Change to another profile. The matching community value should be reused.
5. Trigger or simulate a 429, close the profile, reopen it, and prove the cooldown survives.
6. Confirm stale values, generated time, Retry, Escape, stock restoration, and bridge unload behavior.

## Rejected approaches

- Client-side API key. Public JavaScript cannot keep it secret.
- Naive analytics `account_ids + max_matches`. It does not select the account's latest N matches.
- Fetching all community combinations in advance. That spends quota on unused filters.
- Sequencing metadata before analytics merely to reduce concurrency. It adds latency and does not reduce successful request count.
- Treating cancellation as quota recovery. The request may already have been counted.
- Batching unrelated profile accounts speculatively. It expands payload and does work the user did not request.
- Replacing localStorage coordination with a service worker before proving HTML-panel support.
- Bundling or minifying the small static application as a rate-limit fix.

## Optional server-side path

If client-side reduction is still insufficient, place a caching proxy in front of the API and keep `X-API-KEY` there. A proxy can share results and use the authenticated metadata quota, but it still faces the API's global 100-per-minute metadata ceiling. Centralizing many unique account requests can make that global limit more visible, so this is the last step, not the first.

## Primary sources

- Bulk metadata OpenAPI: https://api.deadlock-api.com/openapi.json#/paths/~1v1~1matches~1metadata
- Player metrics OpenAPI: https://api.deadlock-api.com/openapi.json#/paths/~1v1~1analytics~1player-stats~1metrics
- Bulk metadata source: https://github.com/deadlock-api/deadlock-api/blob/e2e79bc40d4c10e228f0ffe34e6b5cfbe8e2e59d/api/src/routes/v1/matches/bulk_metadata.rs
- Player metrics source: https://github.com/deadlock-api/deadlock-api/blob/e2e79bc40d4c10e228f0ffe34e6b5cfbe8e2e59d/api/src/routes/v1/analytics/player_stats_metrics.rs
- Rate limiter source: https://github.com/deadlock-api/deadlock-api/tree/e2e79bc40d4c10e228f0ffe34e6b5cfbe8e2e59d/api/src/services/rate_limiter
- Deployed explorer: https://hantu-raya.github.io/deadlock-stats-bridge/
