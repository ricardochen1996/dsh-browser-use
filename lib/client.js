/**
 * The browser half of the @ricardochen1996/dsh-browser-use plugin: the right-Sidebar inspector, and the jev
 * switch form the Plugins page shows for this plugin's own bundle and row.
 *
 * The web shell loads this file as a classic script and expects it to register itself through
 * `window.__ModuleLoader__.load({ id, factory })` with the package name as `id`. The inspector is
 * one tab whose content is the host route the plugin serves at `/browser-use/`, so the panel keeps
 * working without a build step and without touching the shell's own state.
 *
 * The form is registered twice, because the Plugins page offers two seats and a person should not
 * have to know which one carries it: `plugins.bundle.config` renders on the bundle's own page, and
 * `plugins.row.config` — keyed `<package name>#<row id>` — behind the row title's configure control.
 * Both draw the same rows and write the same paths, and the fields they draw are exactly the ones
 * the Host marks live in `lib/config.js`.
 *
 * Every user-visible string in this half — the tab's title, its guide card, the form's rows, hints
 * and refusals — is a key into the `browserUse` dictionary registered below, so the panel speaks
 * whatever language the shell is in instead of fixing one language into the page. The shell owns
 * the registry and the choice; this half only contributes the two shipped locales.
 *
 * Only jev's own switches are here. The browser, delegation and timing settings stay profile-patch
 * settings: they decide which tools exist, so a form field for them would promise an immediacy the
 * plugin cannot keep.
 */
window.__ModuleLoader__.load({
  id: '@ricardochen1996/dsh-browser-use',
  factory: (require) => {
    const React = require('react')
    const { Input, Menu, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    const TAB_ID = 'dsh-browser-use/inspector'
    const KIND = 'browser-use'
    const ROUTE = '/browser-use/'
    /** The bundle's package name, the row id, and the settings namespace are all this row's own. */
    const PACKAGE_NAME = '@ricardochen1996/dsh-browser-use'
    const ROW_ID = 'dsh-browser-use'
    /** The settings mirror the bundle page's card reads; only injected while the shell provides it. */
    let configForms
    /** The locale namespace this plugin's copy lives in: the tab, the guide card and the settings form. */
    const NS = 'browserUse'

    /**
     * Simplified Chinese copy — the key source of truth: the English dictionary below carries exactly
     * these keys, and `test/inspector.mjs` holds the two in step.
     */
    const zh = {
      'tab.title': '浏览器代理',
      'tab.description': '查看浏览器工具正在操作的页面。',
      'field.decider': '决策者',
      'option.typesafe': 'Jev',
      'option.chat': '文本模型（不需要 Jev key）',
      'hint.decider': 'Jev 常开：browser_goal 与 browser_act 的 intent 一直可用，这里只定由谁回答。选 Jev 就用下面的端点与 key；选文本模型则完全不需要 Jev key，且固定用主会话的路由并关闭推理。两种方式都会花模型额度，但是Jev更快速。',
      'field.jevURL': 'Jev URL',
      'field.jevModel': 'Jev Model',
      'field.jevKeyEnv': 'Jev API key 凭据名',
      'hint.jevKeyEnv': 'DSH 凭据名（Models 页存的）或环境变量名；留空 = 直接花主会话路由的 key。',
      'note.rejected': 'Host 拒绝了这次修改',
      'refuse.noForm': '这个 DSH profile 没有提供 dsh-browser-use 的配置表单：升级 DSH，或直接改 profile 的 cordis.patch.yml。',
      'refuse.loading': '正在读取配置…',
      'refuse.readonly': '这里只读；请改 profile 的 cordis.patch.yml。',
    }

    /** English copy — also what a language this plugin ships no dictionary for falls back to. */
    const en = {
      'tab.title': 'Browser agent',
      'tab.description': 'Watch the page the browser tools are driving.',
      'field.decider': 'Decider',
      'option.typesafe': 'Jev',
      'option.chat': 'Text model (no Jev key needed)',
      'hint.decider': 'Jev is always on: browser_goal and browser_act intents are always available, and this only decides who answers them. Pick Jev to use the endpoint and key below; pick the text model to need no Jev key at all, always using the main conversation route with reasoning off. Both spend model quota, but Jev is faster.',
      'field.jevURL': 'Jev URL',
      'field.jevModel': 'Jev Model',
      'field.jevKeyEnv': 'Jev API key credential',
      'hint.jevKeyEnv': 'A DSH credential name (one saved on the Models page) or an environment variable name; empty = spend the main conversation route\'s key directly.',
      'note.rejected': 'The Host rejected this change',
      'refuse.noForm': 'This DSH profile provides no configuration form for dsh-browser-use: upgrade DSH, or edit the profile\'s cordis.patch.yml.',
      'refuse.loading': 'Reading configuration…',
      'refuse.readonly': 'Read-only here; edit the profile\'s cordis.patch.yml.',
    }

    /**
     * The translator the tab's thunks and any component without the shell's own `t` seat render with.
     * `apply` replaces it with the locale service's binding for {@link NS}; until then — and in a test
     * that renders a component directly — the English copy stands in. Either reader resolves the
     * active language at call time, so a switch needs no re-registration, and the settings rows get
     * the shell's synthesized seat instead (their registrations declare the namespace).
     */
    let bound = key => en[key] ?? key

    /**
     * What inline styles cannot express — hover, the input width inside the Input wrapper — stated
     * in the shell's own tokens so the form follows the theme it is drawn in.
     */
    const STYLE_ID = 'dsh-browser-use-config'
    const ensureStyle = () => {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.dsh-bu-group{font-size:12px;color:var(--dsw-alias-label-secondary);margin:16px 0 2px}',
        '.dsh-bu-group:first-child{margin-top:0}',
        '.dsh-bu-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:40px}',
        '.dsh-bu-label{font-size:13px;color:var(--dsw-alias-label-primary)}',
        '.dsh-bu-hint{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
        '.dsh-bu-error{font-size:12px;color:var(--dsw-alias-state-error-primary);margin-top:2px}',
        '.dsh-bu-input{width:280px;flex:none}',
        '.dsh-bu-input input{width:100%}',
        '.dsh-bu-select{display:inline-flex;align-items:center;gap:6px;max-width:280px;height:28px;padding:0 10px;',
        'border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);',
        'color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}',
        '.dsh-bu-select:hover{background:var(--dsw-alias-bg-layer-2)}',
      ].join('')
      document.head.appendChild(style)
    }

    /**
     * The rows the form shows: where the value lives in the settings namespace, which dictionary key
     * names it, and how to edit it. `text` is a one-line string, `password` one the Host redacts,
     * `boolean` a toggle, and `select` one of `options`. A row's text is written as typed; the schema,
     * not this half, decides whether a value is acceptable.
     *
     * Labels, hints and option labels are keys, resolved at render: a language switch must not require
     * re-registering anything, and one key per string keeps the dictionaries in step.
     *
     * Deliberately one choice and the endpoint it may need — and no switch to turn Jev off, because
     * there is nothing to turn off: the tools are part of the plugin, and the only question a person
     * has is which of two models answers them. The text model is not a field either — the main
     * conversation already has a route, so asking for a second endpoint and key here would only be a
     * way to get them wrong. A profile patch can still override it (`jev.textModel.*`, `jev.source`),
     * and can withdraw the tools with `jev.enabled: false`.
     */
    const GROUPS = [
      {
        id: 'goal',
        rows: [
          { path: ['jev', 'decider'], label: 'field.decider', kind: 'select', options: [
            { id: 'typesafe', label: 'option.typesafe' },
            { id: 'chat', label: 'option.chat' },
          ], hint: 'hint.decider' },
        ],
      },
      {
        id: 'typesafe',
        rows: [
          { path: ['jev', 'typesafe', 'baseURL'], label: 'field.jevURL', kind: 'text', placeholder: 'https://…/v1/systemone' },
          { path: ['jev', 'typesafe', 'model'], label: 'field.jevModel', kind: 'text', placeholder: 'jev-1.13' },
          { path: ['jev', 'typesafe', 'apiKeyEnv'], label: 'field.jevKeyEnv', kind: 'text', placeholder: 'OPENCODE_GATEWAY_API_KEY',
            hint: 'hint.jevKeyEnv' },
        ],
      },
    ]

    /** The value at one path of the namespace section, as the Host resolved it. */
    const read = (section, path) => path.reduce((node, key) => (node === null || typeof node !== 'object' ? undefined : node[key]), section)

    /** The text one row holds, for the input that edits it. */
    const textOf = value => (value === undefined || value === null ? '' : String(value))

    /** One setting row: its label on the left, its control on the right, the way the shell draws them. */
    const Field = ({ row, form, t }) => {
      const stored = read(form.state.value, row.path)
      const [draft, setDraft] = React.useState(() => textOf(stored))
      const [editing, setEditing] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [note, setNote] = React.useState('')
      const shown = editing ? draft : textOf(stored)
      const label = t(row.label)

      const write = value => {
        setNote('')
        // Secrets never ride a response, so an empty secret input means "leave it as stored".
        if (row.kind === 'password' && value === '') return
        Promise.resolve(form.mutate([{ op: 'set', path: row.path, value }], form.state.revision))
          .then(accepted => { setNote(accepted ? '' : t('note.rejected')) })
          .catch(error => { setNote(String(error?.message ?? error)) })
      }

      const control = (() => {
        if (row.kind === 'boolean') {
          return React.createElement(Switch, {
            checked: stored === true,
            label,
            onChange: next => { write(next) },
          })
        }
        if (row.kind === 'select') {
          const current = row.options.find(option => option.id === shown) ?? row.options[0]
          return React.createElement(Menu, {
            open: menuOpen,
            onClose: () => { setMenuOpen(false) },
            items: row.options.map(option => ({ id: option.id, label: t(option.label) })),
            selectedId: current?.id,
            align: 'end',
            portal: true,
            onSelect: id => { setMenuOpen(false); write(id) },
            anchor: React.createElement('button', {
              type: 'button',
              className: 'dsh-bu-select',
              'aria-haspopup': 'menu',
              'aria-expanded': menuOpen,
              'aria-label': label,
              onClick: () => { setMenuOpen(open => !open) },
            }, React.createElement('span', null, current === undefined ? '' : t(current.label)),
            React.createElement('span', { 'aria-hidden': 'true' }, '▾')),
          })
        }
        return React.createElement(Input, {
          className: 'dsh-bu-input',
          type: row.kind === 'password' ? 'password' : 'text',
          value: shown,
          placeholder: row.placeholder ?? '',
          spellCheck: false,
          'aria-label': label,
          onChange: event => { setEditing(true); setDraft(event.target.value) },
          onBlur: event => { setEditing(false); write(event.target.value) },
          onKeyDown: event => { if (event.key === 'Enter') { setEditing(false); write(event.currentTarget.value) } },
        })
      })()

      return React.createElement('div', { className: 'dsh-bu-row' },
        React.createElement('div', { style: { minWidth: 0 } },
          React.createElement('div', { className: 'dsh-bu-label' }, label),
          row.hint === undefined ? null : React.createElement('div', { className: 'dsh-bu-hint' }, t(row.hint)),
          note === '' ? null : React.createElement('div', { className: 'dsh-bu-error' }, note),
        ),
        control,
      )
    }

    /** The switches themselves, drawn the same way on the row page and on the bundle page. */
    const Fields = ({ form, t }) => React.createElement('div', null,
      ...GROUPS.map(group => React.createElement('div', { key: group.id },
        React.createElement('div', { className: 'dsh-bu-group' }, group.title),
        ...group.rows.map(row => React.createElement(Field, { key: row.path.join('.'), row, form, t })),
      )),
    )

    /** Why a form is not editable here, or `undefined` when it is. */
    const refusal = (form, t) => {
      if (form === undefined) {
        return t('refuse.noForm')
      }
      if (form.state.status === 'loading') return t('refuse.loading')
      if (form.state.status === 'unavailable' || !form.state.writable) {
        return t('refuse.readonly')
      }
      return undefined
    }

    /**
     * The row's configuration page, which the Plugins page opens from the row's title. The page
     * owner hands over the form for this row's settings namespace, and the renderer — the entry
     * declares this plugin's locale namespace — hands over the `t` seat it derived at the current
     * revision, so a language switch re-renders these rows with the new copy.
     */
    const SwitchForm = (props) => {
      if (props.view !== 'page') return null
      const t = props.t ?? bound
      const why = refusal(props.form, t)
      return why === undefined ? React.createElement(Fields, { form: props.form, t }) : React.createElement('p', { className: 'dsh-bu-hint' }, why)
    }

    /**
     * The same switches on the bundle's own page, which is the page a person lands on. Its slot
     * carries no form, so this reads the namespace itself and re-renders on every accepted write.
     */
    const SwitchCard = (props) => {
      // The hooks run before the view check: a component may not skip one on a later render.
      const controller = configForms.get(ROW_ID)
      const snapshot = React.useSyncExternalStore(
        listener => controller.subscribe(listener),
        () => controller.getSnapshot(),
      )
      if (props.view !== 'page') return null
      const t = props.t ?? bound
      const form = { state: snapshot, mutate: (operations, revision) => controller.mutate(operations, revision) }
      const why = refusal(form, t)
      return why === undefined ? React.createElement(Fields, { form, t }) : React.createElement('p', { className: 'dsh-bu-hint' }, why)
    }

    /** The page the host serves: address, screenshot, element table, visible text. */
    const BrowserBody = () => React.createElement('iframe', {
      src: ROUTE,
      title: bound('tab.title'),
      style: { width: '100%', height: '100%', border: '0', background: '#fff' },
    })

    /** A small mark for the guide card, drawn with the current text colour. */
    const Mark = () => React.createElement(
      'svg',
      { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
      React.createElement('rect', { x: 3, y: 4, width: 18, height: 15, rx: 2 }),
      React.createElement('path', { d: 'M3 9h18M7 13h5M7 16h3' }),
    )

    const apply = (ctx) => {
      ensureStyle()

      // The copy first: the shell's own language picker may already be on a locale this dictionary
      // answers, and a dictionary registered after a render still bumps the registry's revision, so
      // mounted rows pick it up either way. `bind` then reads the active language at call time.
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-browser-use: locale dictionaries')
      bound = ctx.locale.bind(NS)

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: KIND,
        priority: 'extension',
        title: () => bound('tab.title'),
        guide: [{
          id: 'open',
          order: 40,
          title: () => bound('tab.title'),
          description: () => bound('tab.description'),
          icon: Mark,
        }],
      }), 'dsh-browser-use: tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        BrowserBody,
      )), 'dsh-browser-use: tab body')

      // The Plugins page keys a row's configuration by `<package name>#<row id>`, and hands the page
      // its `form`; registering here is what gives the row title its configure control at all. The
      // `locale` declaration is what puts the renderer's `t` seat on the component's props.
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
        { name: 'plugins.row.config', key: `${PACKAGE_NAME}#${ROW_ID}`, locale: NS },
        SwitchForm,
      )), 'dsh-browser-use: row configuration')

      // The same switches on the bundle's own page, which is where a person looking for them lands.
      // Its slot carries no form, so this needs the settings mirror — optional: without it the row
      // page above still edits everything.
      ctx.inject(['configForms'], injected => {
        configForms = injected.configForms
        injected.effect(() => injected.slots.inject('plugins.bundle.config', () => injected.slots.register(
          { name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS },
          SwitchCard,
        )), 'dsh-browser-use: bundle configuration')
      })
    }

    return { name: 'dsh-browser-use-client', inject: ['slots', 'sidebarRightTabs', 'locale'], apply }
  },
})
