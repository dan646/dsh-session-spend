/**
 * Session spend projection: per-route billed token usage folded from the
 * durable session log, priced with the official DeepSeek rate tables in the
 * currency the deployment selects.
 *
 * The unit exists so the browser never folds events itself: the Host computes
 * the whole-session figure and serves it through `ctx.sessionProjections`, so
 * the value survives paging, compaction, and reloads exactly like the shipped
 * `tokenUsage` and `sessionStats` units.
 *
 * Billing attribution mirrors the shipped `tokenUsage` fold: one sample per
 * settled attempt, replaced within a turn/step until `llm/retry-started` ends
 * that replacement scope. Unlike that fold, usage is accumulated per
 * provider/model route, because a session may switch models and each route has
 * its own prices.
 *
 * DeepSeek bills peak and off-peak request rates, so every sample is stamped
 * with the tier implied by its own timestamp; the state keeps the two tiers
 * apart and the view prices each with its own multiplier.
 *
 * Only DeepSeek routes are priced. A session that never sent a request to a
 * DeepSeek provider reports `hasDeepSeekUsage: false`, which is what keeps the
 * composer pill hidden.
 *
 * @module @local/session-spend/projection
 */

/** Projection key served to the browser. */
export const PROJECTION_KEY = 'deepseekSpend'

/** Fold semantics version; bump when the state shape or fold rules change. */
export const STATE_VERSION = 2

/** Currency used when the row config names none. */
export const DEFAULT_CURRENCY = 'USD'

/** Route whose rates price a DeepSeek model missing from the table. */
export const DEFAULT_FALLBACK_MODEL = 'deepseek-flash'

/** Off-peak rates are half of the peak rates, per the pricing page. */
export const DEFAULT_OFF_PEAK_MULTIPLIER = 0.5

/**
 * Peak-rate prices per one million tokens, straight from the official pricing
 * page (https://api-docs.deepseek.com/quick_start/pricing/): `deepseek-flash`
 * and `deepseek-v4-pro` list peak rates, and off-peak is half of them. The CNY
 * table is the Chinese price list, not a conversion, so no exchange rate is
 * involved.
 */
export const DEFAULT_PRICING = Object.freeze({
  USD: Object.freeze({
    'deepseek-flash': Object.freeze({ input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 }),
    'deepseek-v4-pro': Object.freeze({ input: 1.32, cacheRead: 0.044, cacheWrite: 0, output: 3.96 }),
  }),
  CNY: Object.freeze({
    'deepseek-flash': Object.freeze({ input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }),
    'deepseek-v4-pro': Object.freeze({ input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 }),
  }),
})

/**
 * Peak windows in UTC, from the pricing page: Beijing 09:00–12:00 and
 * 14:00–18:00 on weekdays. Chinese public holidays are off-peak too, but the
 * fold has no holiday calendar, so their weekdays stay priced at peak rates.
 */
const PEAK_WINDOWS_UTC = Object.freeze([[1, 4], [6, 10]])

/** Token buckets of one route; fields stay disjoint like the provider usage. */
const ZERO_BUCKETS = Object.freeze({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/**
 * Whether a request time falls in a DeepSeek peak window.
 * @param time - epoch milliseconds of the settlement.
 * @returns true for a weekday peak hour; missing or invalid times are peak
 * (the standard rate) rather than a silent discount.
 */
export function isPeakTime(time) {
  if (!Number.isFinite(time)) return true
  const date = new Date(time)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Whether a provider id names a DeepSeek route. Both official transports
 * (`deepseek-official` for API keys, `deepseek-account` for a signed-in
 * account) are DeepSeek API traffic.
 * @param provider - route provider id.
 * @returns true for `deepseek` and every `deepseek-*` provider.
 */
export function isDeepSeekProvider(provider) {
  return provider === 'deepseek' || provider.startsWith('deepseek-')
}

/** Validate one `{input, cacheRead, cacheWrite, output}` rate object and detach it. */
function normalizeRates(model, rates) {
  if (typeof rates !== 'object' || rates === null || Array.isArray(rates)) {
    throw new Error(`session-spend: pricing.${model} must be a rate object`)
  }
  const next = {}
  for (const field of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    const value = rates[field] ?? (field === 'cacheWrite' ? 0 : undefined)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`session-spend: pricing.${model}.${field} must be a non-negative number`)
    }
    next[field] = value
  }
  for (const field of Object.keys(rates)) {
    if (!Object.hasOwn(next, field)) {
      throw new Error(`session-spend: pricing.${model} has unknown field "${field}"`)
    }
  }
  return Object.freeze(next)
}

/**
 * Detached, validated pricing configuration.
 *
 * `pricing` in the row config is keyed by currency and merges model-by-model
 * over the shipped table for that currency, so a deployment can reprice one
 * model without restating the other, and can add a currency the plugin does not
 * ship.
 * @param config - the row's config (`currency`, `pricing`, `fallbackModel`,
 * `offPeakMultiplier`).
 * @returns the selected currency and the tables it may price from.
 */
export function resolvePricing(config) {
  const input = config ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session-spend: config must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!['currency', 'pricing', 'fallbackModel', 'offPeakMultiplier'].includes(key)) {
      throw new Error(`session-spend: unknown config key "${key}" (supported: currency, pricing, fallbackModel, offPeakMultiplier)`)
    }
  }

  const currency = String(input.currency ?? DEFAULT_CURRENCY).toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`session-spend: currency must be a 3-letter code such as USD or CNY, got "${String(input.currency)}"`)
  }

  const fallbackModel = input.fallbackModel ?? DEFAULT_FALLBACK_MODEL
  if (typeof fallbackModel !== 'string' || fallbackModel.length === 0) {
    throw new Error('session-spend: fallbackModel must be a non-empty model id')
  }

  const offPeakMultiplier = input.offPeakMultiplier ?? DEFAULT_OFF_PEAK_MULTIPLIER
  if (typeof offPeakMultiplier !== 'number' || !Number.isFinite(offPeakMultiplier) || offPeakMultiplier < 0 || offPeakMultiplier > 1) {
    throw new Error('session-spend: offPeakMultiplier must be a number between 0 and 1')
  }

  const overrides = input.pricing ?? {}
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new Error('session-spend: pricing must map currencies to model rate tables')
  }

  const tables = {}
  for (const code of Object.keys(DEFAULT_PRICING)) tables[code] = { ...DEFAULT_PRICING[code] }
  for (const code of Object.keys(overrides)) {
    const upper = code.toUpperCase()
    if (!/^[A-Z]{3}$/.test(upper)) {
      throw new Error(`session-spend: pricing currency "${code}" must be a 3-letter code such as USD or CNY`)
    }
    const table = overrides[code]
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      throw new Error(`session-spend: pricing.${code} must map model ids to rate objects`)
    }
    tables[upper] = { ...(tables[upper] ?? {}) }
    for (const model of Object.keys(table)) {
      if (model.length === 0) throw new Error('session-spend: pricing keys must be non-empty model ids')
      tables[upper][model] = normalizeRates(model, table[model])
    }
  }

  const selected = tables[currency]
  if (selected === undefined) {
    throw new Error(`session-spend: currency "${currency}" has no pricing table; add pricing.${currency} to the row config`)
  }
  if (!Object.hasOwn(selected, fallbackModel)) {
    throw new Error(`session-spend: fallbackModel "${fallbackModel}" has no pricing entry in ${currency}`)
  }

  const frozen = {}
  for (const code of Object.keys(tables)) frozen[code] = Object.freeze(tables[code])

  return Object.freeze({
    currency,
    pricing: Object.freeze(frozen),
    fallbackModel,
    offPeakMultiplier,
  })
}

/**
 * Rates for one route. A model id containing "pro" uses the pro tier when the
 * table has one, so an account-catalog alias still prices sensibly; every other
 * unknown model uses the fallback tier. The returned tier lets the client mark
 * a figure that was priced by a stand-in row.
 * @param pricing - resolved rate table for the selected currency.
 * @param fallbackModel - tier used for an unknown model.
 * @param provider - route provider (currently unused; reserved for per-provider tables).
 * @param model - route model id.
 * @returns the four per-million rates and the pricing entry that supplied them.
 */
export function pricesFor(pricing, fallbackModel, provider, model) {
  void provider
  if (Object.hasOwn(pricing, model)) return { rates: pricing[model], tier: model }
  if (/pro/i.test(model)) {
    const pro = Object.keys(pricing).find(id => /pro/i.test(id))
    if (pro !== undefined) return { rates: pricing[pro], tier: pro }
  }
  return { rates: pricing[fallbackModel], tier: fallbackModel }
}

/** Guarded finite non-negative integer. */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}

/**
 * Normalize one provider usage record.
 * @param usage - raw `TokenUsage`-shaped value.
 * @returns disjoint token buckets, or undefined when the record reports nothing.
 */
export function bucketsFromUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const uncachedInputTokens = tokenCount(usage.inputTokens)
  const outputTokens = tokenCount(usage.outputTokens)
  const cacheReadTokens = tokenCount(usage.cacheReadTokens)
  const cacheWriteTokens = tokenCount(usage.cacheWriteTokens)
  if (uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return undefined
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/**
 * Usage one durable settlement reports for its attempt: the assembled
 * message's own record first, then the last usage chunk embedded in the
 * settlement's stream (the same precedence the shipped `tokenUsage` fold uses).
 * @param event - `assistant/message` or `assistant/attempt` event.
 * @returns normalized buckets, or undefined when no usage was reported.
 */
export function usageOfEvent(event) {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const buckets = event.data.usage === undefined ? undefined : bucketsFromUsage(event.data.usage)
  if (buckets !== undefined) return buckets
  const stream = event.data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object') continue
    if (record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'usage') continue
    return bucketsFromUsage(chunk.usage)
  }
  return undefined
}

/** Stable JSON-safe map key for one route (the null separator cannot appear in an id). */
function routeKeyOf(provider, model) {
  return `${provider}\u0000${model}`
}

/** Sum of a bucket's disjoint token counts. */
function bucketTotal(buckets) {
  return buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

/** Signed addition of one bucket into another. */
function addBuckets(left, right) {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}

/** Signed subtraction of one bucket from another, never below zero. */
function subtractBuckets(left, right) {
  return {
    uncachedInputTokens: Math.max(0, left.uncachedInputTokens - right.uncachedInputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    cacheReadTokens: Math.max(0, left.cacheReadTokens - right.cacheReadTokens),
    cacheWriteTokens: Math.max(0, left.cacheWriteTokens - right.cacheWriteTokens),
  }
}

/** USD/CNY cost of one bucket under one rate set. */
function bucketCost(buckets, rates) {
  return (
    buckets.uncachedInputTokens * rates.input
    + buckets.cacheReadTokens * rates.cacheRead
    + buckets.cacheWriteTokens * rates.cacheWrite
    + buckets.outputTokens * rates.output
  ) / 1_000_000
}

/**
 * Fold one committed event into the projection state.
 * @param state - current state (never mutated).
 * @param event - committed session event.
 * @returns the same reference when the event does not concern the unit.
 */
function foldState(state, event) {
  if (event.type === 'request/header') {
    const config = event.data?.header?.config
    const provider = config?.provider
    const model = config?.model
    if (typeof provider !== 'string' || provider.length === 0) return state
    if (typeof model !== 'string' || model.length === 0) return state
    const current = state.current
    if (current !== null && current.provider === provider && current.model === model) return state
    return { ...state, current: { provider, model } }
  }

  if (event.type === 'llm/retry-started') {
    const last = state.last
    if (last === null || last.turn !== event.data.turn || last.step !== event.data.step) return state
    // The failed attempt's sample can no longer be replaced by the retried one.
    return { ...state, last: null }
  }

  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  const buckets = usageOfEvent(event)
  if (buckets === undefined) return state

  const turn = event.data.turn
  const step = event.data.step
  const tier = isPeakTime(event.time) ? 'peak' : 'offPeak'
  const route = state.current ?? { provider: 'unknown', model: 'unknown' }
  const routeKey = routeKeyOf(route.provider, route.model)
  const previous = state.last !== null && state.last.turn === turn && state.last.step === step
    ? state.last
    : null

  const routes = { ...state.routes }
  if (previous !== null) {
    const existing = routes[previous.routeKey]
    const remaining = existing === undefined
      ? ZERO_BUCKETS
      : subtractBuckets(existing[previous.tier] ?? ZERO_BUCKETS, previous.buckets)
    if (existing !== undefined) {
      if (bucketTotal(remaining) === 0 && bucketTotal(existing[previous.tier === 'peak' ? 'offPeak' : 'peak'] ?? ZERO_BUCKETS) === 0) {
        delete routes[previous.routeKey]
      } else {
        routes[previous.routeKey] = { ...existing, [previous.tier]: remaining }
      }
    }
  }

  const base = routes[routeKey] ?? { provider: route.provider, model: route.model, peak: ZERO_BUCKETS, offPeak: ZERO_BUCKETS }
  routes[routeKey] = {
    provider: route.provider,
    model: route.model,
    peak: tier === 'peak' ? addBuckets(base.peak, buckets) : base.peak,
    offPeak: tier === 'offPeak' ? addBuckets(base.offPeak, buckets) : base.offPeak,
  }

  return {
    ...state,
    routes,
    last: { turn, step, routeKey, tier, buckets },
  }
}

/**
 * Client view: priced DeepSeek usage in the configured currency and the flag
 * that gates the pill.
 * @param state - fold state.
 * @param resolved - resolved pricing.
 * @returns a JSON-safe, reference-fresh view.
 */
function viewOf(state, resolved) {
  const rates = resolved.pricing[resolved.currency]
  const routes = []
  let cost = 0
  let tokens = 0
  let offPeakTokens = 0
  let hasOtherProviders = false
  for (const key of Object.keys(state.routes)) {
    const route = state.routes[key]
    const peak = route.peak ?? ZERO_BUCKETS
    const offPeak = route.offPeak ?? ZERO_BUCKETS
    const routeTokens = bucketTotal(peak) + bucketTotal(offPeak)
    if (routeTokens === 0) continue
    if (!isDeepSeekProvider(route.provider)) {
      hasOtherProviders = true
      continue
    }
    const { rates: modelRates, tier } = pricesFor(rates, resolved.fallbackModel, route.provider, route.model)
    const routeCost = bucketCost(peak, modelRates) + bucketCost(offPeak, modelRates) * resolved.offPeakMultiplier
    cost += routeCost
    tokens += routeTokens
    offPeakTokens += bucketTotal(offPeak)
    routes.push({
      provider: route.provider,
      model: route.model,
      rateTier: tier,
      tokens: routeTokens,
      offPeakTokens: bucketTotal(offPeak),
      uncachedInputTokens: peak.uncachedInputTokens + offPeak.uncachedInputTokens,
      cacheReadTokens: peak.cacheReadTokens + offPeak.cacheReadTokens,
      cacheWriteTokens: peak.cacheWriteTokens + offPeak.cacheWriteTokens,
      outputTokens: peak.outputTokens + offPeak.outputTokens,
      cost: routeCost,
    })
  }
  routes.sort((left, right) => right.cost - left.cost)
  return {
    currency: resolved.currency,
    hasDeepSeekUsage: tokens > 0,
    hasOtherProviders,
    cost,
    tokens,
    offPeakTokens,
    offPeakMultiplier: resolved.offPeakMultiplier,
    routes,
  }
}

/** Validate one persisted bucket object. */
function parseBuckets(value, where) {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`session-spend: projection state ${where} must be an object`)
  }
  for (const field of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const count = value[field]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`session-spend: projection state ${where}.${field} must be a non-negative integer`)
    }
  }
  return value
}

/** Validate the persisted fold state shape; the registry calls this on restore. */
function parseState(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('session-spend: projection state must be an object')
  }
  if (value.current !== null && (typeof value.current !== 'object' || value.current === null)) {
    throw new Error('session-spend: projection state current must be null or a route')
  }
  if (typeof value.routes !== 'object' || value.routes === null || Array.isArray(value.routes)) {
    throw new Error('session-spend: projection state routes must be an object')
  }
  for (const key of Object.keys(value.routes)) {
    const route = value.routes[key]
    if (typeof route !== 'object' || route === null) {
      throw new Error('session-spend: projection state route must be an object')
    }
    parseBuckets(route.peak, 'route.peak')
    parseBuckets(route.offPeak, 'route.offPeak')
  }
  return value
}

/** Validate the client view shape; the registry calls this before publishing. */
function parseView(value) {
  if (typeof value !== 'object' || value === null || value.hasDeepSeekUsage === undefined) {
    throw new Error('session-spend: projection view is malformed')
  }
  return value
}

/**
 * Build the projection definition registered on `ctx.sessionProjections`.
 * @param config - the row's config.
 * @returns the definition plus its resolved pricing for inspection.
 */
export function createSpendProjection(config) {
  const resolved = resolvePricing(config)
  const definition = {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: { parse: parseState },
    init: () => ({ current: null, last: null, routes: {} }),
    apply: foldState,
    wire: {
      viewSchema: { parse: parseView },
      view: state => viewOf(state, resolved),
      // The pill is only read for an opened Session, so list-row summaries skip it.
      summary: false,
    },
  }
  return {
    definition,
    currency: resolved.currency,
    pricing: resolved.pricing[resolved.currency],
    fallbackModel: resolved.fallbackModel,
    offPeakMultiplier: resolved.offPeakMultiplier,
  }
}
