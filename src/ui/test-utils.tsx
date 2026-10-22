// A test terminal for the screens of heddle. Only the tests import this file.
import { rgbToHex } from '@opentui/core'
import type { MockInput, TestRendererOptions } from '@opentui/core/testing'
import { testRender } from '@opentui/react/test-utils'
import { act, type ReactNode } from 'react'

/** OpenTUI sends a lone esc as a key after 20 ms. A test waits a little more. */
export const ESCAPE_WAIT_MS = 40

/**
 * Render `node` in a test terminal. `options` are the options of the test
 * renderer: the size, and for example `exitOnCtrlC`. `input` sends keys inside
 * act(), waits `waitMs` for the answers to settle, and draws the next frame.
 * Dispose it with `await using`.
 */
export async function mount(node: ReactNode, options: TestRendererOptions = { width: 100, height: 20 }) {
  const setup = await testRender(node, options)
  await setup.renderOnce()
  const frame = () => setup.captureCharFrame()
  return {
    renderer: setup.renderer,
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
