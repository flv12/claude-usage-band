import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { BandCategory, BandQuota, BandSnapshot } from '../types'

const TICK_MS = 5_000
const QUOTA_GAP = 3
const QUOTA_MIN_WIDTH = 26

const snapshot = atom({ plugin: 'context-band', key: 'snapshot' } as const, null)
const minute = atom({ plugin: 'context-band', key: 'minute' } as const, 0)
const isHidden = atom({ plugin: 'context-band', key: 'isHidden' } as const, false)

const BORDER = '#2c303b'
const STRONG = '#e6e8ee'
const LABEL = '#b4b9c6'
const MUTED = '#6b7180'
const ACCENT = '#e0734f'
const TRACK = '#343a4a'
const BUFFER = '#4b5265'

// Matched against the row names /context prints; a row none matches keeps its own theme color.
const CATEGORY_STYLES: { match: RegExp; label: string; color: string }[] = [
  { match: /^system prompt/i, label: 'system prompt', color: '#6f8fd1' },
  { match: /^mcp tools/i, label: 'mcp tools', color: '#9d7cf5' },
  { match: /tools/i, label: 'tools', color: '#5fbfc4' },
  { match: /agents/i, label: 'agents', color: '#86c06c' },
  { match: /memory/i, label: 'memory files', color: '#e5bf5a' },
  { match: /skills/i, label: 'skills', color: '#f09ab8' },
  { match: /messages/i, label: 'messages', color: '#df7357' },
]

const KIND_ORDER: Record<BandCategory['kind'], number> = { used: 0, free: 1, buffer: 2 }

const QUOTA_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  spend_limit: 'spend',
}

type Style = { label: string; color: string; glyph: string }

function styleOf(category: BandCategory): Style {
  if (category.kind === 'free') return { label: 'free', color: TRACK, glyph: '█' }
  if (category.kind === 'buffer') return { label: 'buffer', color: BUFFER, glyph: '▒' }
  const known = CATEGORY_STYLES.find(style => style.match.test(category.name))

  return {
    label: known?.label ?? category.name.toLowerCase(),
    color: known?.color ?? category.themeColor,
    glyph: '█',
  }
}

function levelColor(percent: number): string {
  if (percent >= 80) return '#df5f57'
  if (percent >= 50) return '#e5bf5a'

  return '#86c06c'
}

function formatTokens(count: number): string {
  const trim = (text: string) => text.replace(/\.0$/, '')
  if (count >= 999_500) return `${trim((count / 1_000_000).toFixed(1))}M`
  if (count >= 9_950) return `${Math.round(count / 1_000)}k`
  if (count >= 1_000) return `${trim((count / 1_000).toFixed(1))}k`

  return String(Math.round(count))
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`

  return `${mins}m`
}

// A non-zero share of the window never reads 0%, as /context shows it.
function share(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0

  return Math.max(1, Math.round((tokens / max) * 100))
}

// Splits `width` cells between the values, largest remainders first, each at least its minimum.
function cellsOf(values: number[], width: number, minimums: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0 || width <= 0) return values.map(() => 0)

  const exact = values.map(value => (value / total) * width)
  const cells = exact.map((value, i) => Math.max(minimums[i] ?? 0, Math.floor(value)))
  let rest = width - cells.reduce((sum, value) => sum + value, 0)
  const remainder = (i: number) => (exact[i] ?? 0) - Math.floor(exact[i] ?? 0)
  const byRemainder = exact
    .map((_, i) => i)
    .filter(i => cells[i] === Math.floor(exact[i] ?? 0))
    .sort((a, b) => remainder(b) - remainder(a))
  for (const i of byRemainder) {
    if (rest <= 0) break
    cells[i] = (cells[i] ?? 0) + 1
    rest -= 1
  }
  while (rest < 0) {
    const widest = cells.indexOf(Math.max(...cells))
    cells[widest] = (cells[widest] ?? 0) - 1
    rest += 1
  }

  return cells
}

function toSnapshot(usage: SessionUsage): BandSnapshot {
  const quotas = usage.rateLimits.map(
    (limit): BandQuota => ({
      kind: limit.kind,
      percentUsed: limit.percentUsed,
      resetsAt: limit.resetsAt,
    }),
  )
  const breakdown = usage.context.breakdown

  if (breakdown === undefined) {
    const used = usage.context.tokens ?? 0

    return {
      categories: [
        { name: 'Used', kind: 'used', tokens: used, themeColor: 'claude' },
        {
          name: 'Free space',
          kind: 'free',
          tokens: Math.max(0, usage.context.window - used),
          themeColor: 'inactive',
        },
      ],
      totalTokens: used,
      maxTokens: usage.context.window,
      quotas,
    }
  }

  const categories = breakdown.categories
    .flatMap((row): BandCategory[] =>
      row.kind === 'deferred'
        ? []
        : [{ name: row.name, kind: row.kind, tokens: row.tokens, themeColor: row.color }],
    )
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])

  return {
    categories,
    totalTokens: breakdown.totalTokens,
    maxTokens: breakdown.rawMaxTokens,
    compactAt: breakdown.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined,
    quotas,
  }
}

// `summary` estimates locally: no token-count request, cheap enough to run every tick.
async function refresh($: EngineInterface): Promise<void> {
  const next = toSnapshot(await $.session.usage({ breakdown: 'summary' }))
  const current = await read($, snapshot)
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    await update($, snapshot, () => next)
  }
}

// The reset countdowns read minutes, so the clock is only written when the minute turns.
async function tick($: EngineInterface): Promise<void> {
  const at = Math.floor((await $.clock.now()) / 60_000)
  if ((await read($, minute)) !== at) {
    await update($, minute, () => at)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive) return result

    await $.command.register({
      name: 'band',
      description: 'Show or hide the context and quota band above the prompt',
    })
    // `isHidden` is session state: every new session starts with the band shown.
    await tick($)
    await refresh($)
    $.clock.every(TICK_MS, () => {
      void (async () => {
        await tick($)
        if (!(await read($, isHidden))) await refresh($)
      })()
    })

    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (!(await read($, isHidden))) await refresh($)

    return result
  })

  on('command.run', { command: 'band' }, async $ => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)
    if (hidden) return { text: 'Context band hidden (/band to show it again).' }

    await tick($)
    await refresh($)

    return { text: 'Context band shown (/band again to hide it).' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [data, hidden, at] = await Promise.all([
      read($, snapshot),
      read($, isHidden),
      read($, minute),
    ])
    if (e.props.hasSurvey || hidden || data === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // The border and the horizontal padding take two cells on each side.
    const inner = Math.max(20, e.props.bodyColumns - 4)
    const parts = data.categories.map(category => ({ ...category, ...styleOf(category) }))
    const cells = cellsOf(
      parts.map(part => part.tokens),
      inner,
      parts.map(part => (part.kind === 'used' && part.tokens > 0 ? 1 : 0)),
    )
    const compact =
      data.compactAt === undefined
        ? 'auto-compact off'
        : `compacts at ${Math.round((data.compactAt / data.maxTokens) * 100)}%`

    const quotaCount = data.quotas.length
    const quotaWidth = Math.floor((inner - QUOTA_GAP * (quotaCount - 1)) / Math.max(1, quotaCount))
    const isStacked = quotaWidth < QUOTA_MIN_WIDTH
    const barWidth = isStacked ? inner : quotaWidth

    const quotaView = (quota: BandQuota) => {
      const color = levelColor(quota.percentUsed)
      const percent = Math.min(100, Math.max(0, quota.percentUsed))
      const filled = Math.round((percent / 100) * barWidth)
      const resetsIn =
        quota.resetsAt === undefined
          ? undefined
          : formatDuration(Date.parse(quota.resetsAt) - at * 60_000)

      return (
        <Box flexDirection="column" width={barWidth}>
          <Box justifyContent="space-between">
            <Text>
              <Text color={color}>◆ </Text>
              <Text bold color={STRONG}>
                {QUOTA_LABELS[quota.kind] ?? quota.kind}
              </Text>
            </Text>
            <Text wrap="truncate-end">
              <Text bold color={color}>
                {Math.round(quota.percentUsed)}%
              </Text>
              {resetsIn !== undefined && <Text color={MUTED}> · resets in {resetsIn}</Text>}
            </Text>
          </Box>
          <Text>
            {filled > 0 && <Text color={color}>{'█'.repeat(filled)}</Text>}
            {filled < barWidth && <Text color={TRACK}>{'█'.repeat(barWidth - filled)}</Text>}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text color={ACCENT}>◆ </Text>
            <Text bold color={STRONG}>
              context
            </Text>
          </Text>
          <Text wrap="truncate-end">
            <Text bold color={STRONG}>
              {formatTokens(data.totalTokens)}
            </Text>
            <Text color={MUTED}>
              {' '}
              of {formatTokens(data.maxTokens)} · {compact}
            </Text>
          </Text>
        </Box>
        <Text>
          {parts.map((part, i) =>
            (cells[i] ?? 0) > 0 ? <Text color={part.color}>{part.glyph.repeat(cells[i] ?? 0)}</Text> : null,
          )}
        </Text>
        <Box flexWrap="wrap" columnGap={2}>
          {parts.map(part => (
            <Text>
              <Text color={part.color}>■</Text>
              <Text color={LABEL}> {part.label} </Text>
              <Text bold color={STRONG}>
                {formatTokens(part.tokens)}
              </Text>
              {part.kind === 'used' && (
                <Text color={MUTED}> {share(part.tokens, data.maxTokens)}%</Text>
              )}
            </Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection={isStacked ? 'column' : 'row'} columnGap={QUOTA_GAP}>
          {quotaCount === 0 ? (
            <Text color={MUTED}>quotas: no reading yet (they arrive with the first response)</Text>
          ) : (
            data.quotas.map(quotaView)
          )}
        </Box>
      </Box>
    )
  })
}
