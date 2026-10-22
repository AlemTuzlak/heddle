// heddle from end to end: the real session and host, the real App, and fake
// models. A message goes in through the composer, the agent asks to write a
// file, `y` approves it, and the answer and the diff show on the screen.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SyntaxStyle } from '@opentui/core'
import { useRenderer } from '@opentui/react'
import { fakeText } from '@tanstack/ai/testing'
import { act, useState, type ComponentProps } from 'react'
import { MODELS } from './harness'
import { startHeddle } from './session'
import { tempFolder } from './test-utils'
import { App } from './ui/App'
import { mount } from './ui/test-utils'
import { createSyntaxStyle } from './ui/theme'
import type { FakeResponseStep } from '@tanstack/ai/testing'
import type { HeddleConfig } from './config'

// The tests script a fake opus, so the config names it. Else the keys of the shell pick the model.
const CONFIG: HeddleConfig = { model: 'opus', sandbox: false, codeMode: false, mcp: {} }

/** The App with a syntax style of its own renderer, as `main` makes it. */
function Stage({ styles, ...props }: Omit<ComponentProps<typeof App>, 'syntaxStyle'> & { styles: Array<SyntaxStyle> }) {
  const renderer = useRenderer()
  const [syntaxStyle] = useState(() => {
    const style = createSyntaxStyle(renderer)
    styles.push(style)
    return style
  })
  return <App {...props} syntaxStyle={syntaxStyle} />
}

/** heddle in a temp project, with a fake opus that gives `answers`. The other models never answer. */
async function startIn(folder: string, answers: Array<FakeResponseStep>) {
  const root = join(folder, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'math.mjs'), 'export const add = (a, b) => a - b\n')
  const opus = fakeText({ model: 'claude-opus-5-5' })
  opus.setResponses(answers)
  const silent = MODELS.map((choice) => [choice.name, fakeText({ model: choice.model })] as const)
  const heddle = await startHeddle({
    root,
    home: join(folder, 'home'),
    config: CONFIG,
    models: { ...Object.fromEntries(silent), opus },
    openUrl: () => {},
  })
  return { root, heddle }
}

test('a message gets an approved file edit and an answer on the screen', async () => {
  using folder = tempFolder()
  const fixed = 'export const add = (a, b) => a + b\n'
  const { root, heddle } = await startIn(folder.path, [
    { toolCalls: [{ name: 'write_file', input: { path: 'src/math.mjs', content: fixed } }] },
    { text: 'I fixed add in src/math.mjs.' },
  ])
  const styles: Array<SyntaxStyle> = []
  // heddle sends only when the model has a key. The fake models never read it.
  const savedKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'test-key'
  try {
    const session = await heddle.open()
    await using app = await act(() =>
      mount(<Stage styles={styles} host={heddle} session={session} onQuit={() => {}} />, {
        width: 140,
        height: 40,
        exitOnCtrlC: false,
      }),
    )
    /** Draw frames until `text` shows, for at most 5 s. */
    const waitFor = async (text: string) => {
      for (let tries = 0; tries < 100; tries += 1) {
        if (app.frame().includes(text)) return
        await app.input(() => {}, 50)
      }
      throw new Error(`"${text}" did not show. The screen:\n${app.frame()}`)
    }

    await app.input((keys) => keys.typeText('fix the add bug'))
    await app.input((keys) => keys.pressEnter())
    await waitFor('fix the add bug')

    // The write asks first, in the default mode.
    await waitFor('y once')
    await app.input((keys) => keys.pressKey('y'))

    await waitFor('I fixed add in src/math.mjs.')
    expect(readFileSync(join(root, 'src', 'math.mjs'), 'utf8')).toBe(fixed)
    // The changes pane lists the file with its counts.
    await waitFor('+1 −1')
    expect(app.frame()).toContain('src/math.mjs')
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
    await heddle.shutdown()
    for (const style of styles) style.destroy()
  }
}, 30_000)
