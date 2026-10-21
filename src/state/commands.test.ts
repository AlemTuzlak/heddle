import { describe, expect, test } from 'bun:test'
import { parseInput, suggest } from './commands'
import type { ViewCommand } from '@tanstack/ai-harness/view'

/**
 * Some commands of the heddle harness, in the order of its plugins. The names
 * and the descriptions are the ones that the plugins give.
 */
const COMMANDS: Array<ViewCommand> = [
  {
    name: 'keys',
    description: 'Show the model providers and where their keys come from',
    owner: 'tanstack/provider-keys',
  },
  {
    name: 'connect:anthropic',
    description: 'Connect Anthropic with your own key',
    owner: 'tanstack/provider-keys',
  },
  {
    name: 'disconnect:anthropic',
    description: 'Remove your Anthropic key',
    owner: 'tanstack/provider-keys',
  },
  {
    name: 'connect:openai',
    description: 'Connect OpenAI with your own key',
    owner: 'tanstack/provider-keys',
  },
  {
    name: 'model',
    description: 'Show or switch the model (claude-opus-5-5, gpt-6.1-sol)',
    owner: 'tanstack/model-picker',
  },
  {
    name: 'goal',
    description:
      'Work until a goal is met: /goal <goal>. Also /goal, /goal stop, /goal resume',
    owner: 'tanstack/goal',
  },
  { name: 'todos', description: 'Show the todo list', owner: 'tanstack/todos' },
  {
    name: 'compact',
    description: 'Summarize the conversation to save tokens',
    owner: 'tanstack/compact',
  },
  {
    name: 'connect:linear',
    description: 'Sign in to linear',
    owner: 'tanstack/mcp',
  },
]

describe('parseInput', () => {
  test('plain text sends', () => {
    expect(parseInput('  fix the failing test \n', COMMANDS)).toEqual({
      kind: 'send',
      text: 'fix the failing test',
    })
  })

  test('/connect anthropic gives connect:anthropic', () => {
    expect(parseInput('/connect anthropic', COMMANDS)).toEqual({
      kind: 'command',
      name: 'connect:anthropic',
    })
  })

  test('/connect nope lists the targets', () => {
    expect(parseInput('/connect nope', COMMANDS)).toEqual({
      kind: 'error',
      message:
        'Unknown connect target "nope". Type /connect and one of these targets: anthropic, openai, linear.',
    })
  })

  test('/connect alone lists the targets', () => {
    expect(parseInput('/connect', COMMANDS)).toEqual({
      kind: 'error',
      message:
        'Type /connect and one of these targets: anthropic, openai, linear.',
    })
  })

  test('/disconnect anthropic gives disconnect:anthropic', () => {
    expect(parseInput('/disconnect anthropic', COMMANDS)).toEqual({
      kind: 'command',
      name: 'disconnect:anthropic',
    })
  })

  test('/goal ship it gives goal with input', () => {
    expect(parseInput('/goal ship it', COMMANDS)).toEqual({
      kind: 'command',
      name: 'goal',
      input: 'ship it',
    })
  })

  test('a command with no text gives no input', () => {
    expect(parseInput('/todos', COMMANDS)).toEqual({
      kind: 'command',
      name: 'todos',
    })
  })

  test('the name ends at a new line, and the input keeps its lines', () => {
    const line = '/goal\nship the release\nand write the notes'
    expect(parseInput(line, COMMANDS)).toEqual({
      kind: 'command',
      name: 'goal',
      input: 'ship the release\nand write the notes',
    })
  })

  test.each([
    ['/sessions', 'sessions'],
    ['/new', 'new'],
    ['/quit', 'quit'],
  ] as const)('%s is local', (line, action) => {
    expect(parseInput(line, COMMANDS)).toEqual({ kind: 'local', action })
  })

  test('/exit is quit', () => {
    expect(parseInput('/exit', COMMANDS)).toEqual({
      kind: 'local',
      action: 'quit',
    })
  })

  test('a local name wins over a plugin command', () => {
    const commands: Array<ViewCommand> = [
      ...COMMANDS,
      { name: 'help', description: 'Show the help of acme', owner: 'acme' },
    ]
    expect(parseInput('/help', commands)).toEqual({
      kind: 'local',
      action: 'help',
    })
    expect(suggest('/he', commands)).toEqual([
      { label: '/help', detail: 'Show the commands', insert: '/help' },
    ])
  })

  test('unknown command message', () => {
    expect(parseInput('/deploy now', COMMANDS)).toEqual({
      kind: 'error',
      message: 'Unknown command /deploy. Type /help.',
    })
  })
})

describe('suggest', () => {
  test('suggest filters by prefix', () => {
    expect(suggest('/co', COMMANDS)).toEqual([
      {
        label: '/compact',
        detail: 'Summarize the conversation to save tokens',
        insert: '/compact',
      },
      {
        label: '/connect anthropic',
        detail: 'Connect Anthropic with your own key',
        insert: '/connect anthropic',
      },
      {
        label: '/connect linear',
        detail: 'Sign in to linear',
        insert: '/connect linear',
      },
      {
        label: '/connect openai',
        detail: 'Connect OpenAI with your own key',
        insert: '/connect openai',
      },
    ])
  })

  test('a command with an input schema gets a trailing space', () => {
    // A skill command of `@tanstack/ai-skills` has a string input schema.
    const review: ViewCommand = {
      name: 'review',
      description: 'Skill: Review the changes for bugs.',
      owner: 'tanstack/skills',
      input: { type: 'string' },
    }
    expect(suggest('/rev', [...COMMANDS, review])).toEqual([
      {
        label: '/review',
        detail: 'Skill: Review the changes for bugs.',
        insert: '/review ',
      },
    ])
  })

  test('text without / gives no suggestions', () => {
    // Each label starts with the empty text, so only the check of the `/`
    // keeps this list empty.
    expect(suggest('', COMMANDS)).toEqual([])
  })
})
