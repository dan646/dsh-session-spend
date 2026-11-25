/** Focused checks for the pure spend fold; run with ELECTRON_RUN_AS_NODE=1. */
import assert from 'node:assert/strict'
import {
  createSpendProjection,
  DEFAULT_PRICING,
  isDeepSeekProvider,
  isPeakTime,
  PROJECTION_KEY,
  resolvePricing,
  STATE_VERSION,
} from '../projection.js'

/** Money comparisons tolerate IEEE-754 summation noise. */
const usd = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`)

/** Wednesday 2026-11-25 02:00 UTC — inside the first DeepSeek peak window. */
const PEAK = Date.UTC(2026, 10, 25, 2, 0)
/** Wednesday 2026-11-25 12:00 UTC — off-peak. */
const OFF_PEAK = Date.UTC(2026, 10, 25, 12, 0)
/** Saturday 2026-11-28 02:00 UTC — weekend, off-peak even though the hour is a peak hour. */
const WEEKEND = Date.UTC(2026, 10, 28, 2, 0)

/** Fold a synthetic event list through the registered definition. */
function fold(events, config = {}) {
  const { definition } = createSpendProjection(config)
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return { state, view: definition.wire.view(state), definition }
}

const header = (provider, model) => ({
  type: 'request/header',
  data: { header: { config: { provider, model } } },
  time: 0,
})
const message = (turn, step, usage, time = PEAK) => ({ type: 'assistant/message', data: { turn, step, usage }, time })
const attempt = (turn, step, stream, time = PEAK) => ({ type: 'assistant/attempt', data: { turn, step, stream }, time })
const retry = (turn, step) => ({ type: 'llm/retry-started', data: { turn, step }, time: 0 })

// 0. The weekday fixtures really are what the peak rule expects.
{
  assert.equal(new Date(PEAK).getUTCDay(), 3)
  assert.equal(new Date(WEEKEND).getUTCDay(), 6)
}

// 1. Peak window boundaries from the pricing page.
{
  assert.equal(isPeakTime(Date.UTC(2026, 10, 25, 0, 59)), false)
  assert.equal(isPeakTime(Date.UTC(2026, 10, 25, 1, 0)), true)
  assert.equal(isPeakTime(Date.UTC(2026, 10, 25, 3, 59)), true)
  assert.equal(isPeakTime(Date.UTC(2026, 10, 25, 4, 0)), false)
  assert.equal(isPeakTime(Date.UTC(2026, 10, 25, 6, 0)), true)
  assert.equal(isPeakTime(Date.UTC(2026, 10, 25, 9, 59)), true)
  assert.equal(isPeakTime(Date.UTC(2026, 10, 25, 10, 0)), false)
  assert.equal(isPeakTime(WEEKEND), false)
  assert.equal(isPeakTime(Date.UTC(2026, 10, 29, 2, 0)), false) // Sunday
  assert.equal(isPeakTime(undefined), true) // unknown time keeps the standard rate
}

// 2. Peak input and output at the USD flash rates.
{
  const { view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 1_000_000, outputTokens: 500_000 }),
  ])
  assert.equal(view.hasDeepSeekUsage, true)
  assert.equal(view.currency, 'USD')
  usd(view.cost, 0.9)
  assert.equal(view.tokens, 1_500_000)
  assert.equal(view.offPeakTokens, 0)
  assert.equal(view.routes.length, 1)
  assert.equal(view.routes[0].model, 'deepseek-flash')
  assert.equal(view.routes[0].rateTier, 'deepseek-flash')
}

// 3. The same request off-peak costs half.
{
  const { view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 1_000_000, outputTokens: 500_000 }, OFF_PEAK),
  ])
  usd(view.cost, 0.45)
  assert.equal(view.offPeakTokens, 1_500_000)
  assert.equal(view.offPeakMultiplier, 0.5)
}

// 4. Weekend peak-hour requests are off-peak.
{
  const { view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 1_000_000 }, WEEKEND),
  ])
  usd(view.cost, 0.15)
}

// 5. A session spanning both windows prices each sample by its own time.
{
  const { view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 1_000_000 }, PEAK),
    message(1, 2, { inputTokens: 1_000_000 }, OFF_PEAK),
  ])
  usd(view.cost, 0.45)
  assert.equal(view.tokens, 2_000_000)
  assert.equal(view.offPeakTokens, 1_000_000)
}

// 6. CNY prices come from the Chinese price list, not an exchange rate.
{
  const { view } = fold([
    header('deepseek-account', 'deepseek-flash'),
    message(1, 1, { inputTokens: 1_000_000, outputTokens: 500_000 }),
  ], { currency: 'CNY' })
  assert.equal(view.currency, 'CNY')
  usd(view.cost, 2 + 4)
}

// 7. Cache reads and writes are priced separately, on the pro tier.
{
  const { view } = fold([
    header('deepseek-account', 'deepseek-v4-pro'),
    message(1, 1, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
  ])
  usd(view.cost, 3.96 + 0.044)
  assert.equal(view.tokens, 3_000_000)
}

// 8. A retry inside one step adds a second billed attempt instead of replacing.
{
  const { state, view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    attempt(1, 1, [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } } }]),
    retry(1, 1),
    message(1, 1, { inputTokens: 200, outputTokens: 80 }),
  ])
  assert.equal(view.tokens, 100 + 50 + 200 + 80)
  assert.equal(state.last.turn, 1)
}

// 9. A later settlement for the same step replaces the earlier sample.
{
  const { view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 100, outputTokens: 50 }),
    message(1, 1, { inputTokens: 200, outputTokens: 80 }),
  ])
  assert.equal(view.tokens, 280)
}

// 10. A route that is not DeepSeek never shows the pill.
{
  const { view } = fold([
    header('openai', 'gpt-5'),
    message(1, 1, { inputTokens: 1_000, outputTokens: 1_000 }),
  ])
  assert.equal(view.hasDeepSeekUsage, false)
  assert.equal(view.cost, 0)
  assert.equal(view.hasOtherProviders, true)
  assert.deepEqual(view.routes, [])
}

// 11. Mixed routes: only DeepSeek tokens are priced and reported.
{
  const { view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 1_000_000, outputTokens: 0 }),
    header('openai', 'gpt-5'),
    message(2, 1, { inputTokens: 5_000_000, outputTokens: 1_000_000 }),
  ])
  usd(view.cost, 0.3)
  assert.equal(view.tokens, 1_000_000)
  assert.equal(view.hasOtherProviders, true)
  assert.equal(view.routes.length, 1)
}

// 12. Unknown DeepSeek models fall back to the matching tier.
{
  const flash = fold([header('deepseek-official', 'deepseek-v4.1-flash-1017'), message(1, 1, { inputTokens: 1_000_000 })])
  usd(flash.view.cost, DEFAULT_PRICING.USD['deepseek-flash'].input)
  assert.equal(flash.view.routes[0].rateTier, 'deepseek-flash')
  const pro = fold([header('deepseek-official', 'deepseek-v9-pro'), message(1, 1, { inputTokens: 1_000_000 })])
  usd(pro.view.cost, DEFAULT_PRICING.USD['deepseek-v4-pro'].input)
  assert.equal(pro.view.routes[0].rateTier, 'deepseek-v4-pro')
}

// 13. A settlement without usage leaves the state reference untouched.
{
  const { definition } = createSpendProjection({})
  let state = definition.apply(definition.init(), header('deepseek-official', 'deepseek-flash'))
  const before = state
  assert.equal(definition.apply(state, message(1, 1, {})), before)
  assert.equal(definition.apply(state, { type: 'turn/start', data: { turn: 1 } }), before)
}

// 14. Checkpoint round-trip: plain JSON state passes the restore schema.
{
  const { state, definition } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 12, outputTokens: 34, cacheReadTokens: 56 }, PEAK),
    message(1, 2, { inputTokens: 78, outputTokens: 90 }, OFF_PEAK),
  ])
  const restored = definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored, state)
  assert.equal(definition.key, PROJECTION_KEY)
  assert.equal(definition.stateVersion, STATE_VERSION)
  assert.equal(STATE_VERSION, 2)
}

// 15. Provider detection covers both shipped transports only.
{
  assert.equal(isDeepSeekProvider('deepseek-official'), true)
  assert.equal(isDeepSeekProvider('deepseek-account'), true)
  assert.equal(isDeepSeekProvider('deepseek'), true)
  assert.equal(isDeepSeekProvider('opendeepseek'), false)
  assert.equal(isDeepSeekProvider('anthropic'), false)
}

// 16. Config validation fails loudly instead of showing a wrong figure.
{
  assert.throws(() => resolvePricing({ currency: 'US' }))
  assert.throws(() => resolvePricing({ currency: 'EUR' })) // no table shipped
  assert.throws(() => resolvePricing({ unknown: true }))
  assert.throws(() => resolvePricing({ pricing: { USD: { 'deepseek-flash': { input: -1, cacheRead: 0, output: 0 } } } }))
  assert.throws(() => resolvePricing({ fallbackModel: 'missing' }))
  assert.throws(() => resolvePricing({ offPeakMultiplier: 2 }))
  assert.throws(() => resolvePricing({ pricing: { USD: { 'deepseek-flash': { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, extra: 1 } } } }))
}

// 17. A config override reprices one model and leaves the rest shipped.
{
  const resolved = resolvePricing({
    currency: 'USD',
    pricing: { USD: { 'deepseek-v4-pro': { input: 10, cacheRead: 1, cacheWrite: 0, output: 20 } } },
  })
  assert.deepEqual(resolved.pricing.USD['deepseek-v4-pro'], { input: 10, cacheRead: 1, cacheWrite: 0, output: 20 })
  assert.deepEqual(resolved.pricing.USD['deepseek-flash'], DEFAULT_PRICING.USD['deepseek-flash'])
  assert.deepEqual(resolved.pricing.CNY['deepseek-flash'], DEFAULT_PRICING.CNY['deepseek-flash'])
  assert.equal(resolved.currency, 'USD')
}

// 18. A deployment can add a currency the plugin does not ship.
{
  const { view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 1_000_000 }),
  ], {
    currency: 'EUR',
    pricing: { EUR: { 'deepseek-flash': { input: 0.5, cacheRead: 0.01, cacheWrite: 0, output: 2 } } },
  })
  assert.equal(view.currency, 'EUR')
  usd(view.cost, 0.5)
}

// 19. A custom off-peak multiplier is applied to the off-peak share only.
{
  const { view } = fold([
    header('deepseek-official', 'deepseek-flash'),
    message(1, 1, { inputTokens: 1_000_000 }, OFF_PEAK),
  ], { offPeakMultiplier: 0.25 })
  usd(view.cost, 0.075)
}

// 20. The view is JSON-serializable (crosses the projection wire).
{
  const { view } = fold([header('deepseek-official', 'deepseek-flash'), message(1, 1, { inputTokens: 1, outputTokens: 1 })])
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
}

console.log('session-spend: projection checks passed')
