/**
 * One sidecar process: line-delimited JSON over stdio, one browser session inside.
 *
 * A sidecar is a *generation*: when its browser cannot be shut down cleanly the process is
 * abandoned rather than reused, and the next browser this Session opens gets a new generation with
 * its own daemon name. Reusing a half-dead daemon is how a "close then reopen" turns into a tool
 * call that fails for reasons no one can see.
 *
 * @module dsh-browser-use/sidecar
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { SIDECAR, inspectEngine, reportText, resolveInterpreter } from './engine.js'
import { ENGINE_VARIABLES } from './jev.js'

/** The error a cancelled request settles with; the browser may still complete what it started. */
export function cancelled(signal) {
  const error = new Error(
    'dsh-browser-use: the operation was cancelled. The browser may still finish what it already '
    + 'started, so read the page again before acting on it.',
  )
  error.kind = 'cancelled'
  if (signal?.reason !== undefined) error.cause = signal.reason
  return error
}

/**
 * The daemon name one generation owns.
 *
 * Browser Harness names every daemon and keeps a registration per name: a name that a previous
 * generation did not release cleanly would be handed back to the next launch. A generation suffix
 * keeps that failure inside the generation that caused it.
 * @param label - the owning Session's filesystem-safe label.
 * @param generation - 1 for the first browser this Session opens.
 * @returns a name the engine accepts (it truncates nothing, so this stays within 64 characters).
 */
export function daemonName(label, generation) {
  const suffix = generation <= 1 ? '' : `-g${generation}`
  return `browser-use-dsh-${String(label).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64 - suffix.length)}${suffix}`
}

/** One sidecar process and the request/answer bookkeeping around it. */
/** DSH's own environment minus the engine's model variables, which the plugin config owns. */
function inheritedEnvironment() {
  const env = { ...process.env }
  for (const name of ENGINE_VARIABLES) delete env[name]
  return env
}

export class Sidecar {
  #child = null
  #interpreter = null
  #lines = null
  #pending = new Map()
  #sequence = 0
  #stderr = []
  #problem = ''

  constructor({ config, label, generation = 1 }) {
    this.config = config
    this.label = label
    this.generation = generation
  }

  /** Why this generation must not be reused, or an empty string while it is healthy. */
  get problem() {
    return this.#problem
  }

  /** Whether this generation still owns a usable process. */
  get broken() {
    return this.#problem !== ''
  }

  /**
   * Check the engine, then start the sidecar.
   *
   * The engine is a Python package with its own virtualenv: nothing in the plugin's own
   * installation can prove it is there, so it is probed before the first call and reported as a
   * problem list rather than surfacing later as a sidecar that exited.
   */
  async ready() {
    if (this.broken) throw new Error(`dsh-browser-use: this browser could not be cleaned up (${this.#problem})`)
    const report = await inspectEngine(this.config)
    if (!report.ok) {
      throw new Error(`dsh-browser-use: the browser engine is not ready.\n\n${reportText(report)}`)
    }
    // The probe already found the interpreter that imports the engine: the sidecar runs on that one
    // rather than on a second guess made here.
    this.#interpreter = report.interpreter
    await this.start()
  }

  async start() {
    if (this.#child) return
    const { command, prefix, cwd } = this.#interpreter ?? resolveInterpreter(this.config)
    const child = spawn(command, [...prefix, SIDECAR], {
      cwd,
      env: {
        // Jev's endpoints and keys come from the plugin configuration, with each call that spends them.
        ...inheritedEnvironment(),
        PYTHONUNBUFFERED: '1',
        // One daemon owns one CDP connection, and Browser Harness names its daemon when it imports.
        BU_NAME: daemonName(this.label, this.generation),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child = child
    this.#lines = createInterface({ input: child.stdout })
    this.#lines.on('line', line => this.#answered(line))
    child.stderr.on('data', chunk => {
      this.#stderr.push(String(chunk))
      if (this.#stderr.length > 40) this.#stderr.shift()
    })
    child.on('exit', (code, signal) => {
      const detail = this.#stderr.join('').trim().slice(-600)
      this.#child = null
      this.#fail(new Error(`dsh-browser-use: the browser sidecar exited (${code ?? signal})${detail ? `: ${detail}` : ''}`))
    })
    try {
      await this.request('hello', {}, undefined, 60000)
    } catch (error) {
      // A sidecar that cannot even greet is stopped here, so no half-started process is left behind.
      await this.stop()
      throw error
    }
  }

  #fail(error) {
    for (const [, entry] of this.#pending) {
      entry.reject(error)
    }
    this.#pending.clear()
  }

  #answered(line) {
    let answer
    try {
      answer = JSON.parse(line)
    } catch {
      return // a non-JSON line is the sidecar's own noise, never a protocol answer
    }
    const entry = this.#pending.get(answer.id)
    if (!entry) return
    if (answer.error) entry.reject(Object.assign(new Error(answer.error.message ?? 'refused'), answer.error))
    else entry.resolve(answer.result)
  }

  /**
   * Send one request and settle it on the answer, the deadline, cancellation, or process death.
   * @param method - engine method name.
   * @param params - engine parameters.
   * @param signal - the tool call's cancellation signal; aborting settles this promise only.
   * @param timeoutMs - deadline for this one request.
   */
  request(method, params = {}, signal, timeoutMs = this.config.requestTimeoutMs) {
    const child = this.#child
    if (!child) return Promise.reject(new Error('dsh-browser-use: the browser sidecar is not running'))
    if (signal?.aborted) return Promise.reject(cancelled(signal))
    const id = ++this.#sequence
    return new Promise((resolve, reject) => {
      let settled = false
      let timer
      const finish = next => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        next()
      }
      const onAbort = () => finish(() => reject(cancelled(signal)))
      timer = setTimeout(() => {
        finish(() => reject(new Error(`dsh-browser-use: ${method} did not answer within ${timeoutMs}ms`)))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: value => finish(() => resolve(value)),
        reject: error => finish(() => reject(error)),
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        finish(() => reject(error))
      }
    })
  }

  /**
   * Ask the engine to stop the tab, the browser, and the daemon, then make sure the process is
   * gone.
   *
   * A shutdown the engine reports as failed marks this generation unusable: the browser may still
   * be running, and reusing this daemon is exactly what turns that into an unexplained failure on
   * the next call.
   * @returns the shutdown problem, or an empty string when the generation ended cleanly.
   */
  async stop() {
    const child = this.#child
    if (!child) return this.#problem
    try {
      await this.request('shutdown', {}, undefined, 20000)
    } catch (error) {
      this.#problem = String(error?.message ?? error)
    }
    this.#child = null
    this.#fail(new Error('dsh-browser-use: the browser sidecar was closed'))
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      const ended = new Promise(resolve => child.once('exit', resolve))
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await ended
      clearTimeout(timer)
    }
    if (this.#problem === '' && child.exitCode !== 0 && child.signalCode !== null) {
      this.#problem = `the sidecar was killed with ${child.signalCode}`
    }
    return this.#problem
  }
}
