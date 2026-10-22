import { describe, expect, test } from 'bun:test'
import type { SyntaxStyle } from '@opentui/core'
import { useRenderer } from '@opentui/react'
import type { FileChange } from '@tanstack/ai-harness/plugins/coding'
import type {
  AgentPart,
  Approval,
  SessionViewState,
  ToolCallPart,
  ViewCommand,
  ViewMessage,
} from '@tanstack/ai-harness/view'
import { act, useState, type ComponentProps } from 'react'
import { applyChange, type ChangesState } from '../state/changes'
import { App, type AppHost, type AppSession } from './App'
import type { SessionRow } from './SessionPicker'
import { ESCAPE_WAIT_MS, mount } from './test-utils'
import { createSyntaxStyle } from './theme'

/** The tools root of the fake sessions. */
const ROOT = '/work'

/** The text of the empty composer. */
const PLACEHOLDER = 'Ask heddle, or type / for a command'

/** A wide terminal: both panes show. */
const WIDE = { width: 120, height: 40 }

/** A narrow terminal: one pane shows at a time. */
const NARROW = { width: 60, height: 20 }

/** Some commands of the heddle harness. */
const COMMANDS: ReadonlyArray<ViewCommand> = [
  {
    name: 'connect:anthropic',
    description: 'Connect Anthropic with your own key',
    owner: 'tanstack/provider-keys',
  },
  {
    name: 'goal',
    description: 'Work until a goal is met',
    owner: 'tanstack/goal',
    input: { type: 'string' },
  },
]

/** A call of a view action, as the fake view keeps it. */
type ViewCall =
  | { action: 'send'; text: string }
  | { action: 'command'; name: string; input?: unknown }
  | { action: 'notice'; text: string }
  | { action: 'cancel' }
  | { action: 'loadAgent'; id: string }

/** An answer to an approval, as the fake approvals keep it. */
interface Answer {
  id: string
  action: 'approve' | 'reject'
  options: unknown
}

/** A call of the host, as the fake host keeps it. */
type HostCall =
  | { action: 'open'; threadId?: string }
  | { action: 'fork'; threadId: string }
  | { action: 'rename'; threadId: string; title: string }

/** The view state of a session with the commands and the model `opus`, and nothing else. */
function viewState(threadId: string, fields: Partial<SessionViewState>) {
  const state: SessionViewState = {
    threadId,
    status: 'idle',
    connection: 'open',
    messages: [],
    approvals: [],
    clientTools: [],
    interrupts: [],
    questions: [],
    signIns: [],
    waits: [],
    agents: [],
    queuedTurns: 0,
    waitingInputs: [],
    commands: [...COMMANDS],
    config: [
      {
        key: 'model',
        owner: 'tanstack/model-picker',
        value: 'opus',
        option: { type: 'select', options: ['opus', 'haiku'], default: 'opus' },
      },
    ],
    tools: [],
    models: [],
    plugins: {},
    ...fields,
  }
  return state
}

/**
 * A session with a fake view: a small store, and actions that keep each call
 * in `calls`. A notice adds a notice row, as the real view does.
 */
function createSession(
  threadId: string,
  fields: Partial<SessionViewState> = {},
  options: { missingKey?: string; changes?: ChangesState } = {},
) {
  let state = viewState(threadId, fields)
  const listeners = new Set<() => void>()
  const calls: Array<ViewCall> = []
  let closes = 0
  const update = (next: Partial<SessionViewState>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const view: AppSession['view'] = {
    store: {
      get: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return { unsubscribe: () => listeners.delete(listener) }
      },
    },
    send: async (text) => {
      calls.push({ action: 'send', text })
    },
    runCommand: async ({ name, input }) => {
      calls.push({ action: 'command', name, input })
    },
    cancel: async () => {
      calls.push({ action: 'cancel' })
    },
    notice: ({ text }) => {
      calls.push({ action: 'notice', text })
      update({
        messages: [...state.messages, { id: `notice-${calls.length}`, role: 'notice', kind: 'ui', text }],
      })
    },
    loadAgent: async ({ id }) => {
      calls.push({ action: 'loadAgent', id })
    },
  }
  const changes = options.changes ?? { files: [] }
  const session: AppSession = {
    threadId,
    place: 'local',
    root: ROOT,
    view,
    changes: { get: () => changes, subscribe: () => () => {}, stop: () => {} },
    missingKey: async () => options.missingKey,
    close: async () => {
      closes += 1
    },
  }
  return { session, calls, closes: () => closes }
}

type FakeSession = ReturnType<typeof createSession>

/**
 * A host that lists `rows`, and opens the sessions of `sessions` by id.
 * `calls` keeps each call of open, fork, and rename.
 */
function createHost(rows: ReadonlyArray<SessionRow>, sessions: ReadonlyArray<FakeSession> = []) {
  const calls: Array<HostCall> = []
  const host: AppHost = {
    listSessions: async () => [...rows],
    open: async (threadId) => {
      calls.push({ action: 'open', threadId })
      const found = sessions.find((fake) => fake.session.threadId === threadId)
      if (found === undefined) throw new Error(`No fake session ${threadId}.`)
      return found.session
    },
    fork: async (threadId) => {
      calls.push({ action: 'fork', threadId })
      return `${threadId}-fork`
    },
    rename: async (threadId, title) => {
      calls.push({ action: 'rename', threadId, title })
    },
  }
  return { host, calls }
}

/** A session row of the picker. */
function sessionRow(id: string, title: string) {
  const row: SessionRow = { id, title, status: 'done', place: 'local', updatedAt: Date.now() }
  return row
}

/** A finished tool call. */
function toolCall(id: string, name: string, args: unknown) {
  const part: ToolCallPart = { type: 'tool-call', id, name, argsText: JSON.stringify(args), args, status: 'done' }
  return part
}

/** A `bash` approval that keeps its answers in `answers`. */
function createApproval(id: string, command: string, answers: Array<Answer>) {
  const approval: Approval = {
    id,
    tool: 'bash',
    args: { command },
    approve: (options) => {
      answers.push({ id, action: 'approve', options })
    },
    reject: (options) => {
      answers.push({ id, action: 'reject', options })
    },
  }
  return approval
}

const USER_MESSAGE: ViewMessage = { id: 'user-1', role: 'user', text: 'The add test fails. Fix it.' }

/** The fix of the add function: +1 −1 in `src/math.mjs`, by the tool call `call-edit`. */
const FIX_ADD: FileChange = {
  path: `${ROOT}/src/math.mjs`,
  change: 'updated',
  patch: [
    'diff --git a/src/math.mjs b/src/math.mjs',
    '--- a/src/math.mjs',
    '+++ b/src/math.mjs',
    '@@ -1,3 +1,3 @@',
    ' export function add(a, b) {',
    '-  return a - b',
    '+  return a + b',
    ' }',
    '',
  ].join('\n'),
  additions: 1,
  deletions: 1,
  toolCallId: 'call-edit',
}

/** A turn that edits the add function. */
const EDIT_TURN: ViewMessage = {
  id: 'turn-1',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'I will fix the add function.' },
    toolCall('call-edit', 'edit_file', { path: `${ROOT}/src/math.mjs`, old: 'a - b', new: 'a + b' }),
  ],
}

/** The explore agent of the mockup, with its transcript. */
const EXPLORE: AgentPart = {
  type: 'agent',
  id: 'run-explore',
  name: 'explore',
  status: 'done',
  parts: [toolCall('call-grep', 'grep', { pattern: 'add(' }), { type: 'text', text: '1 caller, nothing to change' }],
}

/** A turn that starts the explore agent. */
const EXPLORE_TURN: ViewMessage = {
  id: 'turn-1',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'I will ask explore.' },
    toolCall('call-explore', 'explore', { prompt: 'who else calls add()?' }),
    EXPLORE,
  ],
}

type StageProps = Omit<ComponentProps<typeof App>, 'syntaxStyle'> & {
  /** Gets the syntax style, so that the test can destroy it after the renderer. */
  styles: Array<SyntaxStyle>
}

/** The app with a syntax style of the renderer that draws it. */
function Stage({ styles, ...props }: StageProps) {
  const renderer = useRenderer()
  const [syntaxStyle] = useState(() => {
    const style = createSyntaxStyle(renderer)
    styles.push(style)
    return style
  })
  return <App {...props} syntaxStyle={syntaxStyle} />
}

/**
 * Render the app with `fake` in a test terminal. The host lists no sessions,
 * unless `host` is given. `quits` counts the calls of `onQuit`. Dispose it
 * with `await using`.
 */
async function mountApp(
  fake: FakeSession,
  options: { host?: AppHost; size?: { width: number; height: number }; startWith?: 'sessions' } = {},
) {
  const { host = createHost([]).host, size = WIDE, startWith } = options
  const styles: Array<SyntaxStyle> = []
  let quits = 0
  // `mount` gives these options to the test renderer. As in heddle, the
  // renderer does not exit on ctrl+c: the app handles ctrl+c.
  const terminal = { ...size, exitOnCtrlC: false }
  // The first answers of the host and the session come after the first
  // render. act() waits for them, and the next input draws them.
  const app = await act(() =>
    mount(
      <Stage
        styles={styles}
        host={host}
        session={fake.session}
        startWith={startWith}
        onQuit={() => {
          quits += 1
        }}
      />,
      terminal,
    ),
  )
  await app.input(() => {})
  return {
    ...app,
    quits: () => quits,
    /** The rows of the terminal. */
    rows: () => app.frame().split('\n').slice(0, size.height),
    [Symbol.asyncDispose]: async () => {
      await app[Symbol.asyncDispose]()
      // The diff uses the style until the renderer is gone.
      for (const style of styles) style.destroy()
    },
  }
}

describe('App layout', () => {
  test('the wide layout shows both panes', async () => {
    const changes = applyChange({ files: [] }, FIX_ADD, ROOT, 1000)
    const fake = createSession('thread-1', { messages: [USER_MESSAGE, EDIT_TURN] }, { changes })
    await using app = await mountApp(fake, { size: WIDE })
    const rows = app.rows()
    // The timeline takes 54 of the 120 columns, and the changes the rest, after one free column.
    expect(rows[1]).toMatch(/^╭─ session ─+╮ ╭─ changes ─+╮$/)
    expect(rows[1].indexOf('╭─ changes')).toBe(55)
    expect(app.frame()).toContain('The add test fails. Fix it.')
    expect(app.lineWith('◆ edit')).toMatch(/◆ edit +src\/math\.mjs +\+1 −1 +│/)
    expect(app.frame()).toContain('patch 1 of 1  updated')
    expect(app.frame()).toContain('return a + b')
  })

  test('the narrow layout shows one pane, and tab switches', async () => {
    const changes = applyChange({ files: [] }, FIX_ADD, ROOT, 1000)
    const fake = createSession('thread-1', { messages: [USER_MESSAGE, EDIT_TURN] }, { changes })
    await using app = await mountApp(fake, { size: NARROW })
    /** Each row of the screen has one part, and no part draws over another. */
    const expectLayout = (title: string) => {
      const rows = app.rows()
      expect(rows[0]).toStartWith('◆ heddle')
      expect(rows[1]).toMatch(new RegExp(`^╭─ ${title} ─+╮$`))
      for (const row of rows.slice(2, 15)) expect(row).toMatch(/^│.*│$/)
      expect(rows[15]).toMatch(/^╰─+╯$/)
      expect(rows[16]).toMatch(/^╭─+╮$/)
      expect(rows[17]).toMatch(/^│ › .*│$/)
      expect(rows[18]).toMatch(/^╰─+╯$/)
      expect(rows[19]).toMatch(/^\S/)
      expect(rows).toHaveLength(NARROW.height)
    }
    expectLayout('session')
    expect(app.frame()).toContain('The add test fails. Fix it.')
    expect(app.frame()).not.toContain('return a + b')
    // The first tab moves the focus from the composer to the timeline, the second one to the changes.
    await app.input((keys) => keys.pressTab())
    expectLayout('session')
    await app.input((keys) => keys.pressTab())
    expectLayout('changes')
    expect(app.frame()).toContain('return a + b')
    expect(app.frame()).not.toContain('The add test fails. Fix it.')
  })
})

describe('App approvals', () => {
  test('the header shows how full the context is', async () => {
    // opus has a window of 1,000,000 tokens.
    const fake = createSession('thread-1', { plugins: { 'tanstack/usage': { contextTokens: 410_000 } } })
    await using app = await mountApp(fake, { size: WIDE })
    expect(app.frame()).toContain('▰▰▰▰▱▱▱▱▱▱ 41%')
  })

  test('y approves the waiting approval', async () => {
    const answers: Array<Answer> = []
    const fake = createSession('thread-1', {
      status: 'requires_action',
      approvals: [createApproval('approval-1', 'node --test', answers)],
    })
    await using app = await mountApp(fake)
    expect(app.lineWith('wants to run')).toContain('bash wants to run node --test')
    await app.input((keys) => keys.pressKey('y'))
    expect(answers).toEqual([{ id: 'approval-1', action: 'approve', options: undefined }])
    // The composer did not get the key.
    expect(app.lineWith('›')).toContain(PLACEHOLDER)
  })

  test('the second approval shows after the first is answered', async () => {
    const answers: Array<Answer> = []
    // The view keeps an answered approval until each approval of the turn has an answer.
    const fake = createSession('thread-1', {
      status: 'requires_action',
      approvals: [
        createApproval('approval-1', 'node --test', answers),
        createApproval('approval-2', 'rm -rf dist', answers),
      ],
    })
    await using app = await mountApp(fake)
    await app.input((keys) => keys.pressKey('y'))
    expect(app.lineWith('wants to run')).toContain('bash wants to run rm -rf dist')
    expect(app.lineWith('wants to run')).toContain(' a always')
    await app.input((keys) => keys.pressKey('a'))
    expect(answers).toEqual([
      { id: 'approval-1', action: 'approve', options: undefined },
      { id: 'approval-2', action: 'approve', options: { payload: 'always' } },
    ])
  })
})

describe('App subagents', () => {
  test('enter on an agent row loads its transcript', async () => {
    const fake = createSession('thread-1', { messages: [USER_MESSAGE, EXPLORE_TURN] })
    await using app = await mountApp(fake)
    // tab gives the timeline the focus. The first ↑ selects the last row: the end of the explore branch.
    await app.input((keys) => keys.pressTab())
    await app.input((keys) => {
      keys.pressArrow('up')
      keys.pressEnter()
    })
    expect(fake.calls).toEqual([{ action: 'loadAgent', id: 'run-explore' }])
    expect(app.rows()[1]).toMatch(/^╭─ session ─+╮ ╭─ explore ─+╮$/)
    // The right pane starts at column 55. The transcript has the grep call
    // and the last text of the agent, in a lane of its own.
    const rightPane = () => app.rows().map((row) => row.slice(55))
    expect(rightPane().slice(2, 6)).toEqual([
      expect.stringMatching(/^│ │ {2}◇ grep {6}"add\(" +│$/),
      expect.stringMatching(/^│ │ +│$/),
      expect.stringMatching(/^│ ● {2}explore {3}1 caller, nothing to change +│$/),
      expect.stringMatching(/^│ ┊ +│$/),
    ])
    await app.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(app.rows()[1]).toMatch(/^╭─ session ─+╮ ╭─ changes ─+╮$/)
    expect(rightPane()[2]).toMatch(/^│ No file changes yet\. +│$/)
  })
})

describe('App composer', () => {
  test('submit runs a command', async () => {
    const fake = createSession('thread-1')
    await using app = await mountApp(fake)
    await app.input(async (keys) => {
      await keys.typeText('/goal ship it')
      keys.pressEnter()
    })
    expect(fake.calls).toEqual([{ action: 'command', name: 'goal', input: 'ship it' }])
  })

  test('a missing key shows the connect hint and does not send', async () => {
    const fake = createSession('thread-1', {}, { missingKey: 'anthropic' })
    await using app = await mountApp(fake)
    expect(app.lineWith('◆ heddle')).toContain('no key')
    await app.input(async (keys) => {
      await keys.typeText('fix the add test')
      keys.pressEnter()
    })
    expect(fake.calls).toEqual([
      {
        action: 'notice',
        text: 'No API key for anthropic. Type /connect anthropic, or set ANTHROPIC_API_KEY.',
      },
    ])
    expect(app.frame()).toContain('No API key for anthropic.')
  })
})

describe('App keys', () => {
  test('ctrl+o opens the picker', async () => {
    const fake = createSession('thread-1')
    const { host } = createHost([sessionRow('thread-1', 'Fix the add test'), sessionRow('thread-2', 'Add input checks')])
    await using app = await mountApp(fake, { host })
    expect(app.frame()).not.toContain('2 in this folder')
    await app.input((keys) => keys.pressKey('o', { ctrl: true }))
    expect(app.lineWith('Sessions')).toContain('2 in this folder')
    expect(app.lineWith('Fix the add test (current)')).toContain('done')
    expect(app.frame()).toContain('Add input checks')
  })

  test('esc while running cancels', async () => {
    const fake = createSession('thread-1', { status: 'running' })
    await using app = await mountApp(fake)
    await app.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(fake.calls).toEqual([{ action: 'cancel' }])
  })

  test('keys of an open overlay do not reach the app', async () => {
    const fake = createSession('thread-1', { status: 'running' })
    await using app = await mountApp(fake)
    await app.input((keys) => keys.pressKey('k', { ctrl: true }))
    expect(app.frame()).toContain('Commands')
    // tab would move the focus, and esc would stop the turn.
    await app.input(async (keys) => {
      await keys.typeText('zz')
      keys.pressTab()
    })
    expect(app.frame()).toContain('⌕ zz')
    await app.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(app.frame()).not.toContain('Commands')
    expect(fake.calls).toEqual([])
    // The composer still has the focus, and it got none of the keys.
    await app.input((keys) => keys.typeText('hi'))
    expect(app.lineWith('›')).toMatch(/│ › hi +│/)
  })

  test('ctrl+c twice quits', async () => {
    const fake = createSession('thread-1')
    await using app = await mountApp(fake)
    await app.input((keys) => keys.pressKey('c', { ctrl: true }))
    expect(app.quits()).toBe(0)
    expect(app.rows().at(-1)).toStartWith('ctrl+c again to quit')
    await app.input((keys) => keys.pressKey('c', { ctrl: true }))
    expect(app.quits()).toBe(1)
  })
})

describe('App sessions', () => {
  test('startWith sessions opens the picker at the start', async () => {
    const fake = createSession('thread-1')
    const { host } = createHost([sessionRow('thread-1', 'Fix the add test')])
    await using app = await mountApp(fake, { host, startWith: 'sessions' })
    expect(app.lineWith('Sessions')).toContain('1 in this folder')
    await app.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(app.frame()).not.toContain('1 in this folder')
  })

  test('enter in the picker opens the session, and closes the old one', async () => {
    const first = createSession('thread-1', { messages: [USER_MESSAGE] })
    const second = createSession('thread-2', {
      messages: [{ id: 'user-2', role: 'user', text: 'Check the input of add.' }],
    })
    const { host, calls } = createHost(
      [sessionRow('thread-1', 'Fix the add test'), sessionRow('thread-2', 'Add input checks')],
      [first, second],
    )
    await using app = await mountApp(first, { host })
    await app.input((keys) => keys.pressKey('o', { ctrl: true }))
    await app.input((keys) => {
      keys.pressArrow('down')
      keys.pressEnter()
    })
    expect(calls).toEqual([{ action: 'open', threadId: 'thread-2' }])
    expect(first.closes()).toBe(1)
    expect(app.lineWith('◆ heddle')).toContain('Add input checks')
    expect(app.frame()).toContain('Check the input of add.')
    expect(app.frame()).not.toContain('The add test fails.')
  })
})
