import { describe, expect, test } from 'bun:test'
import { useKeyboard } from '@opentui/react'
import type { ViewCommand } from '@tanstack/ai-harness/view'
import { useState } from 'react'
import type { Suggestion } from '../state/commands'
import { Composer } from './Composer'
import { ESCAPE_WAIT_MS, mount } from './test-utils'
import { color } from './theme'

/**
 * shift+enter as a terminal with modifyOtherKeys sends it. A plain terminal
 * sends enter the same with and without shift, so `pressEnter({ shift: true })`
 * of the mock keys is a plain enter.
 */
const SHIFT_ENTER = '\x1b[27;2;13~'

/** ctrl+j as a terminal with modifyOtherKeys sends it. */
const CTRL_J = '\x1b[27;5;106~'

/** The test terminal. */
const SIZE = { width: 80, height: 20 }

const PLACEHOLDER = 'Ask heddle'

/** The text above the composer, in place of the panes of heddle. */
const FILLER = '~'.repeat(SIZE.width)

/**
 * Some commands of the heddle harness. With `mode` and `model`, the text
 * `/mode` matches two commands, and the first one is the text itself.
 */
const COMMANDS: ReadonlyArray<ViewCommand> = [
  {
    name: 'connect:anthropic',
    description: 'Connect Anthropic with your own key',
    owner: 'tanstack/provider-keys',
  },
  {
    name: 'connect:openai',
    description: 'Connect OpenAI with your own key',
    owner: 'tanstack/provider-keys',
  },
  { name: 'model', description: 'Show or switch the model', owner: 'tanstack/model-picker' },
  { name: 'mode', description: 'Show or switch the mode', owner: 'tanstack/permissions' },
  {
    name: 'goal',
    description: 'Work until a goal is met',
    owner: 'tanstack/goal',
    input: { type: 'string' },
  },
  {
    name: 'compact',
    description: 'Summarize the conversation to save tokens',
    owner: 'tanstack/compact',
  },
  { name: 'todos', description: 'Show the todo list', owner: 'tanstack/todos' },
]

/**
 * The composer as heddle shows it: under the panes, which this screen fills
 * with `~`. ctrl+o takes the focus away and gives it back, as the session
 * picker of heddle does. `sent` keeps each text that the composer sends.
 */
function Screen({ sent, history, paths }: {
  sent: Array<string>
  history?: ReadonlyArray<string>
  paths?: (text: string) => ReadonlyArray<Suggestion>
}) {
  const [focused, setFocused] = useState(true)
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'o') setFocused((value) => !value)
  })
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="column">
        {Array.from({ length: SIZE.height }, (_, row) => (
          <text key={row}>{FILLER}</text>
        ))}
      </box>
      <Composer
        commands={COMMANDS}
        focused={focused}
        placeholder={PLACEHOLDER}
        history={history}
        paths={paths}
        onSubmit={(text) => sent.push(text)}
      />
    </box>
  )
}

/** Render the `Screen`. `sent` keeps each text that the composer sends. */
async function mountComposer(
  options: { history?: ReadonlyArray<string>; paths?: (text: string) => ReadonlyArray<Suggestion> } = {},
) {
  const sent: Array<string> = []
  const screen = <Screen sent={sent} history={options.history} paths={options.paths} />
  return Object.assign(await mount(screen, SIZE), { sent })
}

/** The rows of a frame. */
function rowsOf(frame: string) {
  return frame.split('\n')
}

describe('Composer input', () => {
  test('the prompt is an indigo › in an indigo frame', async () => {
    await using screen = await mountComposer()
    expect(screen.lineWith('›')).toMatch(/^│ › Ask heddle +│$/)
    expect(screen.colorOf('›')).toBe(color.indigo)
    expect(screen.colorOf('╭')).toBe(color.indigoDim)
  })

  test('enter submits and clears', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.typeText('fix the add test'))
    expect(screen.lineWith('›')).toMatch(/^│ › fix the add test +│$/)
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['fix the add test'])
    // The input is empty again, so the placeholder shows.
    expect(screen.lineWith('›')).toMatch(/^│ › Ask heddle +│$/)
  })

  test('empty enter sends nothing', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.pressEnter())
    await screen.input(async (keys) => {
      await keys.typeText('   ')
      keys.pressEnter()
    })
    expect(screen.sent).toEqual([])
  })

  test.each([
    ['shift+enter', SHIFT_ENTER],
    ['ctrl+j', CTRL_J],
  ])('%s adds a line', async (_, newLine) => {
    await using screen = await mountComposer()
    await screen.input(async (keys) => {
      await keys.typeText('one')
      await keys.pressKeys([newLine])
      await keys.typeText('two')
    })
    expect(screen.sent).toEqual([])
    const rows = rowsOf(screen.frame())
    const first = rows.findIndex((row) => row.includes('› one'))
    expect(rows[first + 1]).toMatch(/^│ {3}two +│$/)
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['one\ntwo'])
  })

  test('a paste of 3 lines is one message', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.pasteBracketedText('one\ntwo\nthree'))
    // The new lines of a paste do not send.
    expect(screen.sent).toEqual([])
    expect(screen.frame()).toContain('three')
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['one\ntwo\nthree'])
  })

  test('the input grows to 6 lines, then scrolls', async () => {
    await using screen = await mountComposer()
    await screen.input(async (keys) => {
      await keys.typeText('line 1')
      for (let line = 2; line <= 8; line += 1) {
        await keys.pressKeys([SHIFT_ENTER])
        await keys.typeText(`line ${line}`)
      }
    })
    const rows = rowsOf(screen.frame())
    const top = rows.findLastIndex((row) => row.startsWith('╭'))
    const bottom = rows.findLastIndex((row) => row.startsWith('╰'))
    // 6 lines show between the borders: the last 6, where the cursor is.
    expect(bottom - top - 1).toBe(6)
    expect(rows[top + 1]).toMatch(/^│ › line 3 +│$/)
    expect(rows[bottom - 1]).toMatch(/^│ {3}line 8 +│$/)
    expect(screen.frame()).not.toContain('line 2')
  })

  test('keys do nothing while not focused', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.typeText('/co'))
    // ctrl+o takes the focus away, as the session picker does.
    await screen.input((keys) => keys.pressKey('o', { ctrl: true }))
    expect(screen.frame()).not.toContain('/compact')
    expect(screen.colorOf('╭')).toBe(color.line)
    await screen.input(async (keys) => {
      await keys.typeText('x')
      keys.pressArrow('down')
      keys.pressTab()
      keys.pressEnter()
      await keys.pasteBracketedText('pasted')
    })
    expect(screen.sent).toEqual([])
    expect(screen.lineWith('›')).toMatch(/^│ › \/co +│$/)
    // With the focus back, the popup shows again, and down did not move it.
    await screen.input((keys) => keys.pressKey('o', { ctrl: true }))
    expect(screen.lineWith('▎')).toContain('▎ /compact')
  })
})

describe('Composer popup', () => {
  test('/ shows suggestions', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.typeText('/'))
    const rows = rowsOf(screen.frame())
    const input = rows.findIndex((row) => row.includes('› /'))
    // Just above the input: the popup with the first 6 commands, over the
    // text above the composer. The connect commands are one row.
    expect(rows[input - 10]).toBe(FILLER)
    expect(rows[input - 9]).toMatch(/^╭─+╮$/)
    expect(rows.slice(input - 8, input - 2)).toEqual([
      expect.stringMatching(/^│ ▎ \/compact +Summarize the conversation to save tokens +│$/),
      expect.stringMatching(/^│ {3}\/connect +Connect a model provider or a server +│$/),
      expect.stringMatching(/^│ {3}\/exit +Quit heddle +│$/),
      expect.stringMatching(/^│ {3}\/goal +Work until a goal is met +│$/),
      expect.stringMatching(/^│ {3}\/help +Show the commands +│$/),
      expect.stringMatching(/^│ {3}\/mic +Pick the microphone for voice input +│$/),
    ])
    expect(rows[input - 2]).toMatch(/^╰─+╯$/)
    expect(screen.frame()).not.toContain('/model')
  })

  test('arrows move the selection', async () => {
    await using screen = await mountComposer()
    await screen.input(async (keys) => {
      // `/co` has 2 rows. Up on the first row and down on the last row do nothing.
      await keys.typeText('/co')
      keys.pressArrow('up')
      keys.pressArrow('down')
      keys.pressArrow('down')
      keys.pressArrow('up')
      keys.pressArrow('down')
    })
    expect(screen.lineWith('▎')).toContain('▎ /connect')
  })

  test('the selection scrolls past 6 rows', async () => {
    await using screen = await mountComposer()
    await screen.input(async (keys) => {
      await keys.typeText('/')
      // More downs than rows: down on the last row does nothing.
      for (let step = 0; step < 20; step += 1) keys.pressArrow('down')
    })
    // The last command is selected, and the first ones are gone.
    expect(screen.lineWith('▎')).toContain('▎ /todos')
    expect(screen.frame()).not.toContain('/compact')
  })

  test('tab completes /connect', async () => {
    await using screen = await mountComposer()
    // The keys come before React draws again.
    await screen.input(async (keys) => {
      await keys.typeText('/con')
      keys.pressTab()
    })
    expect(screen.lineWith('›')).toMatch(/^│ › \/connect +│$/)
    expect(screen.sent).toEqual([])
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['/connect'])
  })

  test('enter on a command that needs text puts it in the input', async () => {
    await using screen = await mountComposer()
    await screen.input(async (keys) => {
      await keys.typeText('/go')
      keys.pressEnter()
    })
    expect(screen.sent).toEqual([])
    expect(screen.lineWith('›')).toMatch(/^│ › \/goal +│$/)
    await screen.input(async (keys) => {
      await keys.typeText('tests pass')
      keys.pressEnter()
    })
    expect(screen.sent).toEqual(['/goal tests pass'])
  })

  test('enter runs the selected command at once', async () => {
    await using screen = await mountComposer()
    await screen.input(async (keys) => {
      await keys.typeText('/mod')
      keys.pressArrow('down')
      keys.pressEnter()
    })
    expect(screen.sent).toEqual(['/model'])
    expect(screen.lineWith('›')).toMatch(/^│ › Ask heddle +│$/)
  })

  test('enter on an exact match submits', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.typeText('/mode'))
    // `/mode` matches `/mode` and `/model`, and the first row is the text itself.
    expect(screen.lineWith('▎')).toMatch(/▎ \/mode +Show or switch the mode/)
    expect(screen.frame()).toContain('/model')
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['/mode'])
    expect(screen.lineWith('›')).toMatch(/^│ › Ask heddle +│$/)
  })

  test('esc closes the popup', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.typeText('/co'))
    expect(screen.frame()).toContain('/compact')
    await screen.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(screen.frame()).not.toContain('/compact')
    // Without the popup, enter sends the text as it is.
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['/co'])
  })

  test('an edit opens the popup again after esc', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.typeText('/co'))
    await screen.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    await screen.input((keys) => keys.typeText('m'))
    expect(screen.lineWith('▎')).toContain('▎ /compact')
    // Back at the text of the esc, the popup stays open.
    await screen.input((keys) => keys.pressBackspace())
    expect(screen.lineWith('›')).toMatch(/^│ › \/co +│$/)
    expect(screen.lineWith('▎')).toContain('▎ /compact')
  })

  test('the popup hides after a space', async () => {
    await using screen = await mountComposer()
    await screen.input((keys) => keys.typeText('/connect'))
    expect(screen.frame()).toContain('Connect a model provider or a server')
    // The name ends at the space.
    await screen.input((keys) => keys.typeText(' a'))
    expect(screen.frame()).not.toContain('Connect a model provider or a server')
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['/connect a'])
  })
})

describe('Composer history and paths', () => {
  test('↑ shows the lines sent before, and ↓ comes back to the typed text', async () => {
    await using screen = await mountComposer({ history: ['first', '/model'] })
    await screen.input(async (keys) => {
      await keys.typeText('draft')
      keys.pressArrow('up')
    })
    // A sent command does not open the popup.
    expect(screen.lineWith('›')).toMatch(/^│ › \/model +│$/)
    expect(screen.frame()).not.toContain('Show or switch the model')
    await screen.input((keys) => keys.pressArrow('up'))
    expect(screen.lineWith('›')).toMatch(/^│ › first +│$/)
    // There is no line before the first one.
    await screen.input((keys) => keys.pressArrow('up'))
    expect(screen.lineWith('›')).toMatch(/^│ › first +│$/)
    await screen.input((keys) => {
      keys.pressArrow('down')
      keys.pressArrow('down')
    })
    expect(screen.lineWith('›')).toMatch(/^│ › draft +│$/)
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['draft'])
  })

  test('enter on an @ path puts it in the input, and does not send', async () => {
    const paths = (text: string) =>
      text.endsWith('@s')
        ? [{ label: '@src/', detail: 'folder', insert: `${text.slice(0, -1)}src/` }]
        : text.endsWith('@src/')
          ? [{ label: '@src/math.mjs', detail: '', insert: `${text}math.mjs ` }]
          : []
    await using screen = await mountComposer({ paths })
    await screen.input(async (keys) => {
      await keys.typeText('look at @s')
      keys.pressEnter()
    })
    expect(screen.lineWith('▎')).toContain('▎ @src/math.mjs')
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual([])
    expect(screen.lineWith('›')).toMatch(/^│ › look at @src\/math\.mjs +│$/)
    await screen.input((keys) => keys.pressEnter())
    expect(screen.sent).toEqual(['look at @src/math.mjs '])
  })
})
