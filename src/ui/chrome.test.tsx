import { describe, expect, test } from 'bun:test'
import type { Receipt } from '@tanstack/ai-harness'
import type { Approval, ViewQuestion } from '@tanstack/ai-harness/view'
import { ApprovalBar } from './ApprovalBar'
import { Header } from './Header'
import { Hints } from './Hints'
import { mount } from './test-utils'
import { color } from './theme'

/** The test terminal of the bar and the hints. */
const BAR = { width: 100, height: 8 }

/** OpenTUI sends a lone esc as a key after 20 ms. Wait a little more. */
const ESCAPE_WAIT_MS = 40

/**
 * The answer schema of a code mode approval: a copy of
 * `APPROVAL_ANSWER_SCHEMA` in `@tanstack/ai-harness` (src/boundary-waits.ts).
 * The package does not export it.
 */
const CODE_MODE_APPROVAL_SCHEMA = {
  anyOf: [
    { type: 'boolean' },
    { type: 'string', enum: ['once', 'always', 'reject'] },
    {
      type: 'object',
      properties: {
        answer: { type: 'string', enum: ['once', 'always', 'reject'] },
        message: { type: 'string' },
      },
      required: ['answer'],
    },
    {
      type: 'object',
      properties: { approved: { type: 'boolean' }, payload: {} },
      required: ['approved'],
    },
  ],
}

const accepted: Receipt = { inputId: 'input-1', status: 'accepted' }

/** A `bash` approval that keeps each call of its actions. */
function createApproval(command: string) {
  const calls: Array<{ action: 'approve' | 'reject'; options: unknown }> = []
  const approval: Approval = {
    id: 'approval-1',
    tool: 'bash',
    args: { command },
    approve: (options) => {
      calls.push({ action: 'approve', options })
    },
    reject: (options) => {
      calls.push({ action: 'reject', options })
    },
  }
  return { approval, calls }
}

/** A question that keeps each answer, and gives back `receipt`. */
function createQuestion(fields: Omit<ViewQuestion, 'id' | 'answer'>, receipt = accepted) {
  const answers: Array<unknown> = []
  const question: ViewQuestion = {
    id: 'question-1',
    ...fields,
    answer: async (value) => {
      answers.push(value)
      return receipt
    },
  }
  return { question, answers }
}

describe('Header', () => {
  test('header shows the goal and the cost', async () => {
    await using header = await mount(
      <Header
        title="Fix the failing add test"
        goal={{ text: 'tests pass', round: 2, max: 20 }}
        model="opus 5.5"
        agent="build"
        place="docker"
        sync="synced"
        context={0.41}
        cost={0.38}
      />,
      { width: 140, height: 2 },
    )
    const frame = header.frame()
    expect(frame).toContain('◆ heddle')
    expect(frame).toContain('Fix the failing add test')
    expect(frame).toContain('goal tests pass, round 2 of 20')
    expect(frame).toContain('opus 5.5  build')
    expect(frame).toContain('docker synced')
    expect(frame).toContain('▰▰▰▰▱▱▱▱▱▱ 41%')
    expect(frame).toContain('$0.38')
    expect(frame).not.toContain('no key')
  })

  test('header shows no key', async () => {
    await using header = await mount(
      <Header model="opus 5.5" place="local" missingKey="anthropic" />,
      { width: 80, height: 2 },
    )
    expect(header.frame()).toContain('no key')
    expect(header.colorOf('no key')).toBe(color.weld)
  })
})

describe('Hints', () => {
  const hints = [
    { key: 'enter', label: 'send' },
    { key: 'esc', label: 'stop' },
    { key: 'tab', label: 'next pane' },
  ]

  test('hints show each key and its label', async () => {
    await using row = await mount(<Hints hints={hints} />, { width: 80, height: 2 })
    expect(row.frame()).toContain('enter send   esc stop   tab next pane')
  })

  test('a hint that does not fit is left out whole', async () => {
    // `enter send   esc stop` takes 21 columns, and the next hint needs 16 more.
    await using row = await mount(<Hints hints={hints} />, { width: 30, height: 2 })
    expect(row.frame()).toContain('enter send   esc stop')
    expect(row.frame()).not.toContain('tab')
  })
})

describe('ApprovalBar with an approval', () => {
  test('y approves once', async () => {
    const { approval, calls } = createApproval('node --test')
    await using bar = await mount(<ApprovalBar approval={approval} focused />, BAR)
    expect(bar.frame()).toContain('bash wants to run node --test')
    expect(bar.frame()).toContain(' y once')
    await bar.input((keys) => keys.pressKey('y'))
    expect(calls).toEqual([{ action: 'approve', options: undefined }])
    expect(bar.frame()).toContain('sent')
  })

  test('a approves always', async () => {
    const { approval, calls } = createApproval('node --test')
    await using bar = await mount(<ApprovalBar approval={approval} focused />, BAR)
    await bar.input((keys) => keys.pressKey('a'))
    expect(calls).toEqual([{ action: 'approve', options: { payload: 'always' } }])
  })

  test('n then a reason rejects with it', async () => {
    const { approval, calls } = createApproval('node --test')
    await using bar = await mount(<ApprovalBar approval={approval} focused />, BAR)
    // The keys come before React draws again, and the reason has an `a` and a `y` in it.
    await bar.input(async (keys) => {
      keys.pressKey('n')
      await keys.typeText('use bun test, always')
    })
    expect(bar.frame()).toContain('say why › use bun test, always')
    await bar.input((keys) => keys.pressEnter())
    expect(calls).toEqual([{ action: 'reject', options: { payload: 'use bun test, always' } }])
  })

  test('esc goes back from the reason to the keys', async () => {
    const { approval, calls } = createApproval('node --test')
    await using bar = await mount(<ApprovalBar approval={approval} focused />, BAR)
    await bar.input((keys) => keys.pressKey('n'))
    expect(bar.frame()).toContain('say why ›')
    await bar.input((keys) => keys.pressEscape(), ESCAPE_WAIT_MS)
    expect(bar.frame()).not.toContain('say why ›')
    expect(bar.frame()).toContain(' y once')
    await bar.input((keys) => keys.pressKey('y'))
    expect(calls).toEqual([{ action: 'approve', options: undefined }])
  })

  test('keys do nothing while the bar is not focused', async () => {
    const { approval, calls } = createApproval('node --test')
    await using bar = await mount(<ApprovalBar approval={approval} focused={false} />, BAR)
    await bar.input((keys) => keys.pressKey('y'))
    expect(calls).toEqual([])
  })

  test('a long command is cut, and the bar says how much it hides', async () => {
    // 'echo ' and 400 x: the bar shows 300 characters, so it hides 105.
    const { approval } = createApproval(`echo ${'x'.repeat(400)}`)
    await using bar = await mount(<ApprovalBar approval={approval} focused />, {
      width: 400,
      height: 4,
    })
    const frame = bar.frame()
    expect(frame).toContain(`echo ${'x'.repeat(295)}… (105 more characters)`)
    expect(frame).not.toContain('x'.repeat(296))
  })
})

describe('ApprovalBar with a question', () => {
  test('secret input shows only dots', async () => {
    const { question, answers } = createQuestion({
      message: 'Paste your Anthropic API key',
      secret: true,
    })
    await using bar = await mount(<ApprovalBar question={question} focused />, BAR)
    await bar.input((keys) => keys.typeText('sk-test-123'))
    // One dot for each of the 11 characters, then the cursor.
    expect(bar.frame()).toContain(`› ${'•'.repeat(11)} `)
    expect(bar.frame()).not.toContain('sk-test')
    await bar.input((keys) => keys.pressEnter())
    expect(answers).toEqual(['sk-test-123'])
    expect(bar.frame()).not.toContain('sk-test')
  })

  test('a pasted secret shows only dots', async () => {
    const { question, answers } = createQuestion({
      message: 'Paste your Anthropic API key',
      secret: true,
    })
    await using bar = await mount(<ApprovalBar question={question} focused />, BAR)
    await bar.input((keys) => keys.pasteBracketedText('sk-paste-4567\n'))
    // The line break of the paste is dropped: 13 dots.
    expect(bar.frame()).toContain(`› ${'•'.repeat(13)} `)
    expect(bar.frame()).not.toContain('sk-paste')
    await bar.input((keys) => keys.pressEnter())
    expect(answers).toEqual(['sk-paste-4567'])
  })

  test('enum question keys', async () => {
    const { question, answers } = createQuestion({
      message: 'Keep the old file?',
      schema: { type: 'string', enum: ['keep', 'discard'] },
    })
    await using bar = await mount(<ApprovalBar question={question} focused />, BAR)
    expect(bar.frame()).toContain(' k keep')
    expect(bar.frame()).toContain(' d discard')
    await bar.input((keys) => keys.pressKey('d'))
    expect(answers).toEqual(['discard'])
  })

  test('choices with the same first letter get number keys', async () => {
    const { question, answers } = createQuestion({
      message: 'What now?',
      schema: { type: 'string', enum: ['start', 'stop'] },
    })
    await using bar = await mount(<ApprovalBar question={question} focused />, BAR)
    expect(bar.frame()).toContain(' 1 start')
    expect(bar.frame()).toContain(' 2 stop')
    await bar.input((keys) => keys.pressKey('2'))
    expect(answers).toEqual(['stop'])
  })

  test.each([
    ['y', 'once'],
    ['a', 'always'],
  ] as const)('%s answers a code mode approval with %s', async (key, answer) => {
    const { question, answers } = createQuestion({
      message: 'Allow bash {"command":"ls"}? Answer once, always, or reject.',
      schema: CODE_MODE_APPROVAL_SCHEMA,
    })
    await using bar = await mount(<ApprovalBar question={question} focused />, BAR)
    expect(bar.frame()).toContain(' y once')
    await bar.input((keys) => keys.pressKey(key))
    expect(answers).toEqual([answer])
  })

  test('n then a reason rejects a code mode approval with it', async () => {
    const { question, answers } = createQuestion({
      message: 'Allow bash {"command":"rm -rf dist"}? Answer once, always, or reject.',
      schema: CODE_MODE_APPROVAL_SCHEMA,
    })
    await using bar = await mount(<ApprovalBar question={question} focused />, BAR)
    await bar.input((keys) => keys.pressKey('n'))
    await bar.input((keys) => keys.typeText('keep dist'))
    await bar.input((keys) => keys.pressEnter())
    // `readApproval` in the harness reads this as a reject, with the message for the model.
    expect(answers).toEqual([{ answer: 'reject', message: 'keep dist' }])
  })

  test('a question with a url shows the link', async () => {
    const { question } = createQuestion({
      message: 'Sign in to Linear, then press enter.',
      url: 'https://linear.app/oauth/authorize',
    })
    await using bar = await mount(<ApprovalBar question={question} focused />, BAR)
    expect(bar.frame()).toContain('open https://linear.app/oauth/authorize')
  })

  test('a refused answer shows the reason, and enter can send again', async () => {
    const { question, answers } = createQuestion(
      { message: 'Name the branch' },
      { inputId: 'input-1', status: 'rejected', reason: 'Invalid answer: too short' },
    )
    await using bar = await mount(<ApprovalBar question={question} focused />, BAR)
    await bar.input(async (keys) => {
      await keys.typeText('x')
      keys.pressEnter()
    })
    expect(bar.frame()).toContain('Not accepted: Invalid answer: too short')
    await bar.input((keys) => keys.pressEnter())
    expect(answers).toEqual(['x', 'x'])
  })
})
