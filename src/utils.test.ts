import { describe, expect, test } from 'bun:test'
import { cutEnd, cutStart, graphemes, isRecord, padWidth, relativePath, widest } from './utils'

describe('isRecord', () => {
  test('is true for an object', () => {
    expect(isRecord({ path: 'a.ts' })).toBe(true)
  })

  test('is false for null, an array, and a string', () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord(['a'])).toBe(false)
    expect(isRecord('a')).toBe(false)
  })
})

describe('relativePath', () => {
  test('a path inside the root loses the root', () => {
    expect(relativePath('/workspace/src/a.ts', '/workspace')).toBe('src/a.ts')
  })

  test('a Windows path uses / and ignores case', () => {
    expect(relativePath('F:\\Projects\\App\\src\\a.ts', 'f:\\projects\\app\\')).toBe('src/a.ts')
  })

  test('the root itself is .', () => {
    expect(relativePath('/workspace', '/workspace/')).toBe('.')
  })

  test('a path outside the root stays as it is', () => {
    expect(relativePath('/tmp/x.ts', '/workspace')).toBe('/tmp/x.ts')
    expect(relativePath('/workspace-old/a.ts', '/workspace')).toBe('/workspace-old/a.ts')
  })
})

describe('text width', () => {
  test('an emoji with a skin tone is one character', () => {
    expect(graphemes('a👍🏽b')).toEqual(['a', '👍🏽', 'b'])
  })

  test('cutEnd keeps the start and ends with …', () => {
    expect(cutEnd('Fix the failing add test', 10)).toBe('Fix the f…')
    expect(cutEnd('short', 10)).toBe('short')
    expect(cutEnd('anything', 0)).toBe('')
  })

  test('cutStart keeps the end and starts with …', () => {
    expect(cutStart('src/very/long/path/math.ts', 12)).toBe('…ath/math.ts')
  })

  test('a cut never makes wide text wider than the width', () => {
    // Each of these characters takes 2 cells.
    const cut = cutEnd('漢字漢字漢字', 7)
    expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(7)
    expect(cut).toBe('漢字漢…')
  })

  test('padWidth fills the cells, also for wide text', () => {
    expect(padWidth('ab', 5)).toBe('ab   ')
    expect(padWidth('漢', 4)).toBe('漢  ')
    expect(padWidth('toolong', 3)).toBe('toolong')
  })

  test('widest counts cells, and is 0 for no texts', () => {
    expect(widest(['a', '漢字', 'abc'])).toBe(4)
    expect(widest([])).toBe(0)
  })
})
