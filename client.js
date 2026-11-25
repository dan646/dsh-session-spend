/**
 * Browser half of the Session spend bundle: one compact reading under the
 * composer that shows the estimated DeepSeek API spend of the whole session.
 *
 * The figure is computed by the Host (`deepseekSpend` projection) in the row
 * config's currency and arrives through the standard `useProjection` seat, so
 * this module only formats and renders. It renders nothing when the session
 * never billed a request to a DeepSeek provider.
 *
 * @module @local/session-spend/client
 */

window.__ModuleLoader__.load({
  id: '@local/session-spend',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'session-spend'

    /** Projection key registered by the Host half. */
    const PROJECTION_KEY = 'deepseekSpend'

    const en = {
      'pill.brand': 'DeepSeek spend ≈',
      'pill.aria': 'Estimated DeepSeek API spend in this session: {amount} across {tokens} tokens.',
      'limits.text': 'Estimate only: subagent sessions, title, search, and compaction requests are not included; this is not a billing record.',
      'tooltip.title': 'Estimated DeepSeek API spend',
      'tooltip.rates': 'Priced with DeepSeek peak rates; off-peak requests are billed at {percent}% of peak. Chinese public holidays are treated as peak days.',
      'tooltip.offPeak': 'Off-peak requests: {tokens} tokens.',
      'tooltip.route': '{model}: {amount} · {tokens} tokens',
      'tooltip.fallback': '{model}: priced with {tier} rates',
      'tooltip.other': 'Requests to other providers are not included.',
    }

    const ru = {
      'pill.brand': 'Расход DeepSeek ≈',
      'pill.aria': 'Оценка расходов на DeepSeek API в этой сессии: {amount}, {tokens} токенов.',
      'limits.text': 'Это оценка: сессии субагентов, запросы заголовков, поиска и сжатия не учитываются; это не счёт.',
      'tooltip.title': 'Оценка расходов на DeepSeek API',
      'tooltip.rates': 'Расчёт по пиковым тарифам DeepSeek; в непиковые часы — {percent}% от пиковой ставки. Праздничные дни Китая считаются пиковыми.',
      'tooltip.offPeak': 'Непиковые запросы: {tokens} токенов.',
      'tooltip.route': '{model}: {amount} · {tokens} токенов',
      'tooltip.fallback': '{model}: по тарифу {tier}',
      'tooltip.other': 'Запросы к другим провайдерам не учитываются.',
    }

    /**
     * Entry root: the shipped stats-pill box metrics, sized like the dock's
     * reserved reading row and allowed to shrink inside a narrow composer.
     */
    const rootStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      boxSizing: 'border-box',
      minWidth: 0,
      maxWidth: '100%',
      flexShrink: 1,
      padding: '1px 8px',
      borderRadius: 'var(--dsw-radius-sm)',
      color: 'var(--dsw-alias-label-tertiary)',
      font: 'inherit',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      cursor: 'default',
    }

    /** Brand copy shrinks first so the amount the user asked for stays whole. */
    const brandStyle = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    /** The reading itself never shrinks or wraps. */
    const amountStyle = {
      flex: 'none',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
    }

    /**
     * Active DSH language for `Intl` formatting, which otherwise follows the
     * browser rather than the app's language setting.
     * @returns a BCP 47 tag, or undefined to fall back to the browser locale.
     */
    function activeLocale() {
      if (typeof document === 'undefined') return undefined
      const lang = document.documentElement?.lang
      return typeof lang === 'string' && lang.length > 0 ? lang : undefined
    }

    /**
     * Localized amount in the session's pricing currency, with enough precision
     * to keep small sessions readable instead of collapsing them into "0.00".
     * @param value - spend in `currency`.
     * @param currency - ISO 4217 code from the projection view.
     * @returns display string.
     */
    function formatAmount(value, currency) {
      const belowFloor = value > 0 && value < 0.0001
      const shown = belowFloor ? 0.0001 : value
      const digits = shown >= 1 ? 2 : shown >= 0.1 ? 3 : 4
      let text
      try {
        text = new Intl.NumberFormat(activeLocale(), {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(shown)
      } catch {
        text = `${shown.toFixed(digits)} ${currency}`
      }
      return belowFloor ? `<${text}` : text
    }

    /**
     * Compact token count in the app's language (1.2M, 12.3K, 940).
     * @param value - token count.
     * @returns display string.
     */
    function formatTokens(value) {
      try {
        return new Intl.NumberFormat(activeLocale(), {
          notation: 'compact',
          maximumFractionDigits: value < 10_000 ? 1 : 2,
        }).format(value)
      } catch {
        return String(Math.round(value))
      }
    }

    /**
     * Hover text: what the figure is, how it was priced, what it leaves out,
     * then one line per billed DeepSeek route.
     * @param spend - the projection value.
     * @param t - namespace translator.
     * @returns multi-line plain text.
     */
    function buildTooltip(spend, t) {
      const percent = Math.round(spend.offPeakMultiplier * 100)
      const lines = [
        t('tooltip.title'),
        t('tooltip.rates', { percent }),
        t('limits.text'),
      ]
      if (spend.offPeakTokens > 0) lines.push(t('tooltip.offPeak', { tokens: formatTokens(spend.offPeakTokens) }))
      for (const route of spend.routes) {
        lines.push(t('tooltip.route', {
          model: route.model,
          amount: formatAmount(route.cost, spend.currency),
          tokens: formatTokens(route.tokens),
        }))
        if (typeof route.rateTier === 'string' && route.rateTier !== route.model) {
          lines.push(t('tooltip.fallback', { model: route.model, tier: route.rateTier }))
        }
      }
      if (spend.hasOtherProviders === true) lines.push(t('tooltip.other'))
      return lines.join('\n')
    }

    /**
     * Accessible description: the reading, then the exclusions this pill cannot
     * show as a second visible line.
     * @param spend - the projection value.
     * @param t - namespace translator.
     * @param amount - formatted spend.
     * @param tokens - formatted token count.
     * @returns one plain-text sentence group.
     */
    function buildAriaLabel(spend, t, amount, tokens) {
      const parts = [t('pill.aria', { amount, tokens }), t('limits.text')]
      if (spend.hasOtherProviders === true) parts.push(t('tooltip.other'))
      return parts.join(' ')
    }

    /**
     * One composer-dock entry, sibling of the shipped Activity and Usage
     * readings. Renders nothing without DeepSeek API usage.
     * @param props - slot props (the `session` scope guarantees the projection
     * seat, and this registration declares a locale namespace for `t`).
     * @returns the pill, or null.
     */
    function SpendPill({ useProjection, t }) {
      const spend = useProjection(PROJECTION_KEY)
      if (spend === undefined || spend === null || spend.hasDeepSeekUsage !== true) return null
      // A projection from an older bundle generation cannot be priced here.
      if (!Number.isFinite(spend.cost) || typeof spend.currency !== 'string') return null
      const amount = formatAmount(spend.cost, spend.currency)
      const tokens = formatTokens(spend.tokens)
      return h('span', {
        style: rootStyle,
        title: buildTooltip(spend, t),
        'aria-label': buildAriaLabel(spend, t, amount, tokens),
        'data-session-spend': 'deepseek',
      },
      h('span', { style: brandStyle }, t('pill.brand')),
      h('span', { style: amountStyle }, amount))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en, ru }),
          'session-spend: dictionaries',
        )
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'deepseek-spend',
          order: 2,
          locale: NS,
        }, SpendPill))
      },
    }
  },
})
