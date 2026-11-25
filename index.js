/**
 * Host half of the Session spend bundle: registers the `deepseekSpend`
 * projection unit so the browser receives a whole-session, already-priced
 * DeepSeek figure instead of folding events itself.
 *
 * @module @local/session-spend
 */

import { createSpendProjection } from './projection.js'

/** Cordis plugin name. */
export const name = 'session-spend'

/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * Register the spend unit; the registration is an effect on this plugin's
 * fiber, so unloading the bundle removes the projection key.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - the row's config (`pricing`, `fallbackModel`).
 * @returns when the unit is registered.
 */
export async function apply(ctx, config) {
  const { definition } = createSpendProjection(config ?? {})
  await ctx.sessionProjections.register(definition)
}
