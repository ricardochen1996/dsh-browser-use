/**
 * Live progress from the browser subagent into the conversation that owns it.
 *
 * Watching a delegated browser task used to cost a blocked tool call: the conversation asked
 * `browser_task_status` with `wait: true` and sat in it for minutes, because that was the only way
 * to learn that the work was still going somewhere. The child already knows better — it records
 * every step it takes, and DSH delivers a message from a resident child to its parent — so this
 * feed pushes a short status message into the owning conversation from the child's own channel.
 * The conversation can end its turn and be woken by those messages instead of sleeping in a call.
 *
 * Two rules keep the stream cheap, because each message starts a turn in the conversation:
 * nothing is pushed that the last message did not already say, and pushes are coalesced into one
 * window per child — never shorter than `PROGRESS_MIN_MS`, whatever `progressIntervalMs` asks for,
 * and never longer than a timer can carry — where the first step of a window reports at once and a
 * step inside it is reported when the window closes.
 *
 * @module dsh-browser-use/progress
 */

import { duration } from './status.js'

/** How long the feed coalesces into when the profile names no interval. */
export const PROGRESS_DEFAULT_MS = 30_000
/** The shortest window a profile may ask for: a message that wakes the conversation is not free. */
export const PROGRESS_MIN_MS = 1_000
/**
 * The longest delay `setTimeout` keeps faithfully. A longer one is clamped to 1 ms — which would
 * fire the window at once and let a push and its flush land back to back — so the feed never asks
 * for one: a profile that writes a window of weeks still gets one window, reported once.
 */
const TIMER_MAX_MS = 2 ** 31 - 1

/** What a message says the browser showed, so an unchanged page is not reported twice. */
function signatureOf(view) {
  return view === undefined ? '' : `${view.url}|${view.observation}|${view.lastAction}`
}

/** The two lines one push carries: how long the child has worked, and where its browser is now. */
function progressText(childId, view, elapsed) {
  const lines = [
    `Browser subagent "${childId}" progress — ${duration(elapsed)} into the task (status only; no reply needed).`,
  ]
  if (view === undefined) {
    lines.push('It has not read a page yet.')
    return lines.join('\n')
  }
  const title = view.title ? `${view.title} — ` : ''
  const action = view.lastAction ? `, last action: ${view.lastAction}` : ''
  lines.push(`Page: ${title}${view.url} (observation ${view.observation}${action}).`)
  return lines.join('\n')
}

/**
 * The progress one conversation hears about its own browser child.
 *
 * It is fed by `Sessions.onStep`, so it never asks the browser anything: a step has already
 * happened by the time it is told. Everything it does with that step is best-effort — a step is
 * never delayed, never failed, and never reported as broken to the tool that took it.
 */
export class ProgressFeed {
  #ctx
  #config
  #sessions
  #childOf
  /** Browser child session id -> what has been reported about it: `{ signature, pushed, since, pushedAt, timer, owner }`. */
  #states = new Map()
  /** The pushes still in flight, so unloading the plugin can cancel them. */
  #controllers = new Set()
  /** A released feed is finished: the plugin that owned it is unloading and has no browser child left. */
  #released = false

  /**
   * @param ctx - the composition context: its agent registry says whether the child still lives,
   *   and its `subagents` service is the channel a child has to its parent.
   * @param options.config - the resolved plugin configuration, re-read on every step.
   * @param options.sessions - the Session browsers, for the view a message describes.
   * @param options.childOf - the conversation's browser child, by owning session id.
   */
  constructor(ctx, { config, sessions, childOf } = {}) {
    this.#ctx = ctx
    this.#config = config
    this.#sessions = sessions
    this.#childOf = childOf
  }

  /**
   * One browser step happened for the Agent that owns the browser.
   *
   * Called from inside a browser tool, so it returns without waiting for anything: the push is its
   * own promise, and a conversation that cannot be reached is a logged warning rather than a
   * failure the tool would have to explain.
   * @param owner - the conversation Agent whose browser took the step.
   */
  step(owner) {
    try {
      if (this.#released) return
      if (this.#config?.progress !== true) return
      const ownerId = owner?.id
      const childId = ownerId === undefined ? undefined : this.#childOf?.(ownerId)
      if (childId === undefined || childId === '') return
      // A message from a child DSH no longer holds would be refused; nothing is reported about it.
      if (this.#agents()?.get(childId) === undefined) return
      const signature = signatureOf(this.#sessions.viewOf(owner))
      const state = this.#state(childId)
      if (state.signature === signature) return
      state.signature = signature
      state.owner = owner
      // A flush is already pending for this window; it reports whatever the state is by then.
      if (state.timer !== undefined) return
      const now = Date.now()
      const interval = this.#interval()
      if (now - state.pushedAt >= interval) {
        this.#push(childId, state)
        return
      }
      state.timer = setTimeout(() => this.#flush(childId), state.pushedAt + interval - now)
    } catch (error) {
      this.#warn(`a browser step could not be turned into progress (${String(error)})`)
    }
  }

  /** A browser child settled or was replaced: forget what it was doing, and drop its pending report. */
  end(childId) {
    const state = this.#states.get(childId)
    if (state === undefined) return
    this.#states.delete(childId)
    if (state.timer !== undefined) clearTimeout(state.timer)
  }

  /** The plugin is unloading: stop every timer, and cancel the pushes that are still in flight. */
  release() {
    this.#released = true
    for (const state of this.#states.values()) if (state.timer !== undefined) clearTimeout(state.timer)
    this.#states.clear()
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
  }

  /**
   * The window a step is coalesced into: the profile's own interval, floored at the minimum and
   * held inside what a timer can carry.
   */
  #interval() {
    const asked = this.#config?.progressIntervalMs
    const interval = Number.isFinite(asked) ? asked : PROGRESS_DEFAULT_MS
    return Math.min(TIMER_MAX_MS, Math.max(PROGRESS_MIN_MS, interval))
  }

  #state(childId) {
    let state = this.#states.get(childId)
    if (state === undefined) {
      state = { signature: undefined, pushed: undefined, since: Date.now(), pushedAt: 0, timer: undefined, owner: undefined }
      this.#states.set(childId, state)
    }
    return state
  }

  #agents() {
    return this.#ctx.get?.('agents')
  }

  /**
   * The window closed. The state is read again rather than remembered, because the point of a
   * delayed report is to say where the work got to — and a child that ended meanwhile says nothing.
   */
  #flush(childId) {
    try {
      const state = this.#states.get(childId)
      if (state === undefined) return
      state.timer = undefined
      if (this.#released || this.#config?.progress !== true) return
      if (state.owner === undefined || this.#agents()?.get(childId) === undefined) return
      const signature = signatureOf(this.#sessions.viewOf(state.owner))
      state.signature = signature
      // Coalescing is not a reason to repeat: a window that ends on what was already sent says nothing.
      if (signature === state.pushed) return
      this.#push(childId, state)
    } catch (error) {
      this.#warn(`a delayed progress message for browser subagent "${childId}" failed (${String(error)})`)
    }
  }

  /** Send one message from the child to the conversation that owns it, without awaiting it. */
  #push(childId, state) {
    const view = this.#sessions.viewOf(state.owner)
    const now = Date.now()
    state.pushed = signatureOf(view)
    state.pushedAt = now
    const text = progressText(childId, view, now - state.since)
    const childAgent = this.#agents()?.get(childId)
    const subagents = this.#ctx.get?.('subagents')
    if (childAgent === undefined || typeof subagents?.sendMessage !== 'function') return
    const controller = new AbortController()
    this.#controllers.add(controller)
    const delivered = (async () => {
      try {
        await subagents.sendMessage(childAgent, state.owner.id, [{ type: 'text', text }], { signal: controller.signal })
      } catch (error) {
        this.#warn(`a progress message from browser subagent "${childId}" was not delivered (${String(error?.message ?? error)})`)
      } finally {
        this.#controllers.delete(controller)
      }
    })()
    // The push is fire-and-forget: whatever happens to it, it must not surface as an unhandled rejection.
    delivered.catch(() => {})
  }

  /** Progress is a courtesy; a context without a logger still gets a feed that cannot throw. */
  #warn(message) {
    try {
      this.#ctx?.logger?.warn?.(`dsh-browser-use: ${message}`)
    } catch {
      // a logger that fails is not a reason to fail a browser step
    }
  }
}
