/**
 * The sidecar request deadline, against the one failure that made every `browser_goal` run fail.
 *
 * Run with `node test/deadline.mjs`.
 *
 * Node keeps a `setTimeout` delay in a 32-bit signed integer and silently shortens anything larger
 * to 1 ms. `browser_goal` asks for `Number.MAX_SAFE_INTEGER` because a run has no fixed budget, so
 * the deadline fired on the very next tick and every goal reported
 * "did not answer within 9007199254740991ms" almost instantly — a message that reads like a timeout
 * but is really an overflow.
 *
 * `progress.js` had already met the same trap in its coalescing window, and clamps there. This file
 * holds the request deadline to the same rule. It checks the rule the shipping code applies, and it
 * checks it the way the bug was found: by asking whether an oversized deadline still behaves like an
 * unreachable one when Node is actually given it.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const passed = []
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  passed.push(message)
}

async function main() {
  const { TIMER_MAX_MS } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'sidecar.js')).href)

  // 1. The clamp is Node's own limit, not a number picked to look big.
  check(TIMER_MAX_MS === 2 ** 31 - 1, 'the clamp is the largest delay a 32-bit timer can hold')

  // 2. The premise: an unclamped oversized delay really does collapse. This is the bug, stated as a
  //    property of the runtime rather than of our code, so a Node release that fixed it would fail
  //    here and tell us the clamp is now belt-and-braces rather than load-bearing.
  {
    const started = Date.now()
    const fired = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(true), Number.MAX_SAFE_INTEGER)
      setTimeout(() => { clearTimeout(timer); resolve(false) }, 200)
    })
    check(fired, 'an unclamped Number.MAX_SAFE_INTEGER delay fires almost at once (the goal-run bug)')
    check(Date.now() - started < 500, 'that collapse is immediate, not a slow timer')
  }

  // 3. The fix: the clamped value does NOT fire, so a goal run waits for its answer.
  {
    const clamped = Math.min(Number.MAX_SAFE_INTEGER, TIMER_MAX_MS)
    const fired = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(true), clamped)
      setTimeout(() => { clearTimeout(timer); resolve(false) }, 200)
    })
    check(!fired, 'the clamped deadline is unreachable, so it never fires on the next tick')
  }

  // 4. And an ordinary deadline keeps its meaning under the same clamp.
  {
    const clamped = Math.min(40, TIMER_MAX_MS)
    check(clamped === 40, 'a normal deadline is passed through unchanged')
  }

  // 5. The request path is the one that applies the clamp: a regression that drops `Math.min` here
  //    reintroduces the instant failure, so this is the line worth pinning.
  const source = await readFile(join(PACKAGE_ROOT, 'lib', 'sidecar.js'), 'utf8')
  check(/Math\.min\(timeoutMs, TIMER_MAX_MS\)/u.test(source),
    'request() clamps its deadline with Math.min(timeoutMs, TIMER_MAX_MS)')
  check(!/setTimeout\([^)]*,\s*Number\.MAX_SAFE_INTEGER\s*\)/u.test(source),
    'no timer is handed Number.MAX_SAFE_INTEGER directly')

  // 6. The caller that exposed the bug still asks for "no budget", and is still safe because of 5.
  const tools = await readFile(join(PACKAGE_ROOT, 'lib', 'tools.js'), 'utf8')
  check(/Number\.MAX_SAFE_INTEGER/u.test(tools),
    'browser_goal still asks for an unbounded deadline, which the clamp now makes safe')

  console.log(`PASS: ${passed.length} deadline checks; no browser, no engine, no model calls`)
}

await main()
