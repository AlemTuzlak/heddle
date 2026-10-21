import { describe, expect, test } from 'bun:test'
import { rgbToHex, type TextareaRenderable } from '@opentui/core'
import type { MockInput } from '@opentui/core/testing'
import { testRender } from '@opentui/react/test-utils'
import { act, createRef, type ComponentProps, type ReactNode } from 'react'
import { Palette, type PaletteItem } from './Palette'
import { SessionPicker, type SessionRow } from './SessionPicker'
import { color } from './theme'

/** OpenTUI sends a lone esc as a key after 20 ms. Wait a little more. */
const ESCAPE_WAIT_MS = 40

const NOW = Date.UTC(2026, 9, 21, 9, 41)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The sessions of the mockup, from the newest. `s1` is the open session. */
const SESSIONS: ReadonlyArray<SessionRow> = [
  {
    id: 's1',
    title: 'Fix the failing add test',
    status: 'live',
    place: 'docker',
    updatedAt: NOW - 10_000,
    cost: 0.38,
  },
  {
    id: 's2',
    title: 'Add input checks',
    status: 'needs-you',
    place: 'local',
    updatedAt: NOW - 2 * HOUR,
    cost: 0.12,
  },
  {
    id: 's3',
    title: 'Move the math tests to vitest',
    status: 'done',
    place: 'docker',
    updatedAt: NOW - DAY - HOUR,
    cost: 0.71,
  },
  {
    id: 's4',
    title: 'Explain the sub helper',
    status: 'done',
    place: 'local',
    updatedAt: NOW - 3 * DAY,
  },
]

/**
 * Render `node` in a test terminal. `input` sends keys inside act(), and
 * draws the next frame. Dispose it with `await using`.
 */
async function mount(node: ReactNode, size = { width: 100, height: 20 }) {
  const setup = await testRender(node, size)
  await setup.renderOnce()
  const frame = () => setup.captureCharFrame()
  return {
    frame,
    /** The first line of the frame that has `text`. */
    lineWith: (text: string) => frame().split('\n').find((line) => line.includes(text)) ?? '',
    /** The hex color of the first text run that has `text`. */
    colorOf: (text: string) => {
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      const span = spans.find((candidate) => candidate.text.includes(text))
      return span && rgbToHex(span.fg)
    },
    input: async (send: (keys: MockInput) => unknown, waitMs = 0) => {
      await act(async () => {
        await send(setup.mockInput)
        await Bun.sleep(waitMs)
      })
      await setup.renderOnce()
    },
    // The renderer unmounts the React root when it is destroyed.
    // act() tells React that this update is expected in a test.
    [Symbol.asyncDispose]: () => act(() => setup.dispose()),
  }
}

/** A picker of `SESSIONS`. `calls` keeps each call of its callbacks, in order. */
function createPicker(props: Partial<ComponentProps<typeof SessionPicker>> = {}) {
  const calls: Array<Array<string>> = []
  const element = (
    <SessionPicker
      sessions={SESSIONS}
      currentId="s1"
      now={NOW}
      onOpen={(id) => calls.push(['open', id])}
      onNew={() => calls.push(['new'])}
      onFork={(id) => calls.push(['fork', id])}
      onRename={(id, title) => calls.push(['rename', id, title])}
      onClose={() => calls.push(['close'])}
      {...props}
    />
  )
  return { element, calls }
}

/** Render a picker from `createPicker`. */
async function mountPicker(
  props: Partial<ComponentProps<typeof SessionPicker>> = {},
  size?: { width: number; height: number },
) {
  const { element, calls } = createPicker(props)
  return Object.assign(await mount(element, size), { calls })
}

/** A palette of three commands. `log` keeps each close and each run, in order. */
function createPalette() {
  const log: Array<string> = []
  const items: ReadonlyArray<PaletteItem> = [
    { label: 'New session', detail: 'ctrl+n', run: () => log.push('run New session') },
    { label: 'Switch the model', detail: '/model', run: () => log.push('run Switch the model') },
    { label: 'Connect a provider', detail: '/connect', run: () => log.push('run Connect a provider') },
  ]
  const element = <Palette items={items} onClose={() => log.push('close')} />
  return { element, log }
}

/** Render a palette from `createPalette`. */
async function mountPalette() {
  const { element, log } = createPalette()
  return Object.assign(await mount(element), { log })
}

/** A done session `Session 01`, `Session 02`, and so on. One hour older for each number. */
function createSession(number: number) {
  const session: SessionRow = {
    id: `s${number}`,
    title: `Session ${String(number).padStart(2, '0')}`,
    status: 'done',
    place: 'local',
    updatedAt: NOW - number * HOUR,
  }
  return session
}

describe('SessionPicker', () => {
  test('lists sessions with status glyphs', async () => {
    await using picker = await mountPicker()
    expect(picker.lineWith('Sessions')).toContain('4 in this folder')
    expect(picker.lineWith('Fix the failing add test')).toMatch(
      /● Fix the failing add test \(current\) +live +docker +now +\$0\.38/,
    )
    expect(picker.lineWith('Add input checks')).toMatch(
      /◌ Add input checks +needs you +local +2 hours ago +\$0\.12/,
    )
    expect(picker.lineWith('Move the math tests')).toMatch(
      /✓ Move the math tests to vitest +done +docker +yesterday +\$0\.71/,
    )
    // This session has no cost, so its row ends with the time.
    const noCost = picker.lineWith('Explain the sub helper')
    expect(noCost).toMatch(/✓ Explain the sub helper +done +local +3 days ago +│/)
    expect(noCost).not.toContain('$')
    expect(picker.colorOf('●')).toBe(color.indigo)
    expect(picker.colorOf('◌')).toBe(color.weld)
    expect(picker.colorOf('✓')).toBe(color.muted)
    expect(picker.frame()).toContain('↑↓ move   enter resume   f fork   r rename   n new   esc close')
  })

  test('the picker is a centered box over the screen', async () => {
    const { element } = createPicker()
    const filler = 'x'.repeat(100)
    // The picker comes first, so the text after it would draw over it without the zIndex.
    await using screen = await mount(
      <box width="100%" height="100%">
        {element}
        {Array.from({ length: 20 }, (_, row) => (
          <text key={row}>{filler}</text>
        ))}
      </box>,
    )
    const lines = screen.frame().split('\n')
    // The box is 82 of the 100 columns, so 9 columns stay free at each side.
    // It starts on the second row, so the first row (the header of heddle) still shows.
    expect(lines[0]).toBe(filler)
    expect(lines[1]).toBe(`${'x'.repeat(9)}╭${'─'.repeat(80)}╮${'x'.repeat(9)}`)
  })

  test('search filters', async () => {
    await using picker = await mountPicker()
    await picker.input((keys) => keys.typeText('add'))
    const frame = picker.frame()
    expect(frame).toContain('⌕ add')
    expect(frame).toContain('Fix the failing add test')
    // The search ignores case: "Add input checks" has "add".
    expect(frame).toContain('Add input checks')
    expect(frame).not.toContain('Move the math tests to vitest')
    expect(frame).not.toContain('Explain the sub helper')
  })

  test('a paste goes into the search, and selects the first match', async () => {
    await using picker = await mountPicker()
    await picker.input(async (keys) => {
      // Select the third session. It has "the" in its title too.
      keys.pressArrow('down')
      keys.pressArrow('down')
      await keys.pasteBracketedText('the')
    })
    expect(picker.frame()).toContain('⌕ the')
    expect(picker.frame()).not.toContain('Add input checks')
    await picker.input((keys) => keys.pressEnter())
    expect(picker.calls).toEqual([['close'], ['open', 's1']])
  })

  test('a search with no match says so', async () => {
    await using picker = await mountPicker()
    await picker.input((keys) => keys.typeText('zzz'))
    expect(picker.frame()).toContain('No session matches the search.')
    await picker.input((keys) => keys.pressEnter())
    expect(picker.calls).toEqual([])
  })

  test('enter opens the selected id', async () => {
    await using picker = await mountPicker()
    // The keys come before React draws again.
    await picker.input((keys) => {
      keys.pressArrow('down')
      keys.pressArrow('down')
      keys.pressArrow('up')
      keys.pressEnter()
    })
    expect(picker.calls).toEqual([['close'], ['open', 's2']])
  })

  test('f forks the selected id', async () => {
    await using picker = await mountPicker()
    await picker.input((keys) => {
      keys.pressArrow('down')
      keys.pressKey('f')
    })
    expect(picker.calls).toEqual([['close'], ['fork', 's2']])
  })

  test('n calls onNew', async () => {
    await using picker = await mountPicker()
    await picker.input((keys) => keys.pressKey('n'))
    expect(picker.calls).toEqual([['close'], ['new']])
  })

  test('r renames', async () => {
    await using picker = await mountPicker()
    await picker.input((keys) => {
      keys.pressArrow('down')
      keys.pressKey('r')
    })
    // The field starts with the old title, then the cursor.
    expect(picker.lineWith('Add input checks')).toContain('◌ Add input checks  ')
    expect(picker.frame()).toContain('enter save   esc cancel')
    // `f`, `r`, and `n` type into the field.
    await picker.input(async (keys) => {
      for (const _ of 'checks') keys.pressBackspace()
      await keys.typeText('rules for names')
    })
    expect(picker.frame()).toContain('◌ Add input rules for names ')
    await picker.input((keys) => keys.pressEnter())
    // The picker stays open.
    expect(picker.calls).toEqual([['rename', 's2', 'Add input rules for names']])
    expect(picker.frame()).toContain('enter resume')
  })

  test('esc cancels a rename', async () => {
    await using picker = await mountPicker()
    await picker.input(async (keys) => {
      keys.pressKey('r')
      await keys.typeText(' now')
    })
    expect(picker.frame()).toContain('Fix the failing add test now')
    await picker.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(picker.frame()).toContain('Fix the failing add test (current)')
    expect(picker.frame()).not.toContain('add test now')
    expect(picker.calls).toEqual([])
  })

  test('esc closes', async () => {
    await using picker = await mountPicker()
    await picker.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(picker.calls).toEqual([['close']])
  })

  test('typing f in the search does not fork', async () => {
    await using picker = await mountPicker()
    // The keys come before React draws again, so the picker must read the search of the moment.
    await picker.input((keys) => keys.typeText('the failing'))
    expect(picker.frame()).toContain('⌕ the failing')
    expect(picker.frame()).toContain('Fix the failing add test')
    expect(picker.frame()).not.toContain('Add input checks')
    expect(picker.calls).toEqual([])
  })

  test('a capital F starts a search', async () => {
    await using picker = await mountPicker()
    await picker.input((keys) => keys.typeText('Fix'))
    expect(picker.frame()).toContain('⌕ Fix')
    expect(picker.frame()).not.toContain('Add input checks')
    expect(picker.calls).toEqual([])
  })

  test('the empty list shows the hint', async () => {
    await using picker = await mountPicker({ sessions: [] })
    expect(picker.frame()).toContain('0 in this folder')
    expect(picker.frame()).toContain('No sessions in this folder yet. Press n to start one.')
    // With no row, enter does nothing.
    await picker.input((keys) => keys.pressEnter())
    expect(picker.calls).toEqual([])
  })

  test('a long title is cut with …', async () => {
    const title =
      'Refactor the session store so that each write goes through one queue and nothing gets lost'
    await using picker = await mountPicker({
      sessions: [{ id: 'long', title, status: 'live', place: 'docker', updatedAt: NOW, cost: 0.38 }],
    })
    // The cut is at the end of the title, and the other columns still show.
    expect(picker.lineWith('Refactor the session store')).toMatch(
      /● Refactor the session store \S.*… +live +docker +now +\$0\.38/,
    )
    expect(picker.frame()).not.toContain('nothing gets lost')
  })

  test('a narrow terminal hides the status words', async () => {
    await using picker = await mountPicker({}, { width: 60, height: 20 })
    expect(picker.lineWith('Add input checks')).toMatch(
      /◌ Add input checks +local +2 hours ago +\$0\.12/,
    )
    expect(picker.frame()).not.toContain('needs you')
  })

  test('the list scrolls to keep the selected row in view', async () => {
    const sessions = Array.from({ length: 30 }, (_, index) => createSession(index + 1))
    // 20 rows of terminal leave room for 10 sessions.
    await using picker = await mountPicker({ sessions })
    await picker.input((keys) => {
      for (let step = 0; step < 15; step += 1) keys.pressArrow('down')
    })
    expect(picker.lineWith('Session 16')).toContain('▎')
    expect(picker.frame()).not.toContain('Session 01')
    await picker.input((keys) => keys.pressEnter())
    expect(picker.calls).toEqual([['close'], ['open', 's16']])
  })
})

describe('Palette', () => {
  test('palette enter runs the item', async () => {
    await using palette = await mountPalette()
    expect(palette.lineWith('Switch the model')).toMatch(/Switch the model +\/model/)
    await palette.input((keys) => keys.typeText('MODEL'))
    expect(palette.frame()).toContain('Switch the model')
    expect(palette.frame()).not.toContain('New session')
    await palette.input((keys) => keys.pressEnter())
    // It closes first, so a command can open another overlay.
    expect(palette.log).toEqual(['close', 'run Switch the model'])
  })

  test('palette arrows move the selection', async () => {
    await using palette = await mountPalette()
    await palette.input((keys) => {
      keys.pressArrow('down')
      keys.pressArrow('down')
      keys.pressArrow('down')
      keys.pressArrow('up')
      keys.pressEnter()
    })
    expect(palette.log).toEqual(['close', 'run Switch the model'])
  })

  test('palette esc closes', async () => {
    await using palette = await mountPalette()
    await palette.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(palette.log).toEqual(['close'])
  })
})

describe('both overlays', () => {
  test.each([
    ['picker', () => createPicker().element],
    ['palette', () => createPalette().element],
  ])('a focused input under the %s gets no keys and no paste', async (_, overlay) => {
    const composer = createRef<TextareaRenderable>()
    await using screen = await mount(
      <box width="100%" height="100%">
        <textarea ref={composer} focused />
        {overlay()}
      </box>,
    )
    await screen.input(async (keys) => {
      await keys.typeText('add')
      await keys.pasteBracketedText(' more')
    })
    expect(screen.frame()).toContain('⌕ add more')
    expect(composer.current?.plainText).toBe('')
  })
})
