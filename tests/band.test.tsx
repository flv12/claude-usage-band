import { expect, mock, test } from 'claude-code/testing'
import type { ContextCategory, On, RenderPropsOf, SessionUsage } from 'claude-code'

const PLUGIN = 'context-band'
const NOW = Date.parse('2026-10-12T12:00:00Z')
const SURFACES = ['terminal', 'desktop'] as const
const START = { cwd: '/tmp/project', surface: 'terminal', isInteractive: true } as const
const BAND_COMMAND = {
  command: 'band',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}

function row(name: string, tokens: number, kind: ContextCategory['kind'] = 'used'): ContextCategory {
  return { name, tokens, color: 'inactive', isDeferred: kind === 'deferred', kind }
}

// A 1M window: 90.3k of fixed context, `messages` on top, a 33k compaction buffer.
function usageWith(messages: number): SessionUsage {
  const used = 90_300 + messages

  return {
    startedAt: NOW,
    context: {
      tokens: used,
      window: 1_000_000,
      percent: 9,
      breakdown: {
        categories: [
          row('System prompt', 4_200),
          row('System tools', 17_000),
          row('MCP tools', 52_000),
          row('Custom agents', 3_400),
          row('Memory files', 8_600),
          row('Skills', 5_100),
          row('Messages', messages),
          row('MCP tools (deferred)', 40_000, 'deferred'),
          row('Free space', 967_000 - used, 'free'),
          row('Autocompact buffer', 33_000, 'buffer'),
        ],
        totalTokens: used,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        autocompactSource: 'auto',
        percentage: 9,
        gridRows: [],
        model: 'claude-opus-5-5[1m]',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        autoCompactThreshold: 967_000,
        isAutoCompactEnabled: true,
        apiUsage: null,
      },
    },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T14:13:00Z' },
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-15T16:00:00Z' },
    ],
  }
}

function setup(on: On, world: { usage: SessionUsage }, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: world.usage }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  return clock
}

test('draws the context by category and both quotas', async ($, on) => {
  setup(on, { usage: usageWith(0) })
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    for (const text of [
      /context/,
      /of 1M · compacts at 97%/,
      /system prompt/,
      /4\.2k/,
      /mcp tools/,
      /52k/,
      /memory files/,
      /free/,
      /877k/,
      /buffer/,
      /5h/,
      /24%/,
      /resets in 2h 13m/,
      /week/,
      /41%/,
      /resets in 3d 4h/,
    ]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /deferred/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('fills the bars to the band width, side by side or stacked', async ($, on) => {
  setup(on, { usage: usageWith(0) })
  await $.session.start(START)

  for (const [bodyColumns, quotaCells] of [
    [120, 56],
    [50, 46],
  ] as const) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...BAND, bodyColumns },
    })
    const bars = (await ui.findAll({ type: 'Text', text: /^[█▒]+$/ })).filter(bar =>
      bar.children.every(child => typeof child !== 'string'),
    )
    expect(bars.map(bar => bar.text.length)).toEqual([bodyColumns - 4, quotaCells, quotaCells])
    await ui.unmount()
  }
})

test('follows the context every five seconds', async ($, on) => {
  const world = { usage: usageWith(0) }
  const clock = setup(on, world)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: /^90k$/ })).toBeDefined()

  world.usage = usageWith(12_000)
  await clock.advance(5_000)

  expect(await ui.find({ type: 'Text', text: /^102k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^12k$/ })).toBeDefined()
  await ui.unmount()
})

test('/band hides the band, then shows it again', async ($, on) => {
  setup(on, { usage: usageWith(0) })
  await $.session.start(START)

  expect((await $.command.run(BAND_COMMAND)).text).toMatch(/hidden/)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /system prompt/ })).toBeUndefined()
    await ui.unmount()
  }

  expect((await $.command.run(BAND_COMMAND)).text).toMatch(/shown/)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: /system prompt/ })).toBeDefined()
  await ui.unmount()
})

test('every session starts with the band shown, whatever an earlier one stored', async ($, on) => {
  setup(on, { usage: usageWith(0) }, { isHidden: true })
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: /system prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeUndefined()
  await ui.unmount()
})

test('yields the band to a survey', async ($, on) => {
  setup(on, { usage: usageWith(0) })
  await $.session.start(START)

  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, hasSurvey: true },
  })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await ui.unmount()
})
