import { describe, expect, test } from 'bun:test'
import { rgbToHex, type TimerHandle } from '@opentui/core'
import { ManualClock, type MockInput, type MockMouse } from '@opentui/core/testing'
import { testRender } from '@opentui/react/test-utils'
import { act, useState, type ComponentProps } from 'react'
import type { Line } from '../state/timeline'
import { Timeline } from './Timeline'
import { color } from './theme'

/** The test terminal. The timeline fills it, so the window is 10 lines. */
const WIDTH = 40
const HEIGHT = 10

/** The quiet background of the selected row, as in the mockup. */
const SELECTED_BG = '#23222f'

/** The keys that MockInput has no names for. */
const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'

type TimelineProps = ComponentProps<typeof Timeline>

/** Changes the props of a mounted timeline, as its parent does. */
interface Controls {
  update: (patch: Partial<TimelineProps>) => void
}

/** A manual clock that keeps the delay of each interval that runs. */
class IntervalClock extends ManualClock {
  readonly intervals = new Map<TimerHandle, number>()

  override setInterval(fn: () => void, delayMs: number) {
    const handle = super.setInterval(fn, delayMs)
    this.intervals.set(handle, delayMs)
    return handle
  }

  override clearInterval(handle: TimerHandle) {
    this.intervals.delete(handle)
    super.clearInterval(handle)
  }
}

/** A number as the lines show it: 7 is `007`. */
function pad(number: number) {
  return String(number).padStart(3, '0')
}

/** The lines `line <first>` to `line <last>`. Each line is one row: `row-001`, and so on. */
function numberedLines(last: number, first = 1) {
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const number = pad(first + index)
    const line: Line = { rowId: `row-${number}`, segments: [{ text: `line ${number}`, fg: color.linen }] }
    return line
  })
}

/** The texts that a window of `numberedLines` shows, from `line <first>` to `line <last>`. */
function texts(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, index) => `line ${pad(first + index)}`)
}

/** `count` rows of two lines each: `row 01 a` and `row 01 b` in the row `row-01`, and so on. */
function tallRows(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(2, '0')
    return ['a', 'b'].map((part) => {
      const line: Line = { rowId: `row-${number}`, segments: [{ text: `row ${number} ${part}` }] }
      return line
    })
  }).flat()
}

/** The line of a bash call that waits for an approval. Its spinner has the first frame, `⠋`. */
function waitingLine(rowId: string) {
  const line: Line = {
    rowId,
    segments: [
      { text: '│  ◆ bash      node --test  ', fg: color.linen },
      { text: '⠋', fg: color.weld },
      { text: ' needs you', fg: color.weld },
    ],
  }
  return line
}

/** The timeline with its props in state, so that `controls.update` can change them. */
function Stage({ initial, controls }: { initial: TimelineProps; controls: Controls }) {
  const [props, setProps] = useState(initial)
  controls.update = (patch) => setProps((current) => ({ ...current, ...patch }))
  return <Timeline {...props} />
}

/**
 * Render a timeline in the test terminal. It is focused, not live, and has
 * 100 lines, unless `props` says otherwise. `calls` keeps each call of
 * `onSelect` and `onOpen`, in order. The renderer runs on `clock`, so time
 * moves only with `advance`. Each change runs inside act(), then draws the
 * next frame. Dispose it with `await using`.
 */
async function mountTimeline(props: Partial<TimelineProps>) {
  const clock = new IntervalClock()
  const calls: Array<[string, string]> = []
  const controls: Controls = {
    update: () => {
      throw new Error('The timeline did not render.')
    },
  }
  const initial: TimelineProps = {
    lines: numberedLines(100),
    width: WIDTH,
    height: HEIGHT,
    focused: true,
    live: false,
    onSelect: (rowId) => calls.push(['select', rowId]),
    onOpen: (rowId) => calls.push(['open', rowId]),
    ...props,
  }
  const setup = await testRender(<Stage initial={initial} controls={controls} />, {
    width: WIDTH,
    height: HEIGHT,
    clock,
  })
  await setup.renderOnce()
  const step = async (change: () => unknown) => {
    await act(async () => {
      await change()
    })
    await setup.renderOnce()
  }
  /** The rows of the terminal, without the spaces at their ends. */
  const rows = () =>
    setup
      .captureCharFrame()
      .split('\n')
      .slice(0, HEIGHT)
      .map((row) => row.trimEnd())
  return {
    calls,
    clock,
    rows,
    /** The number of rows with a spinner that shows `frame`, then `needs you`. */
    spinnersWith: (frame: string) => rows().filter((row) => row.endsWith(`${frame} needs you`)).length,
    /** The hex background color of the first text run that has `text`. */
    bgOf: (text: string) => {
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      const span = spans.find((candidate) => candidate.text.includes(text))
      return span && rgbToHex(span.bg)
    },
    press: (send: (keys: MockInput) => unknown) => step(() => send(setup.mockInput)),
    mouse: (send: (mouse: MockMouse) => unknown) => step(() => send(setup.mockMouse)),
    update: (patch: Partial<TimelineProps>) => step(() => controls.update(patch)),
    advance: (ms: number) => step(() => clock.advance(ms)),
    // The renderer unmounts the React root when it is destroyed.
    // act() tells React that this update is expected in a test.
    [Symbol.asyncDispose]: () => act(() => setup.dispose()),
  }
}

describe('Timeline window', () => {
  test('shows the last lines', async () => {
    await using timeline = await mountTimeline({})
    expect(timeline.rows()).toEqual(texts(91, 100))
  })

  test('pageup shows older lines and stops following', async () => {
    await using timeline = await mountTimeline({})
    await timeline.press((keys) => keys.pressKey(PAGE_UP))
    // A page is one line less than the window, so line 091 stays in view.
    expect(timeline.rows()).toEqual(texts(82, 91))
    await timeline.press((keys) => keys.pressKey(PAGE_UP))
    expect(timeline.rows()).toEqual(texts(73, 82))
    await timeline.press((keys) => keys.pressKey(PAGE_DOWN))
    expect(timeline.rows()).toEqual(texts(82, 91))
    await timeline.update({ lines: numberedLines(101) })
    expect(timeline.rows()).toEqual([...texts(82, 90), expect.stringMatching(/^line 091 +↓ 1 new$/)])
  })

  test('end follows again', async () => {
    await using timeline = await mountTimeline({})
    await timeline.press((keys) => keys.pressKey('HOME'))
    expect(timeline.rows()).toEqual(texts(1, 10))
    await timeline.update({ lines: numberedLines(103) })
    expect(timeline.rows()).toEqual([...texts(1, 9), expect.stringMatching(/^line 010 +↓ 3 new$/)])
    await timeline.press((keys) => keys.pressKey('END'))
    expect(timeline.rows()).toEqual(texts(94, 103))
    await timeline.update({ lines: numberedLines(104) })
    expect(timeline.rows()).toEqual(texts(95, 104))
    // home selects the first row, and end the last row.
    expect(timeline.calls).toEqual([
      ['select', 'row-001'],
      ['select', 'row-103'],
    ])
  })

  test('new lines do not move the view while reading', async () => {
    await using timeline = await mountTimeline({})
    await timeline.press((keys) => keys.pressKey(PAGE_UP))
    // 4 lines come under the window.
    await timeline.update({ lines: numberedLines(104) })
    expect(timeline.rows()).toEqual([...texts(82, 90), expect.stringMatching(/^line 091 +↓ 4 new$/)])
    // 3 lines come above the window, as when a subagent branch grows.
    const branch = ['one', 'two', 'three'].map((word) => {
      const line: Line = { rowId: 'branch', segments: [{ text: `branch ${word}` }] }
      return line
    })
    await timeline.update({ lines: [...numberedLines(50), ...branch, ...numberedLines(104, 51)] })
    expect(timeline.rows().slice(0, -1)).toEqual(texts(82, 90))
    expect(timeline.rows().at(-1)).toStartWith('line 091')
  })

  test('mouse wheel scrolls', async () => {
    // The wheel scrolls also while the pane is not focused.
    await using timeline = await mountTimeline({ focused: false })
    await timeline.mouse((mouse) => mouse.scroll(5, 5, 'up'))
    expect(timeline.rows()).toEqual(texts(88, 97))
    await timeline.mouse((mouse) => mouse.scroll(5, 5, 'down'))
    expect(timeline.rows()).toEqual(texts(91, 100))
    // Back at the last lines, the window follows them again.
    await timeline.update({ lines: numberedLines(101) })
    expect(timeline.rows()).toEqual(texts(92, 101))
  })
})

describe('Timeline selection', () => {
  test('enter opens the selected row', async () => {
    await using timeline = await mountTimeline({})
    // The keys come before React draws again. The first ↑ selects the last
    // row in the window, and the second one the row above it.
    await timeline.press((keys) => {
      keys.pressArrow('up')
      keys.pressArrow('up')
    })
    expect(timeline.bgOf('line 099')).toBe(SELECTED_BG)
    expect(timeline.bgOf('line 100')).not.toBe(SELECTED_BG)
    await timeline.press((keys) => keys.pressEnter())
    expect(timeline.calls).toEqual([
      ['select', 'row-100'],
      ['select', 'row-099'],
      ['open', 'row-099'],
    ])
  })

  test('the selected row stays in view', async () => {
    // 30 rows of two lines each. The window shows rows 26 to 30.
    await using timeline = await mountTimeline({ lines: tallRows(30) })
    // The first ↑ selects row 30, and 9 more go up to row 21.
    await timeline.press((keys) => {
      for (let press = 0; press < 10; press += 1) keys.pressArrow('up')
    })
    // The window moves up only as far as it must to show row 21.
    expect(timeline.rows()[0]).toBe('row 21 a')
    expect(timeline.rows().at(-1)).toBe('row 25 b')
    await timeline.press((keys) => {
      for (let press = 0; press < 7; press += 1) keys.pressArrow('down')
    })
    // Row 28 is selected. The window moves down only as far as it must to show its two lines.
    expect(timeline.rows()[0]).toBe('row 24 a')
    expect(timeline.rows().at(-1)).toBe('row 28 b')
    expect(timeline.bgOf('row 28 a')).toBe(SELECTED_BG)
    expect(timeline.bgOf('row 28 b')).toBe(SELECTED_BG)
  })

  test('a page key keeps the selection in the window', async () => {
    await using timeline = await mountTimeline({})
    await timeline.press((keys) => {
      keys.pressArrow('up')
      keys.pressKey(PAGE_UP)
    })
    // Row 100 went out under the window, so the last row in the window is selected.
    expect(timeline.bgOf('line 091')).toBe(SELECTED_BG)
    await timeline.press((keys) => {
      keys.pressKey('HOME')
      keys.pressKey(PAGE_DOWN)
    })
    // Row 001 went out above the window, so the first row in the window is selected.
    expect(timeline.bgOf('line 010')).toBe(SELECTED_BG)
    expect(timeline.calls).toEqual([
      ['select', 'row-100'],
      ['select', 'row-091'],
      ['select', 'row-001'],
      ['select', 'row-010'],
    ])
  })

  test('the selection stays on its row when lines change', async () => {
    await using timeline = await mountTimeline({})
    await timeline.press((keys) => {
      keys.pressArrow('up')
      keys.pressArrow('up')
    })
    await timeline.update({ lines: numberedLines(103) })
    expect(timeline.bgOf('line 099')).toBe(SELECTED_BG)
    // When no line has the selected row any more, no row is selected, so enter does nothing.
    await timeline.update({ lines: numberedLines(103).filter((line) => line.rowId !== 'row-099') })
    await timeline.press((keys) => keys.pressEnter())
    expect(timeline.calls).toEqual([
      ['select', 'row-100'],
      ['select', 'row-099'],
    ])
  })

  test('selectedRowId selects its row', async () => {
    await using timeline = await mountTimeline({ selectedRowId: 'row-095' })
    expect(timeline.bgOf('line 095')).toBe(SELECTED_BG)
    await timeline.update({ selectedRowId: 'row-093' })
    expect(timeline.bgOf('line 093')).toBe(SELECTED_BG)
    expect(timeline.bgOf('line 095')).not.toBe(SELECTED_BG)
    // The keys move the selection from the new row.
    await timeline.press((keys) => {
      keys.pressArrow('up')
      keys.pressEnter()
    })
    expect(timeline.calls).toEqual([
      ['select', 'row-092'],
      ['open', 'row-092'],
    ])
  })

  test('keys do nothing while the pane is not focused', async () => {
    await using timeline = await mountTimeline({ focused: false })
    await timeline.press((keys) => {
      keys.pressArrow('up')
      keys.pressKey(PAGE_UP)
      keys.pressKey('HOME')
      keys.pressEnter()
    })
    expect(timeline.rows()).toEqual(texts(91, 100))
    expect(timeline.calls).toEqual([])
  })
})

describe('Timeline spinner', () => {
  test('the spinner turns while live', async () => {
    const lines = [...numberedLines(7), waitingLine('bash-1'), waitingLine('bash-2')]
    await using timeline = await mountTimeline({ lines, live: true })
    // One timer turns both spinners.
    expect([...timeline.clock.intervals.values()]).toEqual([90])
    expect(timeline.spinnersWith('⠋')).toBe(2)
    await timeline.advance(90)
    expect(timeline.spinnersWith('⠙')).toBe(2)
    await timeline.advance(90)
    expect(timeline.spinnersWith('⠹')).toBe(2)
  })

  test('no timer when not live', async () => {
    const lines = [...numberedLines(7), waitingLine('bash-1')]
    await using timeline = await mountTimeline({ lines })
    expect(timeline.clock.intervals.size).toBe(0)
    await timeline.advance(900)
    expect(timeline.spinnersWith('⠋')).toBe(1)
  })

  test('no timer while no spinner is in the window', async () => {
    const lines = [...numberedLines(99), waitingLine('bash-1')]
    await using timeline = await mountTimeline({ lines, live: true })
    expect([...timeline.clock.intervals.values()]).toEqual([90])
    await timeline.press((keys) => keys.pressKey(PAGE_UP))
    expect(timeline.clock.intervals.size).toBe(0)
    await timeline.press((keys) => keys.pressKey('END'))
    expect([...timeline.clock.intervals.values()]).toEqual([90])
  })
})
