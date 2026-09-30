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

/**
 * The shell's React entry, cut down to what the client half uses: elements become plain trees, a
 * hook answers with its initial state, and the settings mirror is read through its snapshot.
 */
const reactStub = () => ({
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
})

/**
 * The shell's primitives, recorded as the host elements they render, so a check drives the very
 * interaction the page would: a toggle click, a menu pick, a typed field.
 */
const primitivesStub = () => ({
  Input: props => ({ type: 'input', props, children: [] }),
  Switch: props => ({
    type: 'button',
    props: { ...props, onClick: () => { props.onChange(props.checked !== true) } },
    children: [],
  }),
  Menu: props => ({ type: 'div', props, children: [props.anchor] }),
})

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
  const required = []
  const require = specifier => {
    required.push(specifier)
    return specifier === 'react' ? reactStub() : primitivesStub()
  }
  await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'client.js')).href)
  const loaded = globalThis.__loaded
  check(loaded?.id === '@rc/dsh-browser-use', 'the bundle registers under the package name the shell dispatches')

  const plugin = loaded.factory(require)
  check(plugin.name === 'dsh-browser-use-client' && typeof plugin.apply === 'function', 'the factory returns a Cordis plugin face')
  check(plugin.inject.includes('slots') && plugin.inject.includes('sidebarRightTabs'), 'the client half injects the slots and tab registries')
  check(required.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'the form draws its controls with the shell\u2019s own primitives instead of raw inputs')

  const ctx = {
    slots,
    sidebarRightTabs,
    // No settings mirror in this composition: the row page still registers, the bundle card does not.
    inject: () => {},
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
  check(registrations.some(entry => entry.options?.name === 'plugins.row.config'),
    'the row configuration still registers without a settings mirror')
}

/**
 * The switch form the Plugins page renders for this plugin's row: the key that gives the row its
 * configure control, the fields it draws, and the write one edit produces.
 */
async function checkSwitchForm() {
  const registrations = []
  const effects = []
  const slots = {
    inject: (name, register) => { effects.push(() => register()); return () => {} },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  }
  const require = specifier => (specifier === 'react' ? reactStub() : primitivesStub())
  globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { globalThis.__loaded = { factory } } } }
  await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'client.js')).href)
  const plugin = globalThis.__loaded.factory(require)
  const cardWrites = []
  const controller = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: { mode: 'attach', jev: { enabled: true } } }),
    subscribe: () => () => {},
    mutate: (operations, revision) => { cardWrites.push({ operations, revision }); return Promise.resolve(true) },
  }
  const ctx = {
    slots,
    sidebarRightTabs: { register: () => () => {} },
    effect: callback => { const disposer = callback(); effects.push(disposer); return () => {} },
    inject: (names, callback) => {
      if (names.includes('configForms')) callback({ slots, effect: ctx.effect, configForms: { get: () => controller } })
    },
  }
  plugin.apply(ctx)
  for (const effect of effects) effect()

  const page = registrations.find(entry => entry.options?.name === 'plugins.row.config')
  check(page?.options.key === '@rc/dsh-browser-use#dsh-browser-use',
    'the row configuration is keyed by the package and the row id the page looks for')
  const card = registrations.find(entry => entry.options?.name === 'plugins.bundle.config')
  check(card?.options.key === '@rc/dsh-browser-use',
    'the bundle page card is registered under the bundle name, so the switches show without opening a row')

  check(page.component({ view: 'summary', form: undefined }) === null, 'the row summary draws nothing, so the metadata description stands')
  check(page.component({ view: 'page', form: undefined }) !== null, 'a page without a form says so instead of throwing')

  // A miniature renderer: expand the function components, keep host elements.
  const render = node => {
    if (Array.isArray(node)) return node.flatMap(render)
    if (node === null || node === undefined || typeof node !== 'object') return []
    if (typeof node.type === 'function') return render(node.type(node.props))
    return [node, ...node.children.flatMap(render)]
  }
  // Expanding `Fields` and its group wrappers (but not the rows) keeps one element per setting row.
  const rowsOf = element => {
    const found = []
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node === null || typeof node !== 'object') return
      if (node.props?.row !== undefined) { found.push(node); return }
      if (typeof node.type === 'function') return walk(node.type(node.props))
      ;(node.children ?? []).forEach(walk)
    }
    walk(typeof element.type === 'function' ? element.type(element.props) : element)
    return found
  }
  const pathsOf = element => rowsOf(element).map(node => node.props.row.path.join('.')).sort()
  const rowFor = (element, path) => rowsOf(element).find(node => node.props.row.path.join('.') === path)
  const controlFor = (element, path) => render(rowFor(element, path))

  const writes = []
  const form = {
    state: { status: 'ready', writable: true, revision: 7, value: { jev: { enabled: false, source: 'session', typesafe: {} } } },
    mutate: (operations, revision) => { writes.push({ operations, revision }); return Promise.resolve(true) },
  }
  const pageFields = pathsOf(page.component({ view: 'page', form }))
  check(JSON.stringify(pageFields) === JSON.stringify([
    'jev.enabled', 'jev.source',
    'jev.textModel.apiKey', 'jev.textModel.apiKeyEnv', 'jev.textModel.baseURL', 'jev.textModel.model',
    'jev.typesafe.apiKey', 'jev.typesafe.apiKeyEnv', 'jev.typesafe.baseURL', 'jev.typesafe.model',
  ].sort()), `the form offers jev and nothing else (got ${pageFields.join(', ')})`)

  // The toggle is the shell's Switch: a button that asks for the opposite state.
  controlFor(page.component({ view: 'page', form }), 'jev.enabled').find(node => node.type === 'button').props.onClick()
  check(writes[0]?.operations?.[0]?.op === 'set' && writes[0].operations[0].path.join('.') === 'jev.enabled'
    && writes[0].operations[0].value === true && writes[0].revision === 7,
  'toggling browser_goal writes the live path with the revision the page read')

  // A text field commits on blur, not on every keystroke.
  const url = controlFor(page.component({ view: 'page', form }), 'jev.typesafe.baseURL').find(node => node.type === 'input')
  url.props.onChange({ target: { value: 'https://gateway.test/systemone' } })
  url.props.onBlur({ target: { value: 'https://gateway.test/systemone' } })
  check(writes[1]?.operations?.[0]?.value === 'https://gateway.test/systemone', 'a typed endpoint is written when the field settles')

  // The source is the shell's Menu: a pick writes the chosen id.
  const source = controlFor(page.component({ view: 'page', form }), 'jev.source').find(node => typeof node.props?.onSelect === 'function')
  source.props.onSelect('custom')
  check(writes[2]?.operations?.[0]?.path.join('.') === 'jev.source' && writes[2].operations[0].value === 'custom',
    'picking a credential source writes the chosen id')

  const before = writes.length
  const secret = controlFor(page.component({ view: 'page', form }), 'jev.typesafe.apiKey').find(node => node.type === 'input')
  check(secret.props.type === 'password', 'a key is drawn as a password field')
  secret.props.onBlur({ target: { value: '' } })
  check(writes.length === before, 'an untouched secret is not written back, so the stored key survives the form')

  // The bundle page's card reads the namespace itself, so its write goes through that controller.
  const cardElement = card.component({ view: 'page' })
  check(JSON.stringify(pathsOf(cardElement)) === JSON.stringify(pageFields),
    'the bundle page card draws the same switches as the row page')
  controlFor(cardElement, 'jev.enabled').find(node => node.type === 'button').props.onClick()
  // The mirror reports jev on, so the toggle asks for off — and the write carries the mirror's revision.
  check(cardWrites[0]?.operations?.[0]?.path.join('.') === 'jev.enabled' && cardWrites[0].operations[0].value === false
    && cardWrites[0].revision === 3,
  'a switch on the bundle page writes through the settings mirror with the revision it read')
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
await checkSwitchForm()
await checkHostRoute()
if (!SERVE) {
  console.log(passed.join('\n'))
  console.log(`PASS: ${passed.length} inspector checks`)
}
