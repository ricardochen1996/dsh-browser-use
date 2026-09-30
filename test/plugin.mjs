/**
 * The plugin half, driven without DSH: a fake Cordis context, the real engine sidecar, a real browser.
 *
 * Run with `node test/plugin.mjs`. It checks what the model would read in each tool result, so a
 * broken table, a missing operation, or a silent refusal fails here. The engine checkout is found
 * through `DSH_BROWSER_USE_PROJECT` / `JEV_ULTRAFAST_PROJECT`, or beside this package.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  passed.push(message)
}

/** The target index the rendered table offers for one labelled element, as the model would read it. */
function targetFor(text, pattern) {
  const match = text.match(new RegExp(`\\[(\\d+)\\][^\\n]*${pattern}`, 'u'))
  if (!match) throw new Error(`no element matching ${pattern} in:\n${text}`)
  return match[1]
}

/** The observed option target for one dropdown value, as the rendered table lists it. */
function optionFor(text, pattern) {
  const match = text.match(new RegExp(`^\\s+(\\d+:\\d+) → [^\\n]*${pattern}$`, 'mu'))
  if (!match) throw new Error(`no option matching ${pattern} in:\n${text}`)
  return match[1]
}

/** The part of the Cordis context this plugin uses, with the same lifetimes. */
function fakeContext() {
  const tools = new Map()
  const disposers = []
  const agent = {
    id: 'session-plugin-check',
    ctx: { effect: callback => { disposers.push(callback()); return () => {} } },
  }
  const ctx = {
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    agents: { get: id => (id === agent.id ? agent : undefined) },
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    logger: { info: () => {}, warn: () => {} },
    get: name => (name === 'agents' ? { get: id => (id === agent.id ? agent : undefined) } : undefined),
    // No subagent provider and no events in this composition: the plugin stays in direct mode.
    on: () => () => {},
    effect: callback => {
      const generator = callback()
      let step = generator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = generator.next()
      }
    },
  }
  return { ctx, tools, agent, dispose: async () => { for (const dispose of disposers.reverse()) await dispose() } }
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'browser-use-plugin-'))
  const { ctx, tools, agent, dispose } = fakeContext()
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)

  plugin.apply(ctx, {
    projectPath: ENGINE,
    userDataDir: join(profile, 'browser'),
    headless: true,
    allowGoalMode: false,
  })

  const run = (name, args) => tools.get(name).execute(args, { agent, signal: new AbortController().signal })
  try {
    check([...tools.keys()].sort().join(',') === 'browser_act,browser_close,browser_console,browser_doctor,browser_open,browser_page,browser_screenshot',
      `the tool surface is ${[...tools.keys()].join(', ')}`)
    check(!tools.has('browser_goal'), 'goal mode stays off unless the profile asks for it')

    const doctor = await run('browser_doctor', {})
    check(/Status\s*:\s*ready/u.test(doctor.text), 'the doctor reports a ready engine')
    check(doctor.text.includes('jev_ultrafast') && doctor.text.includes('browser-harness'), 'the doctor names the engine it found')

    const opened = await run('browser_open', { url: FIXTURE })
    check(opened.observation === 1, 'the first read is observation 1')
    check(opened.text.includes('Observation 1'), 'the table names the observation the targets belong to')
    check(/\[\d+\] searchbox Destination.*TYPE_TEXT/u.test(opened.text), 'a typeable field is offered with TYPE_TEXT')
    check(/Without a target: .*WAIT/u.test(opened.text), 'operations without a target are listed separately')

    const typed = await run('browser_act', { observation: 1, operation: 'TYPE_TEXT', target: targetFor(opened.text, 'Destination'), text: 'Lisbon' })
    check(typed.observation === 2 && /searchbox Destination · "Lisbon"/u.test(typed.text), 'typing reports the value the page now holds')

    const selected = await run('browser_act', { observation: 2, operation: 'SELECT', target: optionFor(typed.text, 'Design') })
    check(selected.text.includes('Executed SELECT'), 'an observed dropdown option is selectable')

    const submitted = await run('browser_act', { observation: 3, operation: 'CLICK', target: targetFor(selected.text, 'Find stays') })
    check(/Casa Flora/u.test(submitted.text), 'the submitted filters leave the one matching stay on the page')

    const stale = await run('browser_act', { observation: 1, operation: 'CLICK', target: '5' })
    check(stale.text.startsWith('Nothing was executed'), 'an action from an older observation is refused, not applied')
    check(stale.observation > submitted.observation, 'the refusal carries a newer observation to choose from')

    const unknown = await run('browser_act', { observation: 999, operation: 'CLICK', target: '5' })
    check(unknown.text.startsWith('Refused:'), 'an observation this Session never produced is refused')

    const badOperation = await run('browser_act', { observation: 999, operation: 'PRESS_KEY', target: '5' })
    check(badOperation.text.startsWith('Refused:'), 'an operation the browser does not offer is refused')

    const detail = await run('browser_act', {
      observation: submitted.observation,
      operation: 'CLICK',
      target: targetFor(submitted.text, 'View Casa Flora'),
    })
    check(/Destination Lisbon/u.test(detail.text) && /Design/u.test(detail.text),
      'the opened stay reports the typed destination and the chosen category')

    const shot = await run('browser_screenshot', {})
    check(shot.text.includes('Viewport') || shot.text.includes('attachment service'), 'a screenshot answers with its viewport or a clear reason')

    const console_ = await run('browser_console', {})
    check(console_.text.startsWith('Page '), 'console output is reported for the page this Session drives')

    const before = detail.observation
    const closed = await run('browser_close', {})
    check(/stopped/u.test(closed.text), 'closing stops the tab, the browser, and its daemon')
    const reopened = await run('browser_open', { url: FIXTURE })
    check(reopened.observation > before, 'a browser tool after a close opens a fresh browser and a new observation')
    const orphan = await run('browser_act', { observation: before, operation: 'CLICK', target: '5' })
    check(orphan.text.startsWith('Refused:'), 'an observation from the closed browser cannot be acted on')
  } finally {
    await dispose()
    // A browser that was just asked to stop may still be flushing its profile; the temp directory is
    // the operating system's to reclaim either way.
    await new Promise(resolve => setTimeout(resolve, 1500))
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
  console.log(passed.join('\n'))
  console.log(`PASS: ${passed.length} plugin checks; no model calls`)
}

/**
 * An installation whose engine is missing must say what to install, not surface a sidecar that
 * exited. Nothing here starts a browser: the refusal happens before one is ever needed.
 */
async function missingEngine() {
  const { ctx, tools, agent } = fakeContext()
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  plugin.apply(ctx, { pythonPath: '/nonexistent/python', projectPath: '', mode: 'launch' })
  const run = (name, args) => tools.get(name).execute(args, { agent, signal: new AbortController().signal })

  const doctor = await run('browser_doctor', {})
  check(/not usable/u.test(doctor.text), 'the doctor reports an unusable interpreter')
  check(/fix:/u.test(doctor.text), 'the doctor names the fix for the missing engine')
  check(/projectPath|pythonPath/u.test(doctor.text), 'the fix names the setting that changes it')

  let refusal
  try {
    await run('browser_open', { url: 'https://example.com' })
  } catch (error) {
    refusal = String(error.message ?? error)
  }
  check(refusal !== undefined, 'a browser tool refuses when the engine is missing')
  check(/not ready/u.test(refusal) && refusal.includes('/nonexistent/python'),
    'the refusal carries the same diagnosis instead of a sidecar crash')
  console.log('PASS: 4 missing-engine checks; no browser, no model calls')
}

/**
 * One attached browser belongs to one Session. The refusal is decided before the engine is asked to
 * do anything, so this needs no browser: the first Session takes the reservation and fails on the
 * missing engine, and the second is refused for the reason that matters.
 */
async function attachExclusivity() {
  const { Sessions } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'sessions.js')).href)
  const agents = new Map()
  const make = id => {
    const agent = { id, ctx: { effect: () => () => {} } }
    agents.set(id, agent)
    return agent
  }
  const first = make('session-attach-one')
  const second = make('session-attach-two')
  const ctx = { get: name => (name === 'agents' ? { get: id => agents.get(id) } : undefined) }
  const sessions = new Sessions(ctx, {
    mode: 'attach',
    cdpEndpoint: 'ws://127.0.0.1:9/devtools/browser/none',
    pythonPath: '/nonexistent/python',
    requestTimeoutMs: 1000,
  })

  const attempt = agent => sessions.run(agent, undefined, async () => 'opened').then(() => '', error => String(error.message))
  const firstFailure = await attempt(first)
  check(/not ready|not usable/u.test(firstFailure), 'the first Session takes the attached browser and reaches the engine check')

  const secondFailure = await attempt(second)
  check(/attached by another live Session/u.test(secondFailure), 'a second Session is refused the attached browser')
  check(!/not usable/u.test(secondFailure), 'the refusal explains the reservation instead of the engine')
  console.log(`PASS: 2 attach-exclusivity checks; no browser, no engine`)
}

/**
 * A cancelled call settles instead of waiting for an answer that may never come, and says what the
 * browser may still do.
 */
async function cancelInFlight() {
  const { Sidecar } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'sidecar.js')).href)
  const profile = await mkdtemp(join(tmpdir(), 'browser-use-cancel-'))
  const sidecar = new Sidecar({
    config: {
      projectPath: ENGINE,
      pythonPath: '',
      mode: 'launch',
      cdpEndpoint: '',
      executablePath: '',
      userDataDir: join(profile, 'browser'),
      headless: true,
      requestTimeoutMs: 120000,
    },
    label: 'cancel-check',
  })
  try {
    await sidecar.ready()
    const controller = new AbortController()
    // The address refuses immediately: the call is cancelled before any answer could arrive, and the
    // engine is left with nothing long-running to clean up.
    const pending = sidecar.request('open', { url: 'http://127.0.0.1:1/', mode: 'launch', userDataDir: join(profile, 'browser'), headless: true }, controller.signal)
    controller.abort()
    const started = Date.now()
    const error = await pending.then(() => undefined, failure => failure)
    check(error !== undefined && error.kind === 'cancelled', 'an aborted in-flight call settles as cancelled')
    check(Date.now() - started < 5000, 'the cancelled call settles immediately instead of waiting for the browser')
    check(/read the page again/u.test(String(error.message)), 'the cancellation says what the browser may still do')
  } finally {
    await sidecar.stop()
    await new Promise(resolve => setTimeout(resolve, 1500))
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
  console.log('PASS: 3 cancellation checks; real sidecar, no model calls')
}

await main()
await missingEngine()
await attachExclusivity()
await cancelInFlight()
