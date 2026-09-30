/**
 * The delegated half, driven without DSH: a fake Cordis context, a fake `ctx.subagents`, the real
 * sidecar, a real browser.
 *
 * Run with `node test/delegation.mjs`. It checks the arrangement the plugin promises: the
 * conversation holds `browser_task` and nothing else, a delegated child is the only agent that ever
 * sees a browser tool, and the browser it drives outlives the delegation that used it.
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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
/** Progress goes to stderr as it happens: a stall names its own phase. */
const phase = message => process.stderr.write(`  … ${message}\n`)

/**
 * The part of Cordis this plugin uses, with one scope per Agent: a global registration, scoped
 * registrations, scoped restrictions, prompt sections, and the `agent/created` event.
 */
function fakeHost({ capabilities = { toolFilter: true }, late = false } = {}) {
  const globals = new Map()
  const scopes = new Map()
  const restrictions = new Map()
  const sections = []
  const listeners = new Map()
  const agents = new Map()
  const warnings = []
  const delegations = []

  /** Every effect the plugin registered, so unloading it can be driven the way Cordis would. */
  const effects = []
  /** Take a Cordis effect callback: a generator of disposers, or one disposer itself. */
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

  const makeAgent = (id, header) => {
    if (!scopes.has(id)) scopes.set(id, new Map())
    if (!restrictions.has(id)) restrictions.set(id, [])
    const agent = { id, session: { header } }
    agent.ctx = {
      tools: {
        register: definition => {
          scopes.get(id).set(definition.name, definition)
          return () => scopes.get(id).delete(definition.name)
        },
        restrict: filter => {
          restrictions.get(id).push(filter)
          return () => {}
        },
      },
      systemPrompt: {
        section: specification => { sections.push({ scope: id, ...specification }); return () => {} },
        getSectionOrder: () => 0,
      },
      effect,
    }
    agents.set(id, agent)
    return agent
  }

  const subagents = {
    getProvider: name => (name === 'spawn' ? { name, capabilities, inheritsParentContext: false } : undefined),
    start: async (_name, request) => {
      const child = makeAgent(`child-${delegations.length + 1}`, {
        parentSession: request.parent.id,
        origin: 'subagent',
        isSeeded: false,
      })
      for (const handler of listeners.get('agent/created') ?? []) await handler({ agent: child, source: 'spawn' })
      let deliver
      const delivered = new Promise(resolve => { deliver = resolve })
      const record = { child, request, disposed: false, deliver, tools: scopes.get(child.id) }
      delegations.push(record)
      // The in-process provider cancels a published run's remaining work when the request signal
      // fires; the fake settles the same way, so the plugin cannot pass by ignoring the signal.
      request.signal?.addEventListener('abort', () => deliver('(the run was cancelled)'), { once: true })
      return {
        id: child.id,
        localAgent: child,
        result: (async () => {
          const text = await delivered
          return {
            output: [{ type: 'text', text }],
            stopReason: request.signal.aborted ? 'aborted' : 'completed',
          }
        })(),
        dispose: async () => {
          record.disposed = true
          agents.delete(child.id)
        },
      }
    },
  }

  // A service that activates asynchronously is absent while a plugin applies: `late` is the
  // composition this plugin actually meets in DSH.
  let service = late ? undefined : subagents
  const emit = async (event, payload) => {
    for (const handler of listeners.get(event) ?? []) await handler(payload)
  }

  const ctx = {
    tools: {
      register: definition => { globals.set(definition.name, definition); return () => globals.delete(definition.name) },
      schemas: () => [...globals.values()],
    },
    agents: { get: id => agents.get(id) },
    systemPrompt: {
      section: specification => { sections.push({ scope: 'global', ...specification }); return () => {} },
      getSectionOrder: () => 0,
    },
    logger: { info: () => {}, warn: message => warnings.push(String(message)) },
    get: name => (name === 'agents' ? ctx.agents : name === 'subagents' ? service : undefined),
    effect,
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== handler))
    },
  }

  const conversation = makeAgent('session-conversation', { isSeeded: false })
  const dispose = async () => { for (const item of effects.reverse()) await item() }
  const provide = async () => {
    service = subagents
    await emit('subagent/provider-added', { name: 'spawn', capabilities, inheritsParentContext: false })
  }
  const unprovide = async () => {
    service = undefined
    await emit('subagent/provider-removed', 'spawn')
  }
  return { ctx, conversation, globals, scopes, restrictions, sections, delegations, warnings, dispose, provide, unprovide }
}

/** Wait until the fake subagents service has created the given delegation. */
async function waitForChild(host, index = 0) {
  const deadline = Date.now() + 10000
  while (host.delegations.length <= index) {
    if (Date.now() > deadline) throw new Error(`no delegation was created (have ${host.delegations.length}, want ${index + 1})`)
    await wait(10)
  }
  return host.delegations[index]
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'browser-use-delegation-'))
  const host = fakeHost()
  const plugin = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  plugin.apply(host.ctx, { projectPath: ENGINE, userDataDir: join(profile, 'browser'), headless: true })

  const ask = (args, signal = new AbortController().signal) =>
    host.globals.get('browser_task').execute(args, { agent: host.conversation, signal })
  const childCall = (record, name, args) =>
    record.tools.get(name).execute(args ?? {}, { agent: record.child, signal: record.request.signal })

  try {
    check([...host.globals.keys()].sort().join(',') === 'browser_doctor,browser_task',
      `the conversation holds ${[...host.globals.keys()].join(', ')}`)
    check(!host.globals.has('browser_open') && !host.globals.has('browser_act'),
      'no browser tool is registered for every agent')

    // First delegation: the child opens the fixture, types into it, and reports.
    phase('first delegation')
    const firstPending = ask({ instruction: `Open the page and type Lisbon into Destination.`, url: FIXTURE })
    const first = await waitForChild(host, 0)
    check([...first.tools.keys()].sort().join(',') === 'browser_act,browser_close,browser_console,browser_open,browser_page,browser_screenshot',
      `the child holds ${[...first.tools.keys()].join(', ')}`)
    check(JSON.stringify(host.restrictions.get(first.child.id)) === '[{"allow":[]}]',
      'the child runs with an empty global allow-list')
    check(host.sections.some(item => item.scope === first.child.id && item.name === 'dsh-browser-use:browser'),
      'the child gets the browser guidance')
    check(!host.sections.some(item => item.scope === 'global' && item.name.startsWith('dsh-browser-use:browser')),
      'the conversation does not get the child guidance')

    phase('child opens the page')
    const opened = await childCall(first, 'browser_open', { url: FIXTURE })
    const target = opened.text.match(/\[(\d+)\][^\n]*searchbox Destination/u)?.[1]
    check(target !== undefined, 'the child reads an indexed action space from the real browser')
    const typed = await childCall(first, 'browser_act', {
      observation: opened.observation,
      operation: 'TYPE_TEXT',
      target,
      text: 'Lisbon',
    })
    check(typed.text.includes('· "Lisbon"'), 'the child acts on the page')
    first.deliver('Typed Lisbon into Destination; the field reports "Lisbon".')
    const firstReport = await firstPending
    check(firstReport.text.includes('Typed Lisbon'), 'the delegation returns the child report to the conversation')
    check(first.disposed, 'the delegation gives the child back')

    // Second delegation: the same browser, with the state the first one left.
    phase('second delegation')
    const secondPending = ask({ instruction: 'Read the page again and report the destination field.' })
    const second = await waitForChild(host, 1)
    phase('child reads the page again')
    const page = await childCall(second, 'browser_page', {})
    check(page.text.includes('· "Lisbon"'), 'the second delegation reads the page the first one left, in the same browser')
    second.deliver('The page still reports Lisbon.')
    const secondReport = await secondPending
    check(secondReport.text.includes('still reports Lisbon'), 'the second delegation reports back')

    // A cancelled delegation is given back and the tool call settles.
    const controller = new AbortController()
    phase('cancelled delegation')
    const cancelled = ask({ instruction: 'Wait forever.' }, controller.signal)
    const third = await waitForChild(host, 2)
    controller.abort()
    let refusal
    try { await cancelled } catch (error) { refusal = String(error?.message ?? error) }
    check(refusal !== undefined, 'a cancelled delegation settles the tool call instead of hanging')
    check(third.disposed, 'a cancelled delegation gives the child back too')

    phase('doctor')
    const doctor = await host.globals.get('browser_doctor').execute({}, {
      agent: host.conversation,
      signal: new AbortController().signal,
    })
    check(/Delegation\s*:\s*on:/.test(doctor.text), 'the doctor reports that browser work is delegated')
  } finally {
    // Unloading the plugin closes the Session browser: the conversation's browser goes with the
    // conversation, not with the delegation that happened to use it.
    await host.dispose()
    await wait(1500)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }

  // The provider composes an in-process child because it can restrict the child's tools; without
  // that capability the plugin does not pretend to delegate.
  phase('fallback host')
  const fallback = fakeHost({ capabilities: { toolFilter: false } })
  const plugin2 = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  plugin2.apply(fallback.ctx, { projectPath: ENGINE })
  check(!fallback.globals.has('browser_task'), 'an unusable provider leaves no delegation tool behind')
  check(fallback.globals.has('browser_open'), 'an unusable provider falls back to the browser tools')
  check(fallback.warnings.some(message => message.includes('not delegated')), 'the fallback is reported at load')

  // `ctx.subagents` activates asynchronously, so the plugin usually applies before it exists: the
  // composition has to be read again when the provider arrives, not decided once at load.
  phase('late provider')
  const late = fakeHost({ late: true })
  const plugin3 = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'index.js')).href)
  plugin3.apply(late.ctx, { projectPath: ENGINE })
  check(late.globals.has('browser_open') && !late.globals.has('browser_task'),
    'a composition without the subagent service starts in direct mode')
  await late.provide()
  check(late.globals.has('browser_task') && !late.globals.has('browser_open'),
    'a provider that appears later turns delegation on and takes the browser tools away')
  await late.unprovide()
  check(late.globals.has('browser_open') && !late.globals.has('browser_task'),
    'a provider that goes away falls back to the browser tools')
  await late.dispose()

  console.log(passed.join('\n'))
  console.log(`PASS: ${passed.length} delegation checks; real browser, no model calls`)
}

await main()
