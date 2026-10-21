import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard, usePaste } from '@opentui/react'
import type { Approval, ViewQuestion } from '@tanstack/ai-harness/view'
import { Fragment, useRef, useState, type ReactNode } from 'react'
import { isRecord } from '../utils'
import { isEnter, isPlain, pastedText, typedText, useKeyState } from './keys'
import { color } from './theme'

/** One dot for each character of a secret. */
const MASK = '•'

/** The most characters of a tool target or a question that the bar shows. */
const MAX_SHOWN = 300

/** The argument names that say what a tool call acts on, in the order the bar reads them. */
const TARGET_KEYS = ['path', 'command', 'pattern', 'url', 'query']

/** The answers of a code mode approval: `APPROVAL_ANSWER_SCHEMA` in the harness. */
const APPROVAL_CHOICES = ['once', 'always', 'reject']

/** The space between two key hints. */
const GAP = '  '

/** The problem text when an answer did not go through, else `undefined`. */
type Reply = Promise<string | undefined>

/** What the approval keys do: `y` once, `a` always, and `n` no, with a reason. */
interface Decisions {
  once: () => Reply
  always: () => Reply
  reject: (reason: string) => Reply
}

/** A choice of a question, and the key that picks it. */
interface ChoiceKey {
  key: string
  label: string
  value: unknown
}

function isList(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value)
}

/** `text` with at most `MAX_SHOWN` characters. A longer text says how many characters it hides. */
function cut(text: string) {
  const characters = Array.from(text)
  const hidden = characters.length - MAX_SHOWN
  if (hidden <= 0) return text
  return `${characters.slice(0, MAX_SHOWN).join('')}… (${hidden} more characters)`
}

/** `text` on one line: each run of spaces and line breaks becomes one space. */
function oneLine(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * What a tool call acts on: its path, command, pattern, URL, or query. Else
 * its arguments as JSON.
 */
function targetOf(args: unknown) {
  if (args === undefined) return ''
  if (typeof args === 'string') return oneLine(args)
  const named = isRecord(args)
    ? TARGET_KEYS.map((key) => args[key]).find(
        (value): value is string => typeof value === 'string',
      )
    : undefined
  return oneLine(named ?? JSON.stringify(args))
}

/** The `enum` of a JSON Schema, when it has one. */
function enumOf(schema: unknown) {
  return isRecord(schema) && isList(schema.enum) ? schema.enum : undefined
}

/** The choices of an answer schema: its `enum`, else the first `enum` of its `anyOf` or `oneOf`. */
function choicesOf(schema: unknown) {
  if (!isRecord(schema)) return undefined
  const branches = schema.anyOf ?? schema.oneOf
  const candidates = isList(branches) ? [schema, ...branches] : [schema]
  return candidates.map(enumOf).find((choices) => choices !== undefined)
}

/** True when the choices are the answers of a code mode approval. */
function isApprovalQuestion(choices: ReadonlyArray<unknown>) {
  const isSameCount = choices.length === APPROVAL_CHOICES.length
  return isSameCount && APPROVAL_CHOICES.every((choice) => choices.includes(choice))
}

/** The text that shows a choice. */
function labelOf(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * One key for each choice: its first letter or digit. When two choices start
 * with the same character, or a choice starts with another character, the
 * keys are 1 to 9, in order. Then, with more than 9 choices, it gives
 * `undefined`, and the bar shows a text input.
 */
function choiceKeys(choices: ReadonlyArray<unknown>) {
  const labeled = choices.map((value) => {
    const label = labelOf(value)
    return { value, label, first: label.charAt(0).toLowerCase() }
  })
  const firsts = new Set(labeled.map((choice) => choice.first))
  const isEachFirstFree = firsts.size === labeled.length
  const isEachTypable = labeled.every((choice) => /^[a-z0-9]$/.test(choice.first))
  if (isEachFirstFree && isEachTypable) {
    return labeled.map(({ value, label, first }) => ({ key: first, label, value }))
  }
  if (labeled.length > 9) return undefined
  return labeled.map(({ value, label }, index) => ({ key: String(index + 1), label, value }))
}

/** Answer `question`. It gives the problem text when the session did not take the answer. */
async function answerWith(question: ViewQuestion, value: unknown) {
  const receipt = await question.answer(value)
  return receipt.status === 'rejected' ? `Not accepted: ${receipt.reason}` : undefined
}

/** The keys of a tool call approval. `permissions()` reads the payload `always` as "always". */
function approvalDecisions(approval: Approval) {
  return {
    once: async () => {
      approval.approve()
      return undefined
    },
    always: async () => {
      approval.approve({ payload: 'always' })
      return undefined
    },
    reject: async (reason) => {
      if (reason === '') approval.reject()
      else approval.reject({ payload: reason })
      return undefined
    },
  } satisfies Decisions
}

/** The keys of a code mode approval: a question whose answers are once, always, and reject. */
function questionDecisions(question: ViewQuestion) {
  return {
    once: () => answerWith(question, 'once'),
    always: () => answerWith(question, 'always'),
    // `readApproval` in the harness reads `message` as the reason for the model.
    reject: (reason) =>
      answerWith(question, reason === '' ? 'reject' : { answer: 'reject', message: reason }),
  } satisfies Decisions
}

/**
 * Sends one answer at a time. After a send, `isSent()` is true, so a second
 * key does not answer again. When the answer did not go through, `isSent()`
 * is false again, and `problem` says why.
 */
function useSend() {
  const sent = useKeyState(false)
  const [problem, setProblem] = useState('')
  const send = (answer: () => Reply) => {
    if (sent.now()) return
    sent.set(true)
    setProblem('')
    void answer()
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .then((failure) => {
        if (failure === undefined) return
        sent.set(false)
        setProblem(failure)
      })
  }
  return { sent: sent.value, isSent: sent.now, problem, send }
}

/**
 * The text that the user types or pastes into the bar. A paste adds to it
 * while `isActive()` is true. A key handler gives each key to `press`. The
 * render draws `shown`: for a secret, one dot for each character, so the
 * secret is never in the state that React draws.
 */
function useDraft(secret: boolean, isActive: () => boolean) {
  const text = useRef('')
  const [shown, setShown] = useState('')
  const set = (next: string) => {
    text.current = next
    setShown(secret ? MASK.repeat(Array.from(next).length) : next)
  }
  usePaste((event) => {
    if (!isActive()) return
    event.preventDefault()
    set(text.current + pastedText(event.bytes))
  })
  /** Enter calls `onSubmit` with the text. Other keys type or delete. True for a key it used. */
  const press = (key: KeyEvent, onSubmit: (text: string) => void) => {
    if (isEnter(key)) {
      onSubmit(text.current)
      return true
    }
    if (key.name === 'backspace') {
      set(Array.from(text.current).slice(0, -1).join(''))
      return true
    }
    const typed = typedText(key)
    if (typed === undefined) return false
    set(text.current + typed)
    return true
  }
  return { shown, press }
}

/** The box around the bar. Its border is yellow while the bar has the keys. */
function Frame({ focused, children }: { focused: boolean; children: ReactNode }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={focused ? color.weld : color.line}
      backgroundColor={color.weldBg}
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
    >
      {children}
    </box>
  )
}

/** A key in a chip, then what it does: ` y once`. Use it inside `<text>`. */
function KeyHint({ name, label }: { name: string; label: string }) {
  return (
    <>
      <span fg={color.linen} bg={color.line}>{` ${name} `}</span>
      {label}
    </>
  )
}

/** A line of the bar, with the keys at its right. In a narrow bar, the keys go under the line. */
function Ask({ line, children }: { line: ReactNode; children?: ReactNode }) {
  return (
    <box flexDirection="row" flexWrap="wrap" columnGap={2}>
      <text flexGrow={1} flexShrink={1} minWidth="40%" fg={color.linen}>
        {line}
      </text>
      {children ? (
        <text flexShrink={0} fg={color.linen}>
          {children}
        </text>
      ) : null}
    </box>
  )
}

/** The page that the user must open before the answer. */
function Link({ url }: { url: string }) {
  return (
    <text fg={color.muted} wrapMode="char">
      {'open '}
      <a href={url} fg={color.indigo} attributes={TextAttributes.UNDERLINE}>
        {url}
      </a>
    </text>
  )
}

/** The text input: a prompt, the text or its dots, the cursor, and the keys. */
function Field({ prompt, shown, focused, back }: {
  prompt: string
  shown: string
  focused: boolean
  back: boolean
}) {
  const line = (
    <>
      <span fg={color.weld}>{`${prompt} `}</span>
      {shown}
      {focused ? <span bg={color.linen}> </span> : null}
    </>
  )
  return (
    <Ask line={line}>
      <KeyHint name="enter" label="send" />
      {back ? (
        <>
          {GAP}
          <KeyHint name="esc" label="back" />
        </>
      ) : null}
    </Ask>
  )
}

/** The problem of the last answer, in red. */
function Problem({ text }: { text: string }) {
  return text === '' ? null : <text fg={color.madder}>{text}</text>
}

/** The bar after the answer went out: what it asked, and `sent`. */
function SentBar({ line, focused }: { line: ReactNode; focused: boolean }) {
  return (
    <Frame focused={focused}>
      <Ask line={line}>
        <span fg={color.muted}>sent</span>
      </Ask>
    </Frame>
  )
}

/** `bash wants to run node --test`: the tool, and what it acts on. */
function ToolLine({ approval }: { approval: Approval }) {
  const target = cut(targetOf(approval.args))
  return (
    <>
      <strong fg={color.weld}>{approval.tool}</strong>
      {' wants to run'}
      {target === '' ? null : <span bg={color.line}>{` ${target} `}</span>}
    </>
  )
}

/**
 * The approval keys: `y` once, `a` always, and `n` no. After `n`, the user
 * types why, enter sends it, and esc goes back to the keys.
 */
function Decide({ line, url, decisions, focused }: {
  line: ReactNode
  url?: string
  decisions: Decisions
  focused: boolean
}) {
  const asking = useKeyState(false)
  const { sent, isSent, problem, send } = useSend()
  const reason = useDraft(false, () => focused && asking.now() && !isSent())
  useKeyboard((key) => {
    if (!focused || isSent()) return
    if (asking.now()) {
      if (key.name === 'escape') {
        key.preventDefault()
        asking.set(false)
        return
      }
      const isUsed = reason.press(key, (text) => send(() => decisions.reject(text.trim())))
      if (isUsed) key.preventDefault()
      return
    }
    if (!isPlain(key)) return
    switch (key.name) {
      case 'y':
        key.preventDefault()
        send(decisions.once)
        return
      case 'a':
        key.preventDefault()
        send(decisions.always)
        return
      case 'n':
        key.preventDefault()
        asking.set(true)
        return
    }
  })
  if (sent) return <SentBar line={line} focused={focused} />
  const keys = (
    <>
      <KeyHint name="y" label="once" />
      {GAP}
      <KeyHint name="a" label="always" />
      {GAP}
      <KeyHint name="n" label="no, and say why" />
    </>
  )
  return (
    <Frame focused={focused}>
      <Ask line={line}>{asking.value ? null : keys}</Ask>
      {url ? <Link url={url} /> : null}
      {asking.value ? (
        <Field prompt="say why ›" shown={reason.shown} focused={focused} back />
      ) : null}
      <Problem text={problem} />
    </Frame>
  )
}

/** A question with choices: one key for each choice. */
function Choose({ question, keys, focused }: {
  question: ViewQuestion
  keys: ReadonlyArray<ChoiceKey>
  focused: boolean
}) {
  const { sent, isSent, problem, send } = useSend()
  useKeyboard((key) => {
    if (!focused || isSent() || !isPlain(key)) return
    const picked = keys.find((choice) => choice.key === key.name)
    if (!picked) return
    key.preventDefault()
    send(() => answerWith(question, picked.value))
  })
  const line = cut(question.message)
  if (sent) return <SentBar line={line} focused={focused} />
  return (
    <Frame focused={focused}>
      <Ask line={line}>
        {keys.map((choice, index) => (
          <Fragment key={choice.key}>
            {index === 0 ? '' : GAP}
            <KeyHint name={choice.key} label={choice.label} />
          </Fragment>
        ))}
      </Ask>
      {question.url ? <Link url={question.url} /> : null}
      <Problem text={problem} />
    </Frame>
  )
}

/** A question with a text answer. A secret shows one dot for each character. */
function Type({ question, focused }: { question: ViewQuestion; focused: boolean }) {
  const { sent, isSent, problem, send } = useSend()
  const draft = useDraft(question.secret === true, () => focused && !isSent())
  useKeyboard((key) => {
    if (!focused || isSent()) return
    if (draft.press(key, (text) => send(() => answerWith(question, text)))) key.preventDefault()
  })
  const line = cut(question.message)
  if (sent) return <SentBar line={line} focused={focused} />
  return (
    <Frame focused={focused}>
      <Ask line={line} />
      {question.url ? <Link url={question.url} /> : null}
      <Field prompt="›" shown={draft.shown} focused={focused} back={false} />
      <Problem text={problem} />
    </Frame>
  )
}

/**
 * The bar above the composer that asks the user something. It shows one of:
 *
 * - An approval: `bash wants to run node --test`, then `y` once, `a` always,
 *   and `n` no. After `n`, the user types why, and enter sends it.
 * - A code mode approval (a question with the answers once, always, and
 *   reject): the same keys.
 * - A question with choices: one key for each choice, its first letter. When
 *   two choices start with the same letter, the keys are 1 to 9.
 * - Any other question: a text input, and enter sends it. A secret shows one
 *   `•` for each character, and paste works. A question with a `url` shows
 *   the link.
 *
 * The bar takes keys and pastes only while `focused` is true. After an
 * answer, it shows `sent` until it gets another approval or question.
 *
 * The view keeps an answered approval in `approvals` until each approval of
 * the turn has an answer. Give the bar the first approval that the user did
 * not answer yet. Else the bar shows `sent` for the same approval again.
 *
 * @param approval The approval to answer. The bar shows it before `question`.
 * @param question The question to answer, when there is no approval.
 * @param focused True while the bar has the keys.
 * @example
 * const { approvals, questions } = view.store.get()
 * <ApprovalBar approval={approvals[0]} question={questions[0]} focused />
 */
export function ApprovalBar({ approval, question, focused }: {
  approval?: Approval
  question?: ViewQuestion
  focused: boolean
}) {
  if (approval) {
    return (
      <Decide
        key={approval.id}
        line={<ToolLine approval={approval} />}
        decisions={approvalDecisions(approval)}
        focused={focused}
      />
    )
  }
  if (!question) return null
  const choices = choicesOf(question.schema)
  if (choices !== undefined && isApprovalQuestion(choices)) {
    return (
      <Decide
        key={question.id}
        line={cut(question.message)}
        url={question.url}
        decisions={questionDecisions(question)}
        focused={focused}
      />
    )
  }
  const keys = choices === undefined ? undefined : choiceKeys(choices)
  if (keys !== undefined) {
    return <Choose key={question.id} question={question} keys={keys} focused={focused} />
  }
  return <Type key={question.id} question={question} focused={focused} />
}
