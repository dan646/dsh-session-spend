# Session spend

Adds one compact reading to the composer dock, under the chat: **DeepSeek spend ≈ $0.22**.

The pill shows the estimated cost of every token-billed request the session
sent to a DeepSeek provider, in the currency you configure. It renders nothing
while the session has not billed DeepSeek API usage, so sessions on other
providers stay untouched.

## Install

The bundle is a local DSH plugin:

1. Add the package directory with **Plugins → Add plugin** (or install it with
   the plugin manager's `install_bundle`).
2. Enable the `session-spend` bundle in **Plugins**.
3. Reload the Web page (and restart DSH after changing the plugin's own files,
   because Host modules are loaded once).

## Configuration

The plugin row's config in the profile patch:

```yaml
- id: session-spend
  name: '@local/session-spend'
  config:
    currency: USD          # USD (default) or CNY
    # pricing:
    #   CNY:
    #     deepseek-v4-pro: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 }
    # offPeakMultiplier: 0.5
```

- `currency` selects which shipped table prices the figure: the USD table or
  the CNY table from the official price list. No exchange rate is applied.
- `pricing` overrides rates model-by-model, keyed by currency; other models and
  the other currency keep their shipped values. A currency the plugin does not
  ship can be added this way.
- `offPeakMultiplier` is the off-peak share of the peak rate (0.5 by default,
  as DeepSeek documents).

## How the number is produced

The Host half registers a `deepseekSpend` session projection. It folds the
durable session log:

- `request/header` decides which provider/model route the following requests use;
- `assistant/message` and `assistant/attempt` contribute provider-reported
  token usage, with the same replacement rules as the shipped `tokenUsage`
  projection (a sample is replaced within its turn and step until
  `llm/retry-started` starts a billed retry);
- usage is accumulated per route and per billing tier (peak or off-peak, decided
  by the settlement's own timestamp), so switching models mid-session prices each
  route with its own rates.

The browser receives one finished value through the standard `useProjection`
seat, so paging, compaction, and reloads cannot change the figure. The tooltip
shows the per-model breakdown and how much of the traffic was off-peak.

## Rates

Default peak rates per one million tokens, from
[the official pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

| Model | Currency | Cache hit | Cache miss | Output |
|---|---|---|---|---|
| `deepseek-flash` | USD | $0.006 | $0.30 | $1.20 |
| `deepseek-flash` | CNY | ¥0.04 | ¥2 | ¥8 |
| `deepseek-v4-pro` | USD | $0.044 | $1.32 | $3.96 |
| `deepseek-v4-pro` | CNY | ¥0.30 | ¥9 | ¥27 |

DeepSeek bills peak hours at the rates above and off-peak hours at half of
them. Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday
(Beijing 09:00–12:00 and 14:00–18:00); weekends and Chinese public holidays are
off-peak in full. The fold has no holiday calendar, so weekdays that fall on a
Chinese public holiday are still priced at peak rates — the figure is then
higher, never lower, than the bill.

An unknown DeepSeek model containing "pro" uses the pro tier, any other unknown
model uses `fallbackModel` (default `deepseek-flash`), and the tooltip marks a
route priced by such a stand-in tier.

## Limits

- Only `deepseek-official` and `deepseek-account` routes are priced; requests to
  other providers are excluded (the tooltip says so when both kinds occurred).
- Subagent sessions are separate sessions and are not included.
- Every figure mirrors the shipped `tokenUsage` projection, which folds
  assistant settlements only: title, search, and compaction-summary requests are
  not part of the displayed total.
- The value is an estimate from token counts and a rate table, not a billing
  record. The pill's tooltip and accessible name state both the exclusions and
  that caveat, because the Plugin Manager card only has room for one sentence.
