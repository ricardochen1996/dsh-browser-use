/**
 * The live progress feed, adversarially: what a conversation hears while its browser subagent works.
 *
 * Run with `node test/progress.mjs`.
 *
 * Two halves. The first drives `lib/progress.js` directly, with its own tiny fake ctx and a
 * controllable clock, because the cases that decide the design — a step inside the window, a page
 * that did not change, a child that is gone, a delivery that is refused — are exact boundaries a
 * live page reaches only by accident. The second half drives the real plugin with a fake host and a
 * real browser, and reads the messages the conversation actually received.
 *
 * This file is the adversary of the contract, not a second implementation of it: every claim is
 * paired with a case that could falsify it, and every case is enforced — the two probes that once
 * found real defects (a window past the setTimeout range, a step listener whose logger also throws)
 * are ordinary checks now that the fixes have landed. Two behaviours are accepted by design rather
 * than falsified: the no-page line is reachable only through a window that closes after the browser
 * is gone (checked directly and end to end below), and `<duration> into the task` counts from the
 * child's first recorded step, which is what the docs promise.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = resolve(
  process.env.DSH_BROWSER_USE_PROJECT || process.env.JEV_ULTRAFAST_PROJECT || join(PACKAGE_ROOT, '..', 'jev-ultrafast'),
)
if (!existsSync(join(ENGINE, 'jev_ultrafast', '__init__.py'))) {
  throw new Error(`Set DSH_BROWSER_USE_PROJECT to the engine checkout: no jev_ultrafast package under ${ENGINE}`)
}
const FIXTURE = pathToFileURL(join(ENGINE, 'jev_ultrafast', 'static', 'fixture.html')).href

const passed = []
/** A claim that must hold: a falsified one stops the run, like every other test in this repo. */
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  passed.push(message)
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
/** Progress goes to stderr as it happens: a stall names its own phase. */
const phase = message => process.stderr.write(`  … ${message}\n`)

/** The real clock, and a fake one the boundary checks can name to the millisecond. */
const realNow = Date.now.bind(Date)
let fakeNow = 1_700_000_000_000
let clockFrozen = false
Date.now = () => (clockFrozen ? fakeNow : realNow())
const at = ms => { clockFrozen = true; fakeNow = ms }
const advance = ms => { fakeNow += ms }
const realTime = () => { clockFrozen = false }

const progressModule = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'progress.js')).href)
const { PROGRESS_DEFAULT_MS, PROGRESS_MIN_MS, ProgressFeed } = progressModule
const configModule = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'config.js')).href)
const { Sessions } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'sessions.js')).href)

/** A page as `Sessions.viewOf` hands it to the feed. */
const pageView = (over = {}) => ({
  url: 'https://example.test/page', title: 'Example', observation: 1, lastAction: 'CLICK on Go', ...over,
})

/**
 * One feed with the smallest context it accepts: an agent registry, a `subagents` service, a logger,
 * and a session view the test owns. `sendMessage` is the only part a case usually replaces.
 */
function makeWorld({
  config = { progress: true, progressIntervalMs: 0 },
  view = pageView(), child = 'child-1', live = true, ownerId = 'session-owner', sendMessage,
} = {}) {
  const world = {
    pushes: [], warnings: [], calls: 0, started: false, aborted: false,
    child: child === null ? undefined : child,
    owner: { id: ownerId },
    view: view === null ? undefined : view,
    config,
    agents: new Map(),
  }
  if (live) world.agents.set(child, { id: child })
  const subagents = {
    sendMessage: async (childAgent, targetId, content, settings) => {
      world.calls += 1
      if (sendMessage !== undefined) return sendMessage(world, childAgent, targetId, content, settings)
      settings?.signal?.throwIfAborted?.()
      world.pushes.push({ child: childAgent, targetId, content, settings, text: content.map(block => block.text).join('\n') })
    },
  }
  const ctx = {
    get: name => (name === 'agents'
      ? { get: id => world.agents.get(id) }
      : name === 'subagents' ? subagents : undefined),
    logger: { warn: message => world.warnings.push(String(message)) },
  }
  world.feed = new ProgressFeed(ctx, {
    config: world.config,
    sessions: { viewOf: () => world.view },
    childOf: () => world.child,
  })
  return world
}

const twoLines = (childId, page, elapsed = '0s') => [
  `Browser subagent "${childId}" progress — ${elapsed} into the task (status only; no reply needed).`,
  page,
].join('\n')

/** The contract surface: the exports, the Config fields, and the validation `apply` relies on. */
async function contractSurface() {
  phase('contract surface: exports, defaults, validation')
  check(PROGRESS_DEFAULT_MS === 30_000, 'PROGRESS_DEFAULT_MS is 30 s')
  check(PROGRESS_MIN_MS === 1_000, 'PROGRESS_MIN_MS is 1 s')
  check(typeof ProgressFeed === 'function', 'ProgressFeed is exported as a class')
  check(new ProgressFeed(undefined, undefined) instanceof ProgressFeed,
    'a feed built with no context at all still constructs (step/end/release must not throw on an empty composition)')

  check(configModule.DEFAULTS.progress === true, 'the documented default is progress on')
  check(configModule.DEFAULTS.progressIntervalMs === 30000, 'the documented default window is 30 s')
  check(configModule.resolveConfig({}).progress === true && configModule.resolveConfig({}).progressIntervalMs === 30000,
    'a configuration that names neither field resolves to the documented defaults')
  check(configModule.resolveConfig({ progress: false }).progress === false, 'a profile patch can turn the stream off')
  check(configModule.resolveConfig({ progressIntervalMs: 0 }).progressIntervalMs === 0,
    'zero is accepted: the floor is applied at use time, not at validation')

  const refusal = value => {
    try { configModule.resolveConfig({ progressIntervalMs: value }); return '' } catch (error) { return String(error?.message ?? error) }
  }
  check(refusal(-1) === 'dsh-browser-use: progressIntervalMs must be zero or a positive number',
    'a negative interval is refused with the documented message')
  check(refusal(Number.POSITIVE_INFINITY) !== '' && refusal(Number.NaN) !== '',
    'a non-finite interval is refused rather than silently used as a window')

  const progressRefusal = value => {
    try { configModule.resolveConfig({ progress: value }); return '' } catch (error) { return String(error?.message ?? error) }
  }
  check(progressRefusal(1) === 'dsh-browser-use: progress must be true or false'
    && progressRefusal('yes') === 'dsh-browser-use: progress must be true or false',
  'a truthy non-boolean progress is refused, instead of turning the stream off in silence')

  // The README says the two fields have no form field. A form field is what `.volatile()` means here.
  const schema = configModule.Config({})
  check(configModule.isVolatile(schema.progress) === false && configModule.isVolatile(schema.progressIntervalMs) === false,
    'neither progress nor progressIntervalMs is a live form field, as the README says')
  check(configModule.isVolatile(schema.jev.decider) === true, 'the control holds: a form field really is volatile')
}

/** The feed itself, on cases a browser reaches only by accident. */
async function feedUnit() {
  at(1_700_000_000_000)
  phase('feed: the first step, and the exact text it pushes')
  const first = makeWorld()
  first.feed.step(first.owner)
  check(first.pushes.length === 1, 'the first step of a child pushes at once')
  check(first.pushes[0].text === twoLines('child-1', 'Page: Example — https://example.test/page (observation 1, last action: CLICK on Go).'),
    'the push is exactly the two documented lines, with the duration and the page it describes')
  check(first.pushes[0].child === first.agents.get('child-1') && first.pushes[0].targetId === 'session-owner',
    'the push goes from the live child agent to the conversation that owns it')
  check(JSON.stringify(first.pushes[0].content) === JSON.stringify([{ type: 'text', text: first.pushes[0].text }]),
    'the content is one text block carrying that same text')
  check(first.pushes[0].settings.signal instanceof AbortSignal,
    'the push carries the AbortSignal that release() can cancel')

  phase('feed: coalescing, and the state a window edge reports')
  const coalesced = makeWorld()
  coalesced.feed.step(coalesced.owner)
  check(coalesced.pushes.length === 1, 'a step that opens the window reports at once')
  advance(10)
  coalesced.view = pageView({ observation: 2, lastAction: 'TYPE_TEXT on searchbox' })
  coalesced.feed.step(coalesced.owner)
  check(coalesced.pushes.length === 1, 'a changed step inside the window pushes nothing by itself')
  advance(10)
  coalesced.view = pageView({ observation: 3, lastAction: 'SELECT on country' })
  coalesced.feed.step(coalesced.owner)
  check(coalesced.pushes.length === 1, 'a second changed step inside the window arms no second timer')
  await wait(PROGRESS_MIN_MS + 250)
  check(coalesced.pushes.length === 2, 'the window edge pushes exactly one coalesced report')
  check(coalesced.pushes[1].text.includes('(observation 3, last action: SELECT on country)'),
    'the coalesced report carries the state at the edge, not the state that armed the window')
  coalesced.view = pageView({ observation: 4, lastAction: 'SELECT on country' })
  coalesced.feed.step(coalesced.owner)
  check(coalesced.pushes.length === 2, 'a step right after the flush is inside the new window and pushes nothing')
  advance(999)
  coalesced.view = pageView({ observation: 5 })
  coalesced.feed.step(coalesced.owner)
  check(coalesced.pushes.length === 2, 'one millisecond before the new edge still pushes nothing')
  coalesced.feed.end('child-1')
  await wait(25)
  check(coalesced.pushes.length === 2, 'the report that was armed for that edge was cancelled, not merely delayed')
  advance(1)
  coalesced.view = pageView({ observation: 6 })
  coalesced.feed.step(coalesced.owner)
  check(coalesced.pushes.length === 3, 'a step exactly at the window edge pushes at once')

  phase('feed: what a page that changed nothing does')
  const unchanged = makeWorld()
  unchanged.feed.step(unchanged.owner)
  unchanged.feed.step(unchanged.owner)
  check(unchanged.pushes.length === 1, 'a step whose signature did not change pushes nothing, before or after the window')

  const durationText = makeWorld()
  durationText.feed.step(durationText.owner)
  advance(65_000)
  durationText.view = pageView({ observation: 7 })
  durationText.feed.step(durationText.owner)
  check(durationText.pushes[1].text.startsWith('Browser subagent "child-1" progress — 1m 5s into the task'),
    'the duration counts from this child\'s first recorded step, which is the documented behaviour')
  check(durationText.pushes[1].text.includes('(observation 7, last action: CLICK on Go)'),
    'a step a full window later pushes again')

  const untitled = makeWorld({ view: pageView({ title: '' }) })
  untitled.feed.step(untitled.owner)
  check(untitled.pushes[0].text.endsWith('\nPage: https://example.test/page (observation 1, last action: CLICK on Go).'),
    'a page with no title drops the " — " separator, as both READMEs say')

  phase('feed: a page that was never read')
  const noPage = makeWorld({ view: null })
  noPage.feed.step(noPage.owner)
  check(noPage.pushes.length === 1
    && noPage.pushes[0].text === twoLines('child-1', 'It has not read a page yet.'),
  'a child with no page pushes exactly the documented second line')
  noPage.feed.step(noPage.owner)
  check(noPage.pushes.length === 1, 'and still nothing once that same no-page state is reported')

  // Accepted as reachable, not as dead code: `Sessions.close()` drops the recorded page, so the
  // report a window had already armed ends up describing a browser that has read nothing.
  const closedPage = makeWorld()
  closedPage.feed.step(closedPage.owner)
  advance(5)
  closedPage.view = pageView({ observation: 2 })
  closedPage.feed.step(closedPage.owner)
  closedPage.view = undefined
  await wait(PROGRESS_MIN_MS + 250)
  check(closedPage.pushes.length === 2 && closedPage.pushes[1].text === twoLines('child-1', 'It has not read a page yet.'),
    'a window that closes after the page was cleared reports the documented no-page line')

  phase('feed: the drop rules, each armed and then judged after one window')
  const off = makeWorld({ config: { progress: false } })
  off.feed.step(off.owner)
  const offLate = makeWorld()
  offLate.feed.step(offLate.owner)
  advance(5)
  offLate.view = pageView({ observation: 2 })
  offLate.feed.step(offLate.owner)
  offLate.config.progress = false
  const absent = makeWorld({ child: null })
  absent.feed.step(absent.owner)
  const empty = makeWorld({ child: '' })
  empty.feed.step(empty.owner)
  const dead = makeWorld({ live: false })
  dead.feed.step(dead.owner)
  const vanished = makeWorld()
  vanished.feed.step(vanished.owner)
  advance(5)
  vanished.view = pageView({ observation: 2 })
  vanished.feed.step(vanished.owner)
  vanished.agents.delete('child-1')
  const ended = makeWorld()
  ended.feed.step(ended.owner)
  advance(5)
  ended.view = pageView({ observation: 2 })
  ended.feed.step(ended.owner)
  ended.feed.end('child-1')
  const released = makeWorld()
  released.feed.step(released.owner)
  advance(5)
  released.view = pageView({ observation: 2 })
  released.feed.step(released.owner)
  released.feed.release()
  const afterRelease = makeWorld()
  afterRelease.feed.release()
  afterRelease.feed.step(afterRelease.owner)
  const reverted = makeWorld()
  reverted.feed.step(reverted.owner)
  advance(5)
  reverted.view = pageView({ observation: 2 })
  reverted.feed.step(reverted.owner)
  advance(1)
  reverted.view = pageView()
  reverted.feed.step(reverted.owner)
  await wait(PROGRESS_MIN_MS + 250)
  check(off.pushes.length === 0, 'progress: false never pushes')
  check(offLate.pushes.length === 1, 'turning progress off inside a window cancels the report that window had pending')
  check(absent.pushes.length === 0, 'a conversation with no browser child never pushes')
  check(empty.pushes.length === 0, 'an empty child id is treated as no child at all')
  check(dead.pushes.length === 0, 'a child the agent registry no longer holds never pushes')
  check(vanished.pushes.length === 1, 'a report armed for a child that is gone by the time the window ends is dropped')
  check(ended.pushes.length === 1, 'end() cancels the report a child had pending')
  check(released.pushes.length === 1, 'release() cancels the report a child had pending')
  check(afterRelease.pushes.length === 0, 'a released feed pushes nothing, not even from a later step')
  check(reverted.pushes.length === 1,
    'a window that closes on the signature that was already pushed says nothing, even after a change and a change back')

  phase('feed: a delivery that fails cannot reach the tool or the process')
  const rejections = []
  const onRejection = reason => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  const refusal = makeWorld({ sendMessage: async () => { throw new Error('relay refused') } })
  const syncRefusal = makeWorld({ sendMessage: () => { throw new Error('relay refused synchronously') } })
  const rejectedPromise = makeWorld({ sendMessage: () => Promise.reject(new Error('relay refused as a promise')) })
  const escapes = []
  for (const [name, world] of [['async', refusal], ['sync', syncRefusal], ['rejected promise', rejectedPromise]]) {
    try { world.feed.step(world.owner) } catch (error) { escapes.push(`${name}: ${error}`) }
  }
  await wait(100)
  process.off('unhandledRejection', onRejection)
  check(escapes.length === 0, 'a refused, synchronously throwing or rejecting push never escapes step()')
  check(rejections.length === 0, 'and none of the three becomes an unhandled rejection')
  check(refusal.warnings.some(message => message.includes('was not delivered'))
    && syncRefusal.warnings.some(message => message.includes('was not delivered'))
    && rejectedPromise.warnings.some(message => message.includes('was not delivered')),
  'each refusal is reported through the logger instead')

  phase('feed: step() does not wait for the push it starts')
  const pending = makeWorld({
    sendMessage: (world, _child, _target, _content, settings) => {
      world.started = true
      return new Promise(resolve => settings.signal.addEventListener('abort', () => { world.aborted = true; resolve('aborted') }))
    },
  })
  const returned = pending.feed.step(pending.owner)
  check(returned === undefined && pending.started === true,
    'step() returns undefined while the push it started is still unsettled')
  check(pending.aborted === false, 'the unsettled push is still in flight')
  pending.feed.release()
  check(pending.aborted === true, 'release() aborts a push that is still in flight')
}

/** The window: the floor, the configured default, and the exact edge on both sides. */
async function boundaries() {
  at(1_800_000_000_000)
  phase('boundary: the interval floor')
  const floorZero = makeWorld({ config: { progress: true, progressIntervalMs: 0 } })
  floorZero.feed.step(floorZero.owner)
  advance(999)
  floorZero.view = pageView({ observation: 2 })
  floorZero.feed.step(floorZero.owner)
  check(floorZero.pushes.length === 1, 'with the interval set to 0, a step 999 ms later is still inside the window')
  floorZero.feed.end('child-1')
  await wait(25)
  check(floorZero.pushes.length === 1, 'and the report armed for that edge was cancelled')
  advance(1)
  floorZero.view = pageView({ observation: 3 })
  floorZero.feed.step(floorZero.owner)
  check(floorZero.pushes.length === 2, 'at 1000 ms the floored window closes and the step pushes at once')

  const floorHalf = makeWorld({ config: { progress: true, progressIntervalMs: 500 } })
  floorHalf.feed.step(floorHalf.owner)
  advance(999)
  floorHalf.view = pageView({ observation: 2 })
  floorHalf.feed.step(floorHalf.owner)
  check(floorHalf.pushes.length === 1, 'a configured 500 ms behaves as the 1000 ms floor, not as 500 ms')
  floorHalf.feed.end('child-1')
  await wait(25)
  advance(1)
  floorHalf.view = pageView({ observation: 3 })
  floorHalf.feed.step(floorHalf.owner)
  check(floorHalf.pushes.length === 2, 'and it opens again exactly one second after the push')

  phase('boundary: an interval above the floor is the window')
  const configured = makeWorld({ config: { progress: true, progressIntervalMs: 2500 } })
  configured.feed.step(configured.owner)
  advance(2499)
  configured.view = pageView({ observation: 2 })
  configured.feed.step(configured.owner)
  check(configured.pushes.length === 1, 'a configured 2500 ms window is still open at 2499 ms')
  configured.feed.end('child-1')
  await wait(25)
  advance(1)
  configured.view = pageView({ observation: 3 })
  configured.feed.step(configured.owner)
  check(configured.pushes.length === 2, 'and closes at exactly 2500 ms')

  phase('boundary: the default window is 30 s, not the floor')
  const byDefault = makeWorld({ config: { progress: true } }) // no interval named: what a default profile has
  byDefault.feed.step(byDefault.owner)
  advance(15_000)
  byDefault.view = pageView({ observation: 2 })
  byDefault.feed.step(byDefault.owner)
  check(byDefault.pushes.length === 1, 'a configuration that names no interval coalesces into 30 s, not into 1 s')
  await wait(1200)
  check(byDefault.pushes.length === 1, 'and nothing has been pushed a second later')
  byDefault.feed.release()

  const notANumber = makeWorld({ config: { progress: true, progressIntervalMs: Number.NaN } })
  notANumber.feed.step(notANumber.owner)
  advance(1500)
  notANumber.view = pageView({ observation: 2 })
  notANumber.feed.step(notANumber.owner)
  check(notANumber.pushes.length === 1, 'a non-finite interval falls back to the 30 s default, not to the floor')
  notANumber.feed.release()

  // An interval past what a timer can carry is held inside the range (the fix for the probe that
  // once found the opposite): a window of weeks is one long window, never a 1 ms flush.
  phase('boundary: an interval past the 32-bit timer range is held inside it')
  const overflowWarnings = []
  const captureWarning = warning => overflowWarnings.push(warning)
  process.on('warning', captureWarning)
  const overflow = makeWorld({ config: { progress: true, progressIntervalMs: 3_000_000_000 } })
  overflow.feed.step(overflow.owner)
  check(overflow.pushes.length === 1, 'an over-range window still reports the first step at once')
  overflow.view = pageView({ observation: 2 })
  overflow.feed.step(overflow.owner)
  await wait(60)
  check(overflow.pushes.length === 1,
    'a changed step inside it pushes nothing: the window is clamped to the timer range, not to the 1 ms a clamped timer would give')
  check(!overflowWarnings.some(warning => warning.name === 'TimeoutOverflowWarning'),
    'and no over-range delay is ever armed, so Node never warns and no flush lands next to the push')
  overflow.feed.release()

  const clampedEdge = makeWorld({ config: { progress: true, progressIntervalMs: 3_000_000_000 } })
  clampedEdge.feed.step(clampedEdge.owner)
  advance(2 ** 31 - 1)
  clampedEdge.view = pageView({ observation: 2 })
  clampedEdge.feed.step(clampedEdge.owner)
  check(clampedEdge.pushes.length === 2, 'the clamped window is one long window: it opens exactly at 2**31-1 ms')
  process.off('warning', captureWarning)
}

/** `Sessions.onStep`: the wiring the feed hangs off, and the promise that it cannot break a tool. */
async function sessionSteps() {
  phase('sessions.onStep: the listener contract')
  const warnings = []
  const sessions = new Sessions({ get: () => undefined, logger: { warn: message => warnings.push(String(message)) } }, {})
  const entry = { owner: { id: 'session-1' }, observation: 0, fingerprints: new Map(), last: null, lastAction: '', updatedAt: 0 }
  const seen = []
  const second = []
  const off = sessions.onStep(owner => { seen.push(owner.id); throw new Error('listener exploded') })
  const offSecond = sessions.onStep(owner => second.push(owner.id))
  check(typeof off === 'function' && typeof offSecond === 'function', 'onStep returns a disposer')

  let escaped = ''
  try {
    sessions.observed(entry, { fingerprint: 'fp-1' })
    sessions.noteAction(entry, 'CLICK on Go')
  } catch (error) { escaped = String(error?.message ?? error) }
  check(escaped === '', 'a throwing listener does not break observed() or noteAction()')
  check(JSON.stringify(seen) === '["session-1","session-1"]',
    'the listener fires once per recorded step, with the Agent that owns the browser')
  check(JSON.stringify(second) === '["session-1","session-1"]', 'a throwing listener does not stop the next one')
  check(warnings.length === 2 && warnings.every(message => message.includes('a browser step listener failed')),
    'each throw is reported through the logger')

  off()
  offSecond()
  sessions.observed(entry, { fingerprint: 'fp-2' })
  check(seen.length === 2 && second.length === 2, 'the disposer stops only its own listener')
  check(entry.observation === 2 && entry.lastAction === 'CLICK on Go', 'observed() still returns the observation the tool needs')

  // The fix for the second probe that once found a defect: the guard now survives its own logger.
  phase('sessions.onStep: the listener guard when the logger fails too')
  const brittle = new Sessions({
    get: () => undefined,
    logger: { warn: () => { throw new Error('logger exploded') } },
  }, {})
  brittle.onStep(() => { throw new Error('listener exploded') })
  let broke = ''
  try {
    brittle.observed(entry, { fingerprint: 'fp-3' })
    brittle.noteAction(entry, 'CLICK on Go')
  } catch (error) { broke = String(error?.message ?? error) }
  check(broke === '' && entry.observation === 3,
    'a throwing listener cannot break a browser tool even when the logger fails: both steps are still recorded')

  phase('sessions.close: the view a closed browser leaves behind')
  const owner = { id: 'session-1' }
  owner.ctx = { effect: () => () => {} }
  const live = new Map([[owner.id, owner]])
  const closing = new Sessions({
    get: name => (name === 'agents' ? { get: id => live.get(id) } : undefined),
    logger: { warn: () => {} },
  }, {})
  const owned = closing.entry(owner)
  closing.observed(owned, { fingerprint: 'fp-close' })
  check(closing.viewOf(owner) !== undefined, 'a Session with a recorded page has a view for the feed to describe')
  await closing.close(owned)
  check(closing.viewOf(owner) === undefined,
    'browser_close clears the recorded page, so a report whose window closes after it has no view left')
}

/**
 * The part of Cordis this plugin drives, with one scope per Agent: just enough for the plugin to
 * apply, delegate one task, and hand the child a real browser — the same path test/delegation.mjs
 * drives, written here so this file stands alone.
 */
function fakeHost() {
  const globals = new Map()
  const scopes = new Map()
  const listeners = new Map()
  const agents = new Map()
  const warnings = []
  const effects = []
  /** Every message the child sent to its parent, as the host sees it. */
  const deliveries = []
  /** The continuable children this host composed, in creation order. */
  const children = []

  const effect = callback => {
    const result = callback()
    let dispose
    if (result !== undefined && typeof result.next === 'function') {
      const disposers = []
      let current = result
      while (current.done !== true) {
        if (typeof current.value === 'function') disposers.push(current.value)
        current = result.next()
      }
      dispose = async () => { for (const item of disposers.reverse()) await item() }
    } else {
      dispose = async () => { await (typeof result === 'function' ? result() : undefined) }
    }
    effects.push(dispose)
    return dispose
  }
  const emit = async (event, payload) => {
    for (const handler of listeners.get(event) ?? []) await handler(payload)
  }
  const makeAgent = (id, header) => {
    if (!scopes.has(id)) scopes.set(id, new Map())
    const agent = { id, session: { header } }
    agent.ctx = {
      tools: {
        register: definition => {
          scopes.get(id).set(definition.name, definition)
          return () => scopes.get(id).delete(definition.name)
        },
        restrict: () => () => {},
      },
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      effect,
    }
    agents.set(id, agent)
    return agent
  }

  const provider = {
    name: 'spawn',
    capabilities: { toolFilter: true },
    inheritsParentContext: false,
    prepareContinuable: async () => ({}),
  }
  const subagents = {
    getProvider: name => (name === 'spawn' ? provider : undefined),
    startContinuable: async spec => {
      spec.signal.throwIfAborted()
      const id = `child-${children.length + 1}`
      const record = {
        id,
        parentId: spec.request.parent.id,
        messages: [spec.request.prompt],
        toolFilter: spec.request.toolFilter,
        child: makeAgent(id, { parentSession: spec.request.parent.id, origin: 'subagent', isSeeded: false }),
      }
      children.push(record)
      await emit('agent/created', { agent: record.child, source: 'startup' })
      await emit('subagent/start', { runId: `run-${id}`, provider: 'spawn', id, local: true })
      return { childId: id, messageId: `m-${id}-1` }
    },
    // A resident child writing to its parent: the exact path the progress feed pushes through, and
    // the one DSH only accepts from the live child of that parent.
    sendMessage: async (sender, targetId, content, settings) => {
      settings.signal.throwIfAborted()
      const self = children.find(item => item.id === sender.id)
      if (self === undefined || agents.get(sender.id) !== sender) {
        throw Object.assign(new Error(`"${sender.id}" is not the live agent`), { code: 'UNAUTHORIZED' })
      }
      if (self.parentId !== targetId) {
        throw Object.assign(new Error(`"${targetId}" is not the parent of "${sender.id}"`), { code: 'UNAUTHORIZED' })
      }
      const text = content.map(block => block.text).join('\n')
      deliveries.push({ from: sender.id, to: targetId, content, text })
      return `m-${self.id}-to-parent-${deliveries.length}`
    },
    listChildren: async parentId => children
      .filter(item => item.parentId === parentId)
      .map(item => ({ id: item.id, mode: 'continuable', label: 'browser-task', createdAt: Date.now() })),
    interrupt: () => {},
  }

  const ctx = {
    tools: {
      register: definition => { globals.set(definition.name, definition); return () => globals.delete(definition.name) },
      get: name => globals.get(name),
      schemas: () => [...globals.values()],
    },
    agents: { get: id => agents.get(id) },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    logger: { info: () => {}, warn: message => warnings.push(String(message)) },
    get: name => (name === 'agents' ? ctx.agents : name === 'subagents' ? subagents : undefined),
    effect,
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== handler))
    },
  }
  // The base bundle's subagent-control tools, which a persistent child needs to talk back.
  for (const name of ['send_message', 'interrupt_agent']) globals.set(name, { name, external: true })
  const conversation = makeAgent('session-conversation', { isSeeded: false })
  const dispose = async () => { for (const item of effects.reverse()) await item() }
  return { ctx, conversation, globals, scopes, warnings, deliveries, children, dispose }
}

/** Call one browser tool in a delegated child, the way the child's own Agent would. */
const childCall = (host, record, name, args) => host.scopes.get(record.id).get(name).execute(args ?? {}, {
  agent: record.child, signal: new AbortController().signal,
})

/** The plugin's own path: a real delegation, a real browser step, and what the conversation received. */
async function integration(plugin) {
  phase('integration: the plugin delegates, the child steps, the conversation hears it')
  const profile = await mkdtemp(join(tmpdir(), 'browser-use-progress-'))
  const host = fakeHost()
  // The shortest window a profile may ask for: a coalescing check costs a second, not a minute.
  plugin.apply(host.ctx, {
    projectPath: ENGINE, userDataDir: join(profile, 'browser'), headless: true, progressIntervalMs: 0,
  })
  const ask = (args, signal = new AbortController().signal) =>
    host.globals.get('browser_task').execute(args, { agent: host.conversation, signal })
  const call = (record, name, args) => childCall(host, record, name, args)

  try {
    check(typeof host.globals.get('browser_task')?.execute === 'function',
      'the plugin delegates, so the progress feed has the persistent child it pushes for')
    await ask({ instruction: 'Open the fixture and type Lisbon into Destination.', url: FIXTURE })
    check(host.children.length === 1, 'the task started one continuable browser child')
    const record = host.children[0]
    check(Array.isArray(record.toolFilter?.allow) && record.toolFilter.allow.includes('send_message'),
      'the child is granted send_message, which is the channel a progress push uses')

    const opened = await call(record, 'browser_open', { url: FIXTURE })
    await wait(50)
    check(host.deliveries.length === 1, 'the first real browser step pushed exactly one message')
    const delivered = host.deliveries[0]
    check(delivered.from === record.id && delivered.to === host.conversation.id,
      'the message went from the browser child to the conversation that owns it')
    check(delivered.content.length === 1 && delivered.content[0].type === 'text',
      'the message is one text block, like every other helper message')
    check(new RegExp(
      `^Browser subagent "${record.id}" progress — \\d+s into the task \\(status only; no reply needed\\)\\.\n`
      + 'Page: .+ — \\S+ \\(observation 1\\)\\.$',
      'u',
    ).test(delivered.text), 'the real push has the documented shape, and names the observation the child read')

    const target = opened.text.match(/\[(\d+)\][^\n]*searchbox Destination/u)?.[1]
    check(target !== undefined, 'the child read an indexed action space from the real browser')
    const second = await call(record, 'browser_act', {
      observation: opened.observation, operation: 'TYPE_TEXT', target, text: 'Lisbon',
    })
    await wait(50)
    check(host.deliveries.length === 1, 'a real step inside the window is coalesced, not pushed again')
    await wait(PROGRESS_MIN_MS + 250)
    check(host.deliveries.length === 2, 'the real window edge pushed exactly one report')
    check(host.deliveries[1].text.includes(`(observation ${second.observation}, last action: TYPE_TEXT`)
      && host.deliveries[1].text.startsWith(`Browser subagent "${record.id}" progress`),
    'and that report names the page, the observation and the action the child took there')

    // A browser call that records no step is not a step: the contract names observed()/noteAction().
    await call(record, 'browser_console', {})
    await wait(50)
    check(host.deliveries.length === 2, 'a browser call that records no step does not push')

    check(host.warnings.length === 0, 'the feed logged no warning while it pushed real progress')

    // The strongest check on the documented message shape is what a conversation actually received,
    // read together with the example both READMEs now draw for a first push.
    const readmes = await Promise.all(
      ['README.md', 'README.zh-CN.md'].map(name => readFile(join(PACKAGE_ROOT, name), 'utf8')),
    )
    check(readmes.every(text => text.includes('Page: <title> — <url> (observation 1).')),
      'both READMEs draw a first push exactly as the plugin sends it, with no last-action clause yet')
    check(readmes.every(text => text.includes(', last action: <action>') && text.includes('<title> — ')),
      'and both say when the last-action clause and the title join in')
    check(/^Page: .+ — \S+ \(observation 1\)\.$/u.test(delivered.text.split('\n')[1]),
      'the message a real conversation received is the documented first-push line')
  } finally {
    // Unloading the plugin closes the Session browser, and a pending feed timer must not outlive it.
    await host.dispose()
    await wait(1500)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The no-page line, end to end: `browser_close` clears the Session's recorded page, so a report
 * whose window was armed before the close describes a browser that has read nothing.
 *
 * The window is the documented default 30 s on purpose, and this is the slowest phase of the file:
 * closing a browser waits up to 10 s for it to exit (sidecar/bridge.py) plus daemon teardown, so a
 * shorter window would end before the page is gone and prove the opposite case instead.
 */
async function integrationAfterClose(plugin) {
  phase('integration: browser_close inside a window leaves the report with no page')
  const WINDOW = PROGRESS_DEFAULT_MS
  const profile = await mkdtemp(join(tmpdir(), 'browser-use-progress-closed-'))
  const host = fakeHost()
  plugin.apply(host.ctx, {
    projectPath: ENGINE, userDataDir: join(profile, 'browser'), headless: true, progressIntervalMs: WINDOW,
  })
  const ask = (args, signal = new AbortController().signal) =>
    host.globals.get('browser_task').execute(args, { agent: host.conversation, signal })

  try {
    await ask({ instruction: 'Open the fixture, then stop the browser.', url: FIXTURE })
    const record = host.children[0]
    await childCall(host, record, 'browser_open', { url: FIXTURE })
    await wait(50)
    check(host.deliveries.length === 1, 'the open pushed the page it read')
    const armedAt = Date.now()
    await childCall(host, record, 'browser_page', {})
    const closed = await childCall(host, record, 'browser_close', {})
    const closeCost = Date.now() - armedAt
    check(closed.text.includes('stopped'), 'the child stopped its browser with the report still armed')
    check(closeCost < WINDOW - 5000,
      `the close took ${closeCost} ms of the ${WINDOW} ms window, so the edge that follows is its report`)
    await wait(WINDOW - closeCost + 300)
    check(host.deliveries.length === 2, 'the window that closed after browser_close still reported once')
    check(host.deliveries[1].text.endsWith('\nIt has not read a page yet.'),
      'and it reported the documented no-page line, because the closed Session has no recorded page left')
  } finally {
    await host.dispose()
    await wait(1500)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

async function main() {
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  await contractSurface()
  await feedUnit()
  await boundaries()
  await sessionSteps()
  realTime()
  await integration(plugin)
  await integrationAfterClose(plugin)

  console.log(passed.join('\n'))
  console.log(`PASS: ${passed.length} progress checks; no open findings; real browser, no model calls`)
}

await main()
