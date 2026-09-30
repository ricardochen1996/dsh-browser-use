/**
 * The inspector halves without DSH: the client bundle registers what the right Sidebar expects, and
 * the host route serves a page that really renders the Session's element table.
 *
 * Run with `node test/inspector.mjs`. With `--serve`, the route stays up on
 * a loopback port and prints the URL, so a real browser can be pointed at it.
 */

import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVE = process.argv.includes('--serve')
const passed = []
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
  passed.push(message)
}

const PAGE = {
  url: 'https://example.test/stays',
  title: 'Stays',
  text: 'Three considered places, close to what matters.',
  fingerprint: 'fingerprint-1',
  elements: [
    { index: '1', role: 'searchbox', label: 'Destination', value: 'Lisbon', operations: ['TYPE_TEXT', 'CLICK'] },
    { index: '2', role: 'combobox', label: 'Stay category', value: 'All stays', operations: ['SELECT'],
      options: [{ index: '2:1', label: 'Stay category → Design', value: 'Design' }] },
    { index: '3', role: 'button', label: 'Find stays', value: '', operations: ['CLICK'] },
  ],
  operations: { CLICK: ['1', '3'], TYPE_TEXT: ['1'], SELECT: ['2:1'], WAIT: [] },
}

/** The registrations the client half makes, recorded the way the shell would receive them. */
async function checkClientHalf() {
  const registrations = []
  const effects = []
  const slots = {
    inject: (name, register) => { effects.push(() => register()); return () => {} },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  }
  const sidebarRightTabs = {
    register: definition => { registrations.push({ tab: definition }); return () => {} },
  }
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        globalThis.__loaded = { id, factory }
      },
    },
  }
  const require = specifier => {
    check(specifier === 'react', 'the client half requires only the shell\u2019s React entry')
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
    }
  }
  await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'client.js')).href)
  const loaded = globalThis.__loaded
  check(loaded?.id === '@rc/dsh-browser-use', 'the bundle registers under the package name the shell dispatches')

  const plugin = loaded.factory(require)
  check(plugin.name === 'dsh-browser-use-client' && typeof plugin.apply === 'function', 'the factory returns a Cordis plugin face')
  check(plugin.inject.includes('slots') && plugin.inject.includes('sidebarRightTabs'), 'the client half injects the slots and tab registries')

  const ctx = {
    slots,
    sidebarRightTabs,
    effect: callback => { const disposer = callback(); effects.push(disposer); return () => {} },
  }
  plugin.apply(ctx)
  for (const effect of effects) effect()

  const tab = registrations.find(entry => entry.tab)?.tab
  check(tab?.id === 'dsh-browser-use/inspector' && tab.kind === 'browser-use', 'a right-Sidebar tab type is registered')
  check(typeof tab.title === 'function' && typeof tab.guide?.[0]?.title === 'function', 'the tab type carries a title and a guide card')

  const body = registrations.find(entry => entry.options)?.options
  check(body?.name === 'sidebar.right.pane.tab' && body.key === tab.id, 'the tab body is registered under its own slot key')
  const element = registrations.find(entry => entry.component).component()
  check(element.type === 'iframe' && element.props.src === '/browser-use/', 'the tab body frames the host route')
}

/** The host route as the shell reaches it: same handler, a real HTTP server. */
async function checkHostRoute() {
  const { registerInspector } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'inspector.js')).href)
  let route
  const ctx = { get: name => (name === 'webServer' ? { register: registered => { route = registered; return () => {} } } : undefined) }
  const sessions = {
    view: () => [{
      label: 'session-test',
      url: PAGE.url,
      title: PAGE.title,
      text: PAGE.text,
      observation: 3,
      lastAction: 'CLICK on Find stays',
      updatedAt: Date.now(),
      elements: PAGE.elements,
      operations: PAGE.operations,
    }],
    capture: async () => Buffer.from('jpeg-bytes'),
  }
  check(registerInspector(ctx, sessions) !== undefined, 'the inspector registers a host route')
  check(route.kind === 'prefix' && route.path === '/browser-use', `the route is a prefix route on ${route.path}`)

  const server = createServer((req, res) => route.handler(req, res))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const state = await (await fetch(`${origin}/browser-use/state`)).json()
    check(state.sessions[0].elements.length === 3, 'the state route reports the elements a tool result carries')
    const page = await (await fetch(`${origin}/browser-use/`)).text()
    check(page.includes('Browser agent') && page.includes('refreshShot'), 'the inspector page ships its own renderer')
    const shot = await fetch(`${origin}/browser-use/screenshot`)
    check(shot.headers.get('content-type') === 'image/jpeg', 'the screenshot route answers with an image')
    check((await fetch(`${origin}/browser-use/nope`)).status === 404, 'an unknown path under the prefix is a 404')
  } finally {
    if (!SERVE) await new Promise(done => server.close(done))
  }
  if (SERVE) console.log(`SERVING ${origin}/browser-use/`)
  return server
}

await checkClientHalf()
await checkHostRoute()
if (!SERVE) {
  console.log(passed.join('\n'))
  console.log(`PASS: ${passed.length} inspector checks`)
}
