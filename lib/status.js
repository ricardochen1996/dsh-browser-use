/**
 * What the persistent browser subagent is doing, as the conversation that owns it can ask.
 *
 * DSH already reports a settled continuable child to its parent: a notice ("Background subagent …
 * finished") arrives as a message and wakes an idle parent. What the conversation lacked was a way
 * to look in between, and to block when it cannot go on without the result — so it slept in a shell
 * and guessed. This follows each persistent browser child through `subagent/start` and
 * `subagent/end`, remembers the task `browser_task` handed it, and lets `browser_task_status` wait on
 * the same edges the notice rides on, ending early when the user writes.
 *
 * @module dsh-browser-use/status
 */

/** How long `browser_task_status` waits when the call names no timeout. */
export const WAIT_DEFAULT_MS = 120_000
/** The longest single wait; a larger `timeout_ms` is clamped down to it. */
export const WAIT_MAX_MS = 600_000
const WAIT_MIN_MS = 1_000
/** How often a wait re-reads whether the child is still live, in case a settlement edge never arrives. */
const LIVENESS_MS = 1_000
/** How long a wait gives the settlement notice to land after the child left the agent registry. */
const NOTICE_GRACE_MS = 2_000
/** How long a wait ended by the child's message gives the child to settle, so a report sent just before finishing reads as finished. */
const MESSAGE_GRACE_MS = 1_000
const TASK_CHARS = 200
const CLOSING_CHARS = 1_500

/**
 * The wait a `browser_task_status` call asked for, clamped to what one call may block.
 * @param value - the model-supplied `timeout_ms`, if any.
 * @returns milliseconds to wait at most.
 */
export function waitTimeout(value) {
  const number = Number(value)
  if (value === undefined || value === null || !Number.isFinite(number)) return WAIT_DEFAULT_MS
  return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Math.round(number)))
}

/** A duration as a person reads it: 42s, 3m 5s, 1h 2m. */
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function excerpt(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function bounded(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}… (truncated)` : text
}

/** The text blocks of the child's final assistant output, as the settlement notice quotes them. */
function closingText(blocks) {
  return (blocks ?? [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n')
    .trim()
}

/** Where the browser the child drives is, from what the last browser tool result carried. */
function browserLine(view, now) {
  if (view === undefined) return 'The browser has not read a page yet.'
  return `The browser is on ${view.url || 'about:blank'}${view.title ? ` — ${view.title}` : ''} (observation ${view.observation}`
    + `${view.lastAction ? `, last action: ${view.lastAction}` : ''}, updated ${duration(now - view.updatedAt)} ago).`
}

/** The persistent browser children of this process, and the `browser_task_status` calls waiting on them. */
export class ChildStatus {
  #ctx
  /** Browser child session id -> what this process saw of it. */
  #records = new Map()
  /** Pending waits: `{ ownerId, childId, wake(reason) }`. */
  #waiters = new Set()

  /** @param ctx - the composition context; its agent registry says which children are live. */
  constructor(ctx) {
    this.#ctx = ctx
  }

  /** Follow one persistent browser child. Lifecycle edges of any child not followed are ignored. */
  track(childId) {
    let record = this.#records.get(childId)
    if (record === undefined) {
      record = { state: undefined, since: undefined, edges: 0, task: undefined, last: undefined }
      this.#records.set(childId, record)
    }
    return record
  }

  /** How many lifecycle edges this child has had, so a hand-off can tell whether one arrived meanwhile. */
  edges(childId) {
    return this.#records.get(childId)?.edges ?? 0
  }

  /**
   * `browser_task` gave the child a task. The lifecycle edges stay authoritative: only when none
   * arrived while the task was being delivered is the child taken to be working on it.
   */
  handed(childId, { instruction, url }, edgesBefore) {
    const record = this.track(childId)
    const at = Date.now()
    if (record.edges === edgesBefore && record.state !== 'running') {
      record.state = 'running'
      record.since = at
    }
    record.task = { instruction: excerpt(instruction, TASK_CHARS), url, at }
  }

  /** `subagent/start`: a followed child became resident and works. */
  started(childId) {
    const record = this.#records.get(childId)
    if (record === undefined) return
    record.edges += 1
    if (record.state !== 'running') {
      record.state = 'running'
      record.since = Date.now()
    }
  }

  /** `subagent/end`: a followed child settled. DSH has already sent its parent the settlement notice. */
  ended(info) {
    const record = this.#records.get(info?.id)
    if (record === undefined) return
    const at = Date.now()
    record.edges += 1
    record.last = {
      stopReason: String(info.stopReason ?? 'completed'),
      at,
      ran: record.state === 'running' && record.since !== undefined ? at - record.since : undefined,
      text: closingText(info.lastAssistantMessage),
    }
    record.state = 'idle'
    record.since = at
    this.#wake(waiter => waiter.childId === info.id, 'ended')
  }

  /**
   * `agent/inbox/inserted`: a message the waiting conversation must read ends its wait — the user
   * writing, the awaited child talking to it, or the notice that the child settled.
   */
  inserted(agent, message) {
    const source = message?.source
    if (agent === undefined || source === undefined) return
    if (source.kind === 'user') {
      this.#wake(waiter => waiter.ownerId === agent.id, 'user')
    } else if (source.kind === 'subagent-settled' || source.kind === 'agent-message') {
      this.#wake(
        waiter => waiter.ownerId === agent.id && waiter.childId === source.senderSessionId,
        source.kind === 'subagent-settled' ? 'notice' : 'message',
      )
    }
  }

  /**
   * Whether the child is working now. A continuable child is live in the agent registry exactly
   * while it works; the recorded edges answer for a host without that registry.
   */
  running(childId) {
    const agents = this.#ctx.get?.('agents')
    if (typeof agents?.get === 'function') return agents.get(childId) !== undefined
    return this.#records.get(childId)?.state === 'running'
  }

  /**
   * Block until the child settles, messages the owner, the user writes to the owner, or the timeout passes.
   * @param options.ownerId - the conversation waiting.
   * @param options.childId - its browser child.
   * @param options.timeoutMs - the longest this call blocks.
   * @param options.signal - cancellation of the tool call; a cancelled wait rejects.
   * @returns why the wait ended, and how long it took.
   */
  wait({ ownerId, childId, timeoutMs, signal }) {
    signal?.throwIfAborted()
    const began = Date.now()
    return new Promise((resolve, reject) => {
      const reasons = new Set()
      const timers = []
      let poll
      let done = false
      const close = () => {
        done = true
        for (const timer of timers) clearTimeout(timer)
        clearInterval(poll)
        this.#waiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = () => {
        if (done) return
        close()
        resolve({ reasons, waited: Date.now() - began })
      }
      const onAbort = () => {
        if (done) return
        close()
        reject(signal.reason ?? new Error('dsh-browser-use: the wait was cancelled'))
      }
      const waiter = {
        ownerId,
        childId,
        wake: reason => {
          if (done || reasons.has(reason)) return
          reasons.add(reason)
          // The notice and `subagent/end` are published in one synchronous step: a turn of the event
          // loop lets the second land before the answer is written. A child that left the registry
          // gets longer, because its notice follows once its disposal completes; so does a child that
          // just sent a message, because a report is often its last act before it settles.
          const grace = reason === 'gone' ? NOTICE_GRACE_MS : reason === 'message' ? MESSAGE_GRACE_MS : 0
          timers.push(setTimeout(finish, grace))
        },
      }
      this.#waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      timers.push(setTimeout(() => waiter.wake('timeout'), timeoutMs))
      poll = setInterval(() => { if (!this.running(childId)) waiter.wake('gone') }, LIVENESS_MS)
    })
  }

  /** End every pending wait: the tools they were called through are being taken down. */
  release() {
    this.#wake(() => true, 'released')
  }

  #wake(matches, reason) {
    for (const waiter of [...this.#waiters]) if (matches(waiter)) waiter.wake(reason)
  }

  /** One phrase for the doctor: working for how long, or idle and how the last run ended. */
  summary(childId) {
    const now = Date.now()
    const record = this.#records.get(childId)
    if (this.running(childId)) {
      return record?.state === 'running' && record.since !== undefined ? `working for ${duration(now - record.since)}` : 'working'
    }
    const last = record?.last
    return last === undefined ? 'idle' : `idle; its last run ended ${duration(now - last.at)} ago: ${last.stopReason}`
  }

  /**
   * The `browser_task_status` answer.
   * @param childId - the conversation's browser child.
   * @param options.view - the conversation's browser, as `Sessions.viewOf` reports it.
   * @param options.wait - whether the call asked to wait.
   * @param options.outcome - how the wait ended, when there was one.
   * @returns model-facing text.
   */
  describe(childId, { view, wait = false, outcome } = {}) {
    const now = Date.now()
    const record = this.#records.get(childId)
    const id = JSON.stringify(childId)
    const reasons = outcome?.reasons ?? new Set()
    const last = record?.last
    const ran = last?.ran === undefined ? '' : ` after ${duration(last.ran)}`
    const lines = []

    if (reasons.has('ended') || reasons.has('notice') || reasons.has('gone')) {
      const partial = last !== undefined && last.stopReason !== 'completed'
        ? `, ending with status ${last.stopReason}, so its report may be partial`
        : ''
      lines.push(`The browser subagent ${id} finished${ran}${partial}.`)
      if (reasons.has('notice')) lines.push('Its report follows this result as a message in this conversation; read it there.')
      else if (last?.text) lines.push(`Its closing message:\n${bounded(last.text, CLOSING_CHARS)}`)
      else lines.push('Its report arrives as a message in this conversation.')
      if (reasons.has('user')) lines.push('The user also sent a message, which follows this result.')
      lines.push(browserLine(view, now))
      lines.push('Call browser_task for its next task.')
      return lines.join('\n')
    }

    if (this.running(childId)) {
      const since = record?.state === 'running' && record.since !== undefined ? ` (for ${duration(now - record.since)})` : ''
      if (reasons.has('user')) {
        lines.push(`Stopped waiting because the user sent a message, which follows this result. The browser subagent ${id} is still working${since}.`)
      } else if (reasons.has('message')) {
        lines.push(`Stopped waiting because the browser subagent ${id} sent you a message, which follows this result. It is still working${since}.`)
      } else if (reasons.has('released')) {
        lines.push(`Stopped waiting because the browser plugin was reloaded or unloaded. The browser subagent ${id} is still working${since}.`)
      } else if (reasons.has('timeout')) {
        lines.push(`Waited ${duration(outcome.waited)}; the browser subagent ${id} is still working${since}.`)
      } else {
        lines.push(`The browser subagent ${id} is working${since}.`)
      }
      const task = record?.task
      if (task !== undefined) {
        lines.push(`Its latest task, handed ${duration(now - task.at)} ago: "${task.instruction}"${task.url ? ` (starting at ${task.url})` : ''}.`)
      }
      lines.push(browserLine(view, now))
      lines.push('You are notified when it finishes: its report arrives as a message in this conversation. '
        + 'Continue with steps that do not need the result, or end your turn; do not sleep or poll. '
        + (reasons.has('timeout')
          ? 'Wait again only if you still cannot go on without the result.'
          : 'Call browser_task_status with wait: true only when you cannot go on without the result.'))
      return lines.join('\n')
    }

    lines.push(`${wait ? 'Nothing to wait for: the' : 'The'} browser subagent ${id} is idle; it does no further work until browser_task or send_message gives it more.`)
    if (last !== undefined) {
      lines.push(`Its last run ended ${duration(now - last.at)} ago${ran}: ${last.stopReason}. Its report was delivered to this conversation as a message.`)
      if (last.text) lines.push(`Its closing message:\n${bounded(last.text, CLOSING_CHARS)}`)
    }
    lines.push(browserLine(view, now))
    lines.push('Call browser_task for its next task.')
    return lines.join('\n')
  }
}
