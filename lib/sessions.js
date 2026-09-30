/**
 * Browser ownership: one browser per conversation, serialized operations, one attached browser at
 * a time.
 *
 * The browser belongs to the *Session that asked for the work*, not to the delegated child that
 * drives it: a conversation reuses one browser across delegations, keeps its logins and tabs, and
 * closes it when the Session ends. Resuming or forking a Session starts a fresh browser, because
 * browser state is not restored from a Session log.
 *
 * @module dsh-browser-use/sessions
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { Sidecar } from './sidecar.js'

/** A browser tool is only meaningful inside one live Agent, which owns the browser. */
export function requireLiveAgent(ctx, agent, who) {
  if (agent === undefined || ctx.get('agents')?.get(agent.id) !== agent) {
    throw new Error(`dsh-browser-use: ${who} requires an exact live Agent`)
  }
  return agent
}

/** The stable, filesystem-safe name one Session's browser profile uses. */
export function labelFor(agent) {
  return String(agent.id ?? 'session').replace(/[^A-Za-z0-9]/g, '').slice(-24) || 'session'
}

/**
 * Connection options travel with every request that may have to start a browser.
 *
 * A launched browser gets its own profile directory per Session: two live Sessions must not share
 * one profile, because Chrome hands a second launch on a claimed profile to the instance that
 * already owns it — and then both Sessions would drive one browser.
 * @param config - resolved plugin configuration.
 * @param label - the owning Session's profile label.
 */
export function connectionFor(config, label) {
  return {
    mode: config.mode,
    ...(config.cdpEndpoint ? { cdpEndpoint: config.cdpEndpoint } : {}),
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    userDataDir: config.userDataDir || join(homedir(), '.jev-ultrafast', 'browser', label),
    ...(config.headless ? { headless: true } : {}),
  }
}

/** One Session's browser: its sidecar generation, its operation queue, its last observation. */
export class Sessions {
  #entries = new Map()
  #attachOwner

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  /** The Session that currently holds the attached browser, if any. */
  get attachOwner() {
    return this.#attachOwner
  }

  /** The Session-scoped browser, opened once and reused across turns and delegations. */
  entry(owner) {
    requireLiveAgent(this.ctx, owner, 'a browser tool')
    const existing = this.#entries.get(owner)
    if (existing) return existing
    const label = labelFor(owner)
    const entry = {
      owner,
      label,
      generation: 1,
      sidecar: undefined,
      problem: '',
      tail: Promise.resolve(),
      delegations: Promise.resolve(),
      observation: 0,
      fingerprints: new Map(),
      last: null,
      lastAction: '',
      updatedAt: Date.now(),
    }
    const scope = owner.ctx ?? this.ctx
    scope.effect(() => async () => {
      this.#entries.delete(owner)
      this.#releaseAttach(entry)
      await entry.sidecar?.stop()
    }, 'dsh-browser-use.session')
    this.#entries.set(owner, entry)
    return entry
  }

  /** The sidecar this Session may use now: the same generation while it is healthy, else a new one. */
  #sidecar(entry) {
    if (entry.sidecar && !entry.sidecar.broken) return entry.sidecar
    if (entry.sidecar?.broken) {
      // The previous generation could not be cleaned up. It is never reused: the next browser is a
      // new process, a new daemon name, and a Session that has been told what happened.
      entry.problem = entry.sidecar.problem
      entry.generation += 1
    }
    entry.sidecar = new Sidecar({ config: this.config, label: entry.label, generation: entry.generation })
    return entry.sidecar
  }

  /**
   * Run one browser operation after this Session's earlier operations settle.
   * @param owner - the Session that owns the browser.
   * @param signal - cancellation for this one call.
   * @param operation - receives the Session entry, its sidecar, and the live signal.
   */
  run(owner, signal, operation) {
    signal?.throwIfAborted()
    const entry = this.entry(owner)
    const task = entry.tail.then(async () => {
      signal?.throwIfAborted()
      const sidecar = this.#sidecar(entry)
      this.#reserveAttach(entry)
      await sidecar.ready()
      return operation(entry, sidecar, signal)
    })
    entry.tail = task.then(() => {}, () => {})
    return task
  }

  /** Run one delegation after this Session's earlier delegation settles, without holding the browser queue. */
  queueDelegation(owner, signal, operation) {
    signal?.throwIfAborted()
    const entry = this.entry(owner)
    const task = entry.delegations.then(async () => {
      signal?.throwIfAborted()
      return operation(entry, signal)
    })
    entry.delegations = task.then(() => {}, () => {})
    return task
  }

  /**
   * Reserve the attached browser for one Session.
   *
   * An attached browser is owned by whoever started it, so this provider keeps it for the first
   * live Session that drives it and refuses a second one: two Sessions driving one external
   * browser would fight over its tabs and its logins.
   */
  #reserveAttach(entry) {
    if (this.config.mode !== 'attach') return
    if (this.#attachOwner !== undefined && this.#attachOwner !== entry.owner.id) {
      throw new Error(
        `dsh-browser-use: the browser at ${this.config.cdpEndpoint} is attached by another live Session. `
        + 'Wait for that Session to close its browser, or give each Session its own browser with mode "launch".',
      )
    }
    this.#attachOwner = entry.owner.id
  }

  #releaseAttach(entry) {
    if (entry.owner.id === this.#attachOwner) this.#attachOwner = undefined
  }

  /** Close this Session's browser and let the next browser tool open a fresh generation. */
  async close(entry) {
    const problem = await entry.sidecar?.stop() ?? ''
    entry.sidecar = undefined
    entry.problem = problem
    // A generation that could not clean up is never reused, not even by name: its browser may still
    // be running, and the next launch takes a daemon name of its own.
    if (problem !== '') entry.generation += 1
    this.#releaseAttach(entry)
    entry.fingerprints.clear()
    entry.last = null
    entry.lastAction = ''
    entry.updatedAt = Date.now()
    return problem
  }

  /** The label this Session's browser uses, without acquiring one. */
  labelOf(owner) {
    return this.#entries.get(owner)?.label ?? labelFor(owner)
  }

  /** The observation id the model must name, plus the fingerprint the bridge checks. */
  observed(entry, page) {
    entry.observation += 1
    entry.fingerprints.set(entry.observation, page.fingerprint)
    entry.last = { observation: entry.observation, page }
    entry.updatedAt = Date.now()
    return entry.observation
  }

  fingerprint(entry, observation) {
    return entry.fingerprints.get(Number(observation))
  }

  /** Remember what the last executed action was, for the inspector's one-line summary. */
  noteAction(entry, description) {
    entry.lastAction = description
    entry.updatedAt = Date.now()
  }

  /** What the inspector and the doctor show: only what a tool result already carries. */
  view() {
    return [...this.#entries.values()]
      .filter(entry => entry.last)
      .map(entry => ({
        label: entry.label,
        url: entry.last.page.url,
        title: entry.last.page.title ?? '',
        text: entry.last.page.text ?? '',
        observation: entry.last.observation,
        lastAction: entry.lastAction,
        updatedAt: entry.updatedAt,
        problem: entry.problem,
        elements: entry.last.page.elements ?? [],
        operations: entry.last.page.operations ?? {},
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The last snapshot for one Session, as the doctor reports it. */
  viewOf(owner) {
    return this.view().find(item => item.label === labelFor(owner))
  }

  /** A fresh capture for the inspector; unrelated to any tool call and never retried. */
  async capture(label) {
    const entry = [...this.#entries.values()].find(candidate => candidate.label === label && candidate.last)
      ?? [...this.#entries.values()].find(candidate => candidate.last)
    if (!entry?.sidecar || entry.sidecar.broken) return undefined
    try {
      const shot = await entry.sidecar.request('screenshot', {}, undefined, 30000)
      return Buffer.from(shot.jpeg_base64, 'base64')
    } catch {
      return undefined // the panel keeps the last picture while a browser is busy or absent
    }
  }

  async dispose() {
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    this.#attachOwner = undefined
    await Promise.allSettled(entries.map(entry => entry.sidecar?.stop()))
  }
}
