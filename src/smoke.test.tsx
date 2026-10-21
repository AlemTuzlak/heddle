import { describe, expect, test } from 'bun:test'
import { rgbToHex } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import { color, createSyntaxStyle } from './ui/theme'

// Each linked package entry, and one export of it that must be a function.
const links = [
  ['@tanstack/ai', 'chat'],
  ['@tanstack/ai/testing', 'fakeText'],
  ['@tanstack/ai-harness', 'defineHarness'],
  ['@tanstack/ai-harness/view', 'createSessionView'],
  ['@tanstack/ai-harness/plugins', 'permissions'],
  ['@tanstack/ai-harness/plugins/node', 'agents'],
  ['@tanstack/ai-harness/plugins/coding', 'workspaceTools'],
  ['@tanstack/ai-persistence', 'defineAIPersistence'],
  ['@tanstack/ai-anthropic', 'anthropicText'],
  ['@tanstack/ai-openai', 'openaiText'],
  ['@tanstack/ai-grok', 'grokText'],
  ['@tanstack/ai-code-mode/harness', 'codeMode'],
  ['@tanstack/ai-isolate-quickjs', 'createQuickJSIsolateDriver'],
  ['@tanstack/ai-mcp/harness', 'mcp'],
  ['@tanstack/ai-sandbox', 'localSource'],
  ['@tanstack/ai-sandbox-docker', 'dockerSandbox'],
] as const

describe('links resolve', () => {
  // The import is the check. Each case imports its entry at run time,
  // so one broken link fails only its own case.
  test.each(links)('%s exports %s', async (specifier, name) => {
    const entry = await import(specifier)
    expect(entry[name]).toBeFunction()
  })
})

test('opentui renders', async () => {
  const setup = await testRender(<text fg={color.linen}>heddle</text>, {
    width: 20,
    height: 2,
  })
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('heddle')
  } finally {
    // The renderer unmounts the React root when it is destroyed.
    // act() tells React that this update is expected in a test.
    await act(() => setup.dispose())
  }
})

test('syntax style uses the theme colors', async () => {
  await using setup = await createTestRenderer({ width: 20, height: 2 })
  const style = createSyntaxStyle(setup.renderer)
  const styles = [...style.getAllStyles()]
  const fgByName = Object.fromEntries(
    styles.map(([name, definition]) => [name, definition.fg && rgbToHex(definition.fg)]),
  )
  expect(fgByName).toEqual({
    keyword: '#a9b0ff',
    string: '#7cc4a0',
    comment: '#5f594f',
    number: '#e3c26a',
    default: '#e8e2d6',
  })
})
