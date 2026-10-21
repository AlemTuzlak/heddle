import { expect, test } from 'bun:test'
import { rgbToHex } from '@opentui/core'
import type { MockInput } from '@opentui/core/testing'
import { testRender } from '@opentui/react/test-utils'
import type { FileChange } from '@tanstack/ai-harness/plugins/coding'
import { act, useSyncExternalStore, type ComponentProps } from 'react'
import { applyChange, type ChangesState } from '../state/changes'
import { Changes } from './Changes'
import { color, createSyntaxStyle } from './theme'

const ROOT = '/work'

/**
 * A unified diff of `rel` with one hunk from line 1. Each line starts with
 * ' ' (the same), '-' (deleted), or '+' (added).
 */
function unifiedPatch(rel: string, lines: ReadonlyArray<string>) {
  const before = lines.filter((line) => !line.startsWith('+')).length
  const after = lines.filter((line) => !line.startsWith('-')).length
  return [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -1,${before} +1,${after} @@`,
    ...lines,
    '',
  ].join('\n')
}

/** A change of `rel` with the diff of `lines`, and the counts of its added and deleted lines. */
function edit(rel: string, lines: ReadonlyArray<string>, fields: Partial<FileChange> = {}) {
  const change: FileChange = {
    path: `${ROOT}/${rel}`,
    change: 'updated',
    patch: unifiedPatch(rel, lines),
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    ...fields,
  }
  return change
}

/** The fix of the mockup: +1 −1. */
const FIX_ADD = edit('src/math.mjs', [
  ' /** Add two numbers. */',
  ' export function add(a, b) {',
  '-  return a - b',
  '+  return a + b',
  ' }',
])

/** The second change of the math file: +1 −0. */
const NOTE_SUB = edit('src/math.mjs', [
  ' export function sub(a, b) {',
  '+  // Subtract b from a.',
  '   return a - b',
  ' }',
])

/** The third change of the math file. */
const NOTE_ADD = edit('src/math.mjs', [
  ' export function add(a, b) {',
  '+  // Add a and b.',
  '   return a + b',
  ' }',
])

/** The fourth change of the math file. */
const REWORD_SUB = edit('src/math.mjs', [
  ' export function sub(a, b) {',
  '-  // Subtract b from a.',
  '+  // Take b from a.',
  '   return a - b',
  ' }',
])

/** The new tests of the mockup: +6 −0. */
const ADD_TESTS = edit('test/math.test.mjs', [
  ' import { add } from "../src/math.mjs"',
  '+test("adds", () => {',
  '+  assert.equal(add(1, 2), 3)',
  '+})',
  '+test("adds negative numbers", () => {',
  '+  assert.equal(add(-1, -2), -3)',
  '+})',
])

/** The second change of the test file. */
const IMPORT_SUB = edit('test/math.test.mjs', [
  ' import { add } from "../src/math.mjs"',
  '+import { sub } from "../src/math.mjs"',
])

/** The state after `changes`, in their order. Their times are 1000, 2000, and so on. */
function stateOf(...changes: Array<FileChange>) {
  let state: ChangesState = { files: [] }
  for (const [index, change] of changes.entries()) {
    state = applyChange(state, change, ROOT, (index + 1) * 1000)
  }
  return state
}

type ChangesProps = ComponentProps<typeof Changes>

/** Props that the test can change after the first render. */
function createProps() {
  let props: ChangesProps | undefined
  const listeners = new Set<() => void>()
  return {
    get: () => props,
    set: (next: ChangesProps) => {
      props = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** It draws `Changes` with the props of the moment. It draws nothing before the first props. */
function Stage({ props }: { props: ReturnType<typeof createProps> }) {
  const current = useSyncExternalStore(props.subscribe, props.get)
  return current === undefined ? null : <Changes {...current} />
}

/**
 * Render the pane with `state` in a test terminal. The pane fills the
 * terminal, unless `terminalWidth` is wider. `update` draws a new state, as
 * when a file change comes. `input` sends keys inside act(), and draws the
 * next frame. Dispose it with `await using`.
 */
async function mountChanges(
  state: ChangesState,
  options: { width?: number; height?: number; focused?: boolean; terminalWidth?: number } = {},
) {
  const { width = 60, height = 16, focused = true } = options
  const props = createProps()
  const setup = await testRender(<Stage props={props} />, {
    width: options.terminalWidth ?? width,
    height,
  })
  // The style belongs to the renderer, so it comes after the first render.
  const syntaxStyle = createSyntaxStyle(setup.renderer)
  const update = async (next: ChangesState) => {
    act(() => props.set({ state: next, width, height, focused, syntaxStyle }))
    await setup.renderOnce()
  }
  await update(state)
  const frame = () => setup.captureCharFrame()
  const lineWith = (text: string) => frame().split('\n').find((line) => line.includes(text)) ?? ''
  return {
    frame,
    lineWith,
    /** The lines of the frame, without the spaces at their end. */
    rows: () => frame().split('\n').map((line) => line.trimEnd()),
    /** The line over the diff, with the path and `patch N of M`. */
    header: () => lineWith('patch '),
    /** The runs of text of the first line that has `text`, with their hex colors. */
    spansOf: (text: string) => {
      const lines = setup.captureSpans().lines
      const line = lines.find((candidate) =>
        candidate.spans.map((span) => span.text).join('').includes(text),
      )
      return (line?.spans ?? []).map((span) => ({
        text: span.text,
        fg: rgbToHex(span.fg),
        bg: rgbToHex(span.bg),
      }))
    },
    update,
    input: async (send: (keys: MockInput) => unknown) => {
      await act(async () => {
        await send(setup.mockInput)
      })
      await setup.renderOnce()
    },
    [Symbol.asyncDispose]: async () => {
      // The renderer unmounts the React root when it is destroyed.
      // act() tells React that this update is expected in a test.
      await act(() => setup.dispose())
      // The diff uses the style until it is gone.
      syntaxStyle.destroy()
    },
  }
}

test('lists files with counts', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD, ADD_TESTS))
  // As in the mockup: the bar grows with the lines. The newest change is selected.
  expect(screen.lineWith('src/math.mjs')).toMatch(/^ {2}src\/math\.mjs +▮▮ +\+1 −1$/)
  expect(screen.lineWith('test/math.test.mjs')).toMatch(/^▎ test\/math\.test\.mjs +▮▮▮ +\+6 −0$/)
  const marks = (text: string) =>
    screen
      .spansOf(text)
      .filter((span) => /[▮+−]/.test(span.text))
      .map(({ text: mark, fg }) => ({ mark, fg }))
  expect(marks('src/math.mjs')).toEqual([
    { mark: '▮', fg: color.woad },
    { mark: '▮', fg: color.madder },
    { mark: '+1', fg: color.woad },
    { mark: '−1', fg: color.madder },
  ])
  // A count of 0 is faint.
  expect(marks('test/math.test.mjs')).toEqual([
    { mark: '▮▮▮', fg: color.woad },
    { mark: '+6', fg: color.woad },
    { mark: '−0', fg: color.faint },
  ])
})

test('+N −N shows the sums', async () => {
  // The newest patch is +1 −0, and the file has +2 −1 in all.
  await using screen = await mountChanges(stateOf(FIX_ADD, NOTE_SUB))
  expect(screen.lineWith('src/math.mjs')).toMatch(/\+2 −1$/)
})

test('the empty state shows a plain line', async () => {
  await using screen = await mountChanges({ files: [] })
  expect(screen.frame().trim()).toBe('No file changes yet.')
})

test('follows the newest change', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD, ADD_TESTS))
  expect(screen.header()).toMatch(/^test\/math\.test\.mjs +patch 1 of 1  updated$/)
  expect(screen.frame()).toContain('adds negative numbers')

  await screen.update(stateOf(FIX_ADD, ADD_TESTS, NOTE_SUB))
  expect(screen.lineWith('src/math.mjs')).toStartWith('▎')
  expect(screen.header()).toMatch(/^src\/math\.mjs +patch 2 of 2  updated$/)
  expect(screen.frame()).toContain('Subtract b from a.')
  expect(screen.frame()).not.toContain('adds negative numbers')
})

test('a pick pins the file, and f follows again', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD, ADD_TESTS))
  await screen.input((keys) => keys.pressArrow('up'))
  expect(screen.lineWith('src/math.mjs')).toStartWith('▎')
  expect(screen.header()).toMatch(/^src\/math\.mjs +patch 1 of 1  updated$/)

  // A change of the other file does not move the view, but its row shows the new counts.
  await screen.update(stateOf(FIX_ADD, ADD_TESTS, IMPORT_SUB))
  expect(screen.header()).toMatch(/^src\/math\.mjs /)
  expect(screen.frame()).toContain('return a + b')
  expect(screen.lineWith('test/math.test.mjs')).toMatch(/\+7 −0$/)

  await screen.input((keys) => keys.pressKey('f'))
  expect(screen.header()).toMatch(/^test\/math\.test\.mjs +patch 2 of 2  updated$/)
  expect(screen.frame()).toContain('import { sub }')
})

test('a pick and a step before React draws step the picked file', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD, NOTE_SUB, ADD_TESTS))
  await screen.input((keys) => {
    keys.pressArrow('up')
    keys.pressKey('[')
  })
  expect(screen.header()).toMatch(/^src\/math\.mjs +patch 1 of 2  updated$/)
  expect(screen.frame()).toContain('return a + b')
})

test('keys do nothing without the focus', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD, ADD_TESTS), { focused: false })
  await screen.input((keys) => keys.pressArrow('up'))
  expect(screen.header()).toMatch(/^test\/math\.test\.mjs /)
})

test('[ shows the older patch', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD, NOTE_SUB))
  expect(screen.header()).toMatch(/patch 2 of 2  updated$/)
  expect(screen.frame()).toContain('Subtract b from a.')

  // The keys come before React draws again. The second [ is at the oldest patch, so it does nothing.
  await screen.input((keys) => {
    keys.pressKey('[')
    keys.pressKey('[')
  })
  expect(screen.header()).toMatch(/patch 1 of 2  updated$/)
  expect(screen.frame()).toContain('return a + b')
  expect(screen.frame()).not.toContain('Subtract b from a.')

  await screen.input((keys) => keys.pressKey(']'))
  expect(screen.header()).toMatch(/patch 2 of 2  updated$/)
  expect(screen.frame()).toContain('Subtract b from a.')
})

test('a new patch shows the newest again, unless the user stepped back', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD, NOTE_SUB))
  await screen.input((keys) => keys.pressKey('['))
  await screen.update(stateOf(FIX_ADD, NOTE_SUB, NOTE_ADD))
  // The user is on an older patch, so the view stays on it.
  expect(screen.header()).toMatch(/patch 1 of 3  updated$/)
  expect(screen.frame()).not.toContain('Add a and b.')

  // Back on the newest patch, the view shows each new patch.
  await screen.input((keys) => {
    keys.pressKey(']')
    keys.pressKey(']')
  })
  await screen.update(stateOf(FIX_ADD, NOTE_SUB, NOTE_ADD, REWORD_SUB))
  expect(screen.header()).toMatch(/patch 4 of 4  updated$/)
  expect(screen.frame()).toContain('Take b from a.')
})

test('a step back ends when another file shows', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD, NOTE_SUB))
  await screen.input((keys) => keys.pressKey('['))
  await screen.update(stateOf(FIX_ADD, NOTE_SUB, ADD_TESTS))
  expect(screen.header()).toMatch(/^test\/math\.test\.mjs /)

  // The math file shows again, with its newest patch.
  await screen.update(stateOf(FIX_ADD, NOTE_SUB, ADD_TESTS, NOTE_ADD))
  expect(screen.header()).toMatch(/^src\/math\.mjs +patch 3 of 3  updated$/)
  expect(screen.frame()).toContain('Add a and b.')
})

test('a long path is cut with …', async () => {
  // 67 cells. Each 長 is 2 cells wide.
  const rel = `src/${'長'.repeat(30)}.ts`
  await using screen = await mountChanges(stateOf(edit(rel, ['-const a = 1', '+const a = 2'])))
  // The path keeps its end. The next 長 does not fit, so the cut is one cell short.
  expect(screen.lineWith('.ts')).toMatch(/^▎ …(長){21}\.ts +▮▮ +\+1 −1$/)
  expect(screen.header()).toMatch(/^…(長){16}\.ts +patch 1 of 1  updated$/)
  expect(screen.frame()).not.toContain('src/')
})

test('a long diff line wraps inside the pane', async () => {
  const line = `const text = '${'漢字 '.repeat(30)}tail'`
  await using screen = await mountChanges(stateOf(edit('src/text.ts', [`+${line}`])), {
    width: 40,
    terminalWidth: 60,
  })
  // The end of the line shows, so the line wraps and is not cut.
  expect(screen.frame()).toContain("tail'")
  // Nothing draws to the right of the pane.
  const widths = screen.frame().split('\n').map((row) => Bun.stringWidth(row.trimEnd()))
  expect(Math.max(...widths)).toBeLessThanOrEqual(40)
})

test('the diff tints the added and deleted rows', async () => {
  await using screen = await mountChanges(stateOf(FIX_ADD))
  const removed = screen.spansOf('return a - b')
  const added = screen.spansOf('return a + b')
  // The whole row has the tint, the line numbers too.
  expect(new Set(removed.map((span) => span.bg))).toEqual(new Set([color.madderBg]))
  expect(new Set(added.map((span) => span.bg))).toEqual(new Set([color.woadBg]))
  expect(removed.find((span) => span.text.trim() === '-')?.fg).toBe(color.madder)
  expect(added.find((span) => span.text.trim() === '+')?.fg).toBe(color.woad)
  expect(removed.find((span) => span.text.trim() === '3')?.fg).toBe(color.faint)
})

test('no diff text message', async () => {
  const image: FileChange = {
    path: `${ROOT}/assets/logo.png`,
    change: 'created',
    additions: 0,
    deletions: 0,
  }
  await using screen = await mountChanges(stateOf(FIX_ADD, image))
  expect(screen.header()).toMatch(/^assets\/logo\.png +patch 1 of 1  created$/)
  expect(screen.rows()).toContain('no diff for this file')
})

test('a deleted file shows deleted', async () => {
  const create = edit('src/old.ts', ['+const a = 1', '+const b = 2'], { change: 'created' })
  const remove = edit('src/old.ts', ['-const a = 1', '-const b = 2'], { change: 'deleted' })
  await using screen = await mountChanges(stateOf(create, remove))
  expect(screen.header()).toMatch(/patch 2 of 2  deleted$/)
  // The header says `deleted` too, so the check is for the line under it.
  expect(screen.rows()).toContain('deleted')
  expect(screen.frame()).not.toContain('const a = 1')

  // The older patch still has its diff.
  await screen.input((keys) => keys.pressKey('['))
  expect(screen.header()).toMatch(/patch 1 of 2  deleted$/)
  expect(screen.frame()).toContain('const a = 1')
})

test('a move with no edit shows no line changed', async () => {
  const move: FileChange = {
    path: `${ROOT}/lib/math.mjs`,
    from: `${ROOT}/src/math.mjs`,
    change: 'moved',
    patch: 'diff --git a/src/math.mjs b/lib/math.mjs\nrename from src/math.mjs\nrename to lib/math.mjs\n',
    additions: 0,
    deletions: 0,
  }
  await using screen = await mountChanges(stateOf(FIX_ADD))
  expect(screen.frame()).toContain('return a + b')

  await screen.update(stateOf(FIX_ADD, move))
  expect(screen.header()).toMatch(/^lib\/math\.mjs +patch 2 of 2  moved$/)
  expect(screen.rows()).toContain('no line changed')
  // The diff of the patch before does not stay on the screen.
  expect(screen.frame()).not.toContain('return a + b')
})

test('a long list keeps the selected file in view', async () => {
  const names = Array.from({ length: 10 }, (_, index) => `file-${String(index + 1).padStart(2, '0')}.ts`)
  const state = stateOf(...names.map((name) => edit(name, ['+export {}'], { change: 'created' })))
  // 16 rows give the list 5 rows.
  await using screen = await mountChanges(state)
  expect(screen.lineWith('file-10.ts')).toStartWith('▎')
  expect(screen.frame()).toContain('file-06.ts')
  expect(screen.frame()).not.toContain('file-05.ts')

  await screen.input((keys) => {
    for (const _ of names) keys.pressArrow('up')
  })
  expect(screen.lineWith('file-01.ts')).toStartWith('▎')
  expect(screen.frame()).not.toContain('file-10.ts')
})
