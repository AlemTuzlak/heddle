// Small helpers that the state and UI modules share. They know nothing about heddle.

/** True for a JSON object: not `null`, and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `path` relative to `root`, with `/`. A path outside `root` stays as it is. */
export function relativePath(path: string, root: string) {
  const slashed = path.replaceAll('\\', '/')
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '')
  // On Windows, two paths that differ only in case are the same path.
  const isWindows = /^[a-z]:/i.test(base)
  const comparable = (text: string) => (isWindows ? text.toLowerCase() : text)
  if (comparable(slashed) === comparable(base)) return '.'
  const isInside = comparable(slashed).startsWith(`${comparable(base)}/`)
  return isInside
    ? slashed.slice(base.length + 1)
    : slashed.replace(/^\.\//, '')
}
