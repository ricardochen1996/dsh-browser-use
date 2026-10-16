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

/**
 * The shell's locale service, cut down to what the client half uses: the dictionaries it registers,
 * a binding that resolves the active language at call time, and the revision pair the settings rows'
 * translator rides. `active` is the test's own language switch.
 */
const localeStub = () => {
  const dictionaries = new Map()
  const stub = {
    active: 'en',
    registered: [],
    // The real registry disposes a dictionary with the plugin; nothing here unloads one, and a
    // disposer the effects loop calls must not take the copy away from the assertions below.
    register: (ns, dicts) => { stub.registered.push({ ns, dicts }); dictionaries.set(ns, dicts); return () => {} },
    bind: ns => key => dictionaries.get(ns)?.[stub.active]?.[key] ?? key,
    getSnapshot: () => ({ revision: 0 }),
    subscribe: () => () => {},
  }
  return stub
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
  const required = []
  const require = specifier => {
    required.push(specifier)
    return specifier === 'react' ? reactStub() : primitivesStub()
  }
  await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'client.js')).href)
  const loaded = globalThis.__loaded
  check(loaded?.id === '@ricardochen1996/dsh-browser-use', 'the bundle registers under the package name the shell dispatches')

  const plugin = loaded.factory(require)
  check(plugin.name === 'dsh-browser-use-client' && typeof plugin.apply === 'function', 'the factory returns a Cordis plugin face')
  check(['slots', 'sidebarRightTabs', 'locale'].every(service => plugin.inject.includes(service)),
    'the client half injects the slots, tab registry and locale services')
  check(required.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'the form draws its controls with the shell\u2019s own primitives instead of raw inputs')

  const locale = localeStub()
  const ctx = {
    slots,
    sidebarRightTabs,
    locale,
    // No settings mirror in this composition: the row page still registers, the bundle card does not.
    inject: () => {},
    effect: callback => { const disposer = callback(); effects.push(disposer); return () => {} },
  }
  plugin.apply(ctx)
  for (const effect of effects) effect()

  const copy = locale.registered.find(entry => entry.ns === 'browserUse')
  check(copy?.dicts?.zh !== undefined && copy?.dicts?.en !== undefined,
    'the client half registers both shipped locales for its own namespace')
  check(JSON.stringify(Object.keys(copy.dicts.zh).sort()) === JSON.stringify(Object.keys(copy.dicts.en).sort()),
    'the Chinese and English dictionaries carry the same keys, so neither language shows a raw key')

  const tab = registrations.find(entry => entry.tab)?.tab
  check(tab?.id === 'dsh-browser-use/inspector' && tab.kind === 'browser-use', 'a right-Sidebar tab type is registered')
  check(typeof tab.title === 'function' && typeof tab.guide?.[0]?.title === 'function', 'the tab type carries a title and a guide card')
  check(tab.title() === 'Browser agent', 'the tab title reads the English copy while English is the active language')
  locale.active = 'zh'
  check(tab.title() === '浏览器代理' && tab.guide[0].description() === '查看浏览器工具正在操作的页面。',
    'the tab and its guide card follow the active language without re-registering')
  locale.active = 'en'

  const body = registrations.find(entry => entry.options)?.options
  check(body?.name === 'sidebar.right.pane.tab' && body.key === tab.id, 'the tab body is registered under its own slot key')
  const element = registrations.find(entry => entry.component).component()
  check(element.type === 'iframe' && element.props.src === '/browser-use/', 'the tab body frames the host route')
  check(element.props.title === 'Browser agent', 'the framed page keeps an accessible title from the same dictionary')
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
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: { mode: 'attach', jev: { decider: 'typesafe' } } }),
    subscribe: () => () => {},
    mutate: (operations, revision) => { cardWrites.push({ operations, revision }); return Promise.resolve(true) },
  }
  const locale = localeStub()
  const ctx = {
    slots,
    sidebarRightTabs: { register: () => () => {} },
    locale,
    effect: callback => { const disposer = callback(); effects.push(disposer); return () => {} },
    inject: (names, callback) => {
      if (names.includes('configForms')) callback({ slots, effect: ctx.effect, configForms: { get: () => controller } })
    },
  }
  plugin.apply(ctx)
  for (const effect of effects) effect()

  const page = registrations.find(entry => entry.options?.name === 'plugins.row.config')
  check(page?.options.key === '@ricardochen1996/dsh-browser-use#dsh-browser-use',
    'the row configuration is keyed by the package and the row id the page looks for')
  const card = registrations.find(entry => entry.options?.name === 'plugins.bundle.config')
  check(card?.options.key === '@ricardochen1996/dsh-browser-use',
    'the bundle page card is registered under the bundle name, so the switches show without opening a row')
  check(page.options.locale === 'browserUse' && card.options.locale === 'browserUse',
    'both form registrations declare the locale namespace, so the renderer seats their translator')

  /** The text of every node carrying one class, in document order. */
  const textsOf = (element, className) => {
    const found = []
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node === null || typeof node !== 'object') return
      if (node.props?.className === className) { found.push(node.children.flat(Infinity).join('')); return }
      if (typeof node.type === 'function') return walk(node.type(node.props))
      ;(node.children ?? []).forEach(walk)
    }
    walk(element)
    return found
  }
  const labelsOf = element => textsOf(element, 'dsh-bu-label')
  const hintsOf = element => textsOf(element, 'dsh-bu-hint')

  check(page.component({ view: 'summary', form: undefined }) === null, 'the row summary draws nothing, so the metadata description stands')
  check(page.component({ view: 'page', form: undefined }) !== null, 'a page without a form says so instead of throwing')
  const refusal = hintsOf(page.component({ view: 'page', form: undefined }))[0]
  check(refusal?.includes('provides no configuration form'), `the refusal reads English while English is active (got ${refusal})`)

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
    state: { status: 'ready', writable: true, revision: 7, value: { jev: { decider: 'typesafe', source: 'session', typesafe: {} } } },
    mutate: (operations, revision) => { writes.push({ operations, revision }); return Promise.resolve(true) },
  }
  const pageFields = pathsOf(page.component({ view: 'page', form }))
  check(JSON.stringify(pageFields) === JSON.stringify([
    'jev.decider',
    'jev.typesafe.apiKey', 'jev.typesafe.baseURL', 'jev.typesafe.model',
  ].sort()), `the form offers the decider and TypeSafe and nothing else (got ${pageFields.join(', ')})`)

  // One switch, two answers: no way to turn Jev off, because who answers it is the only question.
  const decider = controlFor(page.component({ view: 'page', form }), 'jev.decider')
    .find(node => typeof node.props?.onSelect === 'function')
  check(JSON.stringify(decider.props.items.map(item => item.id)) === JSON.stringify(['typesafe', 'chat'])
    && decider.props.selectedId === 'typesafe',
  'the switch offers exactly the two things that can answer, and no off')
  decider.props.onSelect('chat')
  check(writes[0]?.operations?.[0]?.op === 'set' && writes[0].operations[0].path.join('.') === 'jev.decider'
    && writes[0].operations[0].value === 'chat' && writes[0].revision === 7,
  'picking the text model writes the decider with the revision the page read')

  // The copy follows the shell's active language: the same registration, the same rows, read twice.
  const englishLabels = labelsOf(page.component({ view: 'page', form }))
  check(JSON.stringify(englishLabels) === JSON.stringify(['Decider', 'Jev URL', 'Jev Model', 'Jev API key']),
    `the rows read English while English is active (got ${englishLabels.join(', ')})`)
  check(JSON.stringify(controlFor(page.component({ view: 'page', form }), 'jev.decider')
    .find(node => typeof node.props?.onSelect === 'function').props.items.map(item => item.label))
    === JSON.stringify(['Jev', 'Text model (no Jev key needed)']),
  'the decider menu entries read English too')
  check(hintsOf(page.component({ view: 'page', form }))[0]?.startsWith('Jev is always on'),
    'the hint under the decider reads English too')
  locale.active = 'zh'
  const chineseLabels = labelsOf(page.component({ view: 'page', form }))
  check(JSON.stringify(chineseLabels) === JSON.stringify(['决策者', 'Jev URL', 'Jev Model', 'Jev 密钥']),
    `the same rows read Chinese once the active language changes (got ${chineseLabels.join(', ')})`)
  check(hintsOf(page.component({ view: 'page', form }))[0]?.startsWith('Jev 常开'),
    'the hint follows the active language as well')
  check(hintsOf(page.component({ view: 'page', form: undefined }))[0]?.includes('没有提供'),
    'the refusal follows the active language as well')
  locale.active = 'en'
  check(labelsOf(card.component({ view: 'page' }))[0] === 'Decider',
    'the bundle page card, which renders outside the shell\u2019s `t` prop, reads the same dictionary')

  // A text field commits on blur, not on every keystroke.
  const url = controlFor(page.component({ view: 'page', form }), 'jev.typesafe.baseURL').find(node => node.type === 'input')
  url.props.onChange({ target: { value: 'https://gateway.test/systemone' } })
  url.props.onBlur({ target: { value: 'https://gateway.test/systemone' } })
  check(writes[1]?.operations?.[0]?.value === 'https://gateway.test/systemone', 'a typed endpoint is written when the field settles')

  // The key itself is typed in, not the name of a credential holding it: one write-only password row,
  // whose empty draft writes nothing because the Host strips a `role('secret')` field from every
  // response and an empty draft therefore means "keep what is stored".
  const key = controlFor(page.component({ view: 'page', form }), 'jev.typesafe.apiKey').find(node => node.type === 'input')
  check(key.props.placeholder === 'sk-…' && key.props.type === 'password' && key.props.autoComplete === 'new-password',
    'the Jev key row is a masked field the browser must not autofill')
  check(key.props.value === '', 'the key field starts blank: a stored key never rides a response')
  key.props.onBlur({ target: { value: '' } })
  check(writes.length === 2, 'an empty key field writes nothing, so whatever is stored survives it')
  key.props.onBlur({ target: { value: 'sk-jev-key' } })
  check(writes[2]?.operations?.[0]?.path?.join('.') === 'jev.typesafe.apiKey'
    && writes[2].operations[0].value === 'sk-jev-key' && writes[2].revision === 7,
  'a pasted Jev key is written to jev.typesafe.apiKey with the revision the page read')

  // The bundle page's card reads the namespace itself, so its write goes through that controller.
  const cardElement = card.component({ view: 'page' })
  check(JSON.stringify(pathsOf(cardElement)) === JSON.stringify(pageFields),
    'the bundle page card draws the same switches as the row page')
  controlFor(cardElement, 'jev.decider').find(node => node.props?.onSelect !== undefined).props.onSelect('chat')
  // The mirror reports TypeSafe deciding, so the pick writes the other one — with the mirror's revision.
  check(JSON.stringify(cardWrites[0]) === JSON.stringify({
    operations: [{ op: 'set', path: ['jev', 'decider'], value: 'chat' }],
    revision: 3,
  }), 'a switch on the bundle page writes through the settings mirror with the revision it read')
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
