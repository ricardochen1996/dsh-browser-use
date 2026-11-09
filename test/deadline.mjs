/**
 * The sidecar request deadline, driven through the real `Sidecar.request` against a stub engine.
 *
 * Run with `node test/deadline.mjs`.
 *
 * Node keeps a `setTimeout` delay in a 32-bit signed integer and shortens anything larger to 1 ms,
 * with a `TimeoutOverflowWarning`. `browser_goal` asks for `Number.MAX_SAFE_INTEGER` because a run
 * has no fixed budget, so before the clamp that "never" deadline fired on the next tick and every
 * goal run failed at once with "did not answer within 9007199254740991ms".
 *
 * A raw `setTimeout` re-check cannot see that: it passes while the bug is still in
 * `Sidecar.request`. This file starts a stub engine that speaks the sidecar's line JSON, and drives
 * the shipping request path instead: an unbounded deadline waits for the answer, an ordinary one
 * still fires, and cancellation and process death each settle a pending request.
 *
 * No browser, no engine, no model calls: the "engine" is a Node script in a temporary directory.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Sidecar, TIMER_MAX_MS } from '../lib/sidecar.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const passed = []
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  passed.push(message)
}

/**
 * A stub engine: one JSON object per line in, one per line out.
 *
 * `params.after_ms` delays the answer, so a test can prove a request waited for it; `params.exit`
 * makes the process die without answering, so the exit path can be exercised; `params.ignore`
 * leaves the request pending. `shutdown` answers and exits, like the real sidecar.
 */
const STUB_ENGINE = `#!/usr/bin/env node
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  const { id, method, params = {} } = request
  if (method === 'shutdown') {
    process.stdout.write(JSON.stringify({ id, result: {} }) + '\\n', () => process.exit(0))
    return
  }
  if (params.exit === true) {
    setTimeout(() => process.exit(0), params.after_ms ?? 0)
    return
  }
  if (params.ignore === true) return
  const answer = () => process.stdout.write(JSON.stringify({ id, result: { method, value: params.value ?? null } }) + '\\n')
  if (params.after_ms) setTimeout(answer, params.after_ms)
  else answer()
})
`

/** A temporary directory holding one executable stub engine. */
async function stubEngine() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-deadline-'))
  const command = join(directory, 'stub-engine.mjs')
  await writeFile(command, STUB_ENGINE)
  await chmod(command, 0o755)
  return { directory, command }
}

/** One sidecar process running the stub, with the interpreter resolved straight to it. */
async function sidecarFor(command) {
  const sidecar = new Sidecar({
    config: { pythonPath: command, requestTimeoutMs: 180_000 },
    label: 'deadline-check',
  })
  await sidecar.start()
  return sidecar
}

/** Run one scenario with its own stub and sidecar, and always clean both up. */
async function scenario(run) {
  const engine = await stubEngine()
  const sidecar = await sidecarFor(engine.command)
  try {
    await run(sidecar)
  } finally {
    await sidecar.stop()
    await rm(engine.directory, { recursive: true, force: true })
  }
}

async function main() {
  // 1. The clamp is Node's own limit, not a number picked to look big.
  check(TIMER_MAX_MS === 2 ** 31 - 1, 'the clamp is the largest delay a 32-bit timer can hold')

  // 2. The bug: a goal deadline is effectively "no deadline", so the request must wait for the
  //    engine's answer instead of rejecting on the next tick. This is the check that fails on the
  //    unfixed tree — the request rejects in 1-2 ms with the goal-timeout message there.
  await scenario(async sidecar => {
    const started = Date.now()
    const result = await sidecar.request('goal', { after_ms: 250, value: 'done' }, undefined, Number.MAX_SAFE_INTEGER)
    const elapsed = Date.now() - started
    check(result.value === 'done', 'an unbounded deadline resolves with the engine answer')
    check(elapsed >= 150, `the unbounded deadline waited for the answer (${elapsed}ms)`)
  })

  // 3. An ordinary deadline keeps its meaning under the same clamp.
  await scenario(async sidecar => {
    const started = Date.now()
    let failed
    try {
      await sidecar.request('slow', { after_ms: 500 }, undefined, 80)
    } catch (error) {
      failed = error
    }
    const elapsed = Date.now() - started
    check(failed instanceof Error && /did not answer within 80ms/u.test(failed.message),
      'an ordinary deadline still fires with its own duration')
    check(elapsed >= 50 && elapsed < 1000, `the ordinary deadline fired on time (${elapsed}ms)`)
  })

  // 4. The caller's cancellation settles a request that is waiting on the sidecar.
  await scenario(async sidecar => {
    const controller = new AbortController()
    const pending = sidecar.request('slow', { after_ms: 500 }, controller.signal, Number.MAX_SAFE_INTEGER)
    setTimeout(() => controller.abort(), 100)
    let failed
    try {
      await pending
    } catch (error) {
      failed = error
    }
    check(failed?.kind === 'cancelled', 'aborting the caller settles the request as cancelled')
  })

  // 5. The sidecar dying settles it too, rather than leaving the request to its deadline.
  await scenario(async sidecar => {
    let failed
    try {
      await sidecar.request('slow', { exit: true, after_ms: 60 }, undefined, Number.MAX_SAFE_INTEGER)
    } catch (error) {
      failed = error
    }
    check(failed instanceof Error && /sidecar exited/u.test(failed.message),
      'the sidecar exiting settles the request')
  })

  console.log(`PASS: ${passed.length} deadline checks through Sidecar.request; no browser, no engine, no model calls`)
}

await main()
