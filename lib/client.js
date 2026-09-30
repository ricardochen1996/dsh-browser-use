/**
 * The browser half of the @rc/dsh-browser-use plugin: the right-Sidebar inspector, and the jev
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
 * Only jev's own switches are here. The browser, delegation and timing settings stay profile-patch
 * settings: they decide which tools exist, so a form field for them would promise an immediacy the
 * plugin cannot keep.
 */
window.__ModuleLoader__.load({
  id: '@rc/dsh-browser-use',
  factory: (require) => {
    const React = require('react')
    const { Input, Menu, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    const TAB_ID = 'dsh-browser-use/inspector'
    const KIND = 'browser-use'
    const ROUTE = '/browser-use/'
    /** The bundle's package name, the row id, and the settings namespace are all this row's own. */
    const PACKAGE_NAME = '@rc/dsh-browser-use'
    const ROW_ID = 'dsh-browser-use'
    /** The settings mirror the bundle page's card reads; only injected while the shell provides it. */
    let configForms

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
     * The rows the form shows: where the value lives in the settings namespace, what to call it, and
     * how to edit it. `text` is a one-line string, `password` one the Host redacts, `boolean` a
     * toggle, and `select` one of `options`. A row's text is written as typed; the schema, not this
     * half, decides whether a value is acceptable.
     */
    const GROUPS = [
      {
        id: 'goal',
        title: 'Jev',
        rows: [
          { path: ['jev', 'enabled'], label: '启用 Jev', kind: 'boolean',
            hint: '开启后挂出 browser_goal，browser_act 也可用 intent 让 Jev 选操作、让文本模型写输入值；会花 TypeSafe 与文本模型额度。关闭时不解析、也不传任何 key。' },
        ],
      },
      {
        id: 'source',
        title: '凭据来源',
        rows: [
          { path: ['jev', 'source'], label: '来源', kind: 'select', options: [
            { id: 'session', label: 'session — 继承主会话的路由与 key' },
            { id: 'custom', label: 'custom — 用下面自己填的 URL 与 key' },
          ] },
        ],
      },
      {
        id: 'typesafe',
        title: 'TypeSafe（策略端点）',
        rows: [
          { path: ['jev', 'typesafe', 'baseURL'], label: 'URL', kind: 'text', placeholder: 'https://…/v1/systemone' },
          { path: ['jev', 'typesafe', 'model'], label: 'Model', kind: 'text', placeholder: 'jev-1.13' },
          { path: ['jev', 'typesafe', 'apiKeyEnv'], label: 'API key 凭据名', kind: 'text', placeholder: 'OPENCODE_GATEWAY_API_KEY',
            hint: 'DSH 凭据名（Models 页存的）或环境变量名；custom 来源用。' },
          { path: ['jev', 'typesafe', 'apiKey'], label: 'API key（明文）', kind: 'password',
            hint: '留空表示不改动已存的 key；写入会落在 profile 的 patch 文件里。' },
        ],
      },
      {
        id: 'textModel',
        title: '文本模型（OpenAI 兼容）',
        rows: [
          { path: ['jev', 'textModel', 'baseURL'], label: 'URL', kind: 'text', placeholder: 'https://…/v1' },
          { path: ['jev', 'textModel', 'model'], label: 'Model', kind: 'text', placeholder: 'deepseek-flash',
            hint: 'session 来源下留空 = 用主会话当前的模型。' },
          { path: ['jev', 'textModel', 'apiKeyEnv'], label: 'API key 凭据名', kind: 'text' },
          { path: ['jev', 'textModel', 'apiKey'], label: 'API key（明文）', kind: 'password' },
        ],
      },
    ]

    /** The value at one path of the namespace section, as the Host resolved it. */
    const read = (section, path) => path.reduce((node, key) => (node === null || typeof node !== 'object' ? undefined : node[key]), section)

    /** The text one row holds, for the input that edits it. */
    const textOf = value => (value === undefined || value === null ? '' : String(value))

    /** One setting row: its label on the left, its control on the right, the way the shell draws them. */
    const Field = ({ row, form }) => {
      const stored = read(form.state.value, row.path)
      const [draft, setDraft] = React.useState(() => textOf(stored))
      const [editing, setEditing] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [note, setNote] = React.useState('')
      const shown = editing ? draft : textOf(stored)

      const write = value => {
        setNote('')
        // Secrets never ride a response, so an empty secret input means "leave it as stored".
        if (row.kind === 'password' && value === '') return
        Promise.resolve(form.mutate([{ op: 'set', path: row.path, value }], form.state.revision))
          .then(accepted => { setNote(accepted ? '' : 'Host 拒绝了这次修改') })
          .catch(error => { setNote(String(error?.message ?? error)) })
      }

      const control = (() => {
        if (row.kind === 'boolean') {
          return React.createElement(Switch, {
            checked: stored === true,
            label: row.label,
            onChange: next => { write(next) },
          })
        }
        if (row.kind === 'select') {
          const current = row.options.find(option => option.id === shown) ?? row.options[0]
          return React.createElement(Menu, {
            open: menuOpen,
            onClose: () => { setMenuOpen(false) },
            items: row.options.map(option => ({ id: option.id, label: option.label })),
            selectedId: current?.id,
            align: 'end',
            portal: true,
            onSelect: id => { setMenuOpen(false); write(id) },
            anchor: React.createElement('button', {
              type: 'button',
              className: 'dsh-bu-select',
              'aria-haspopup': 'menu',
              'aria-expanded': menuOpen,
              'aria-label': row.label,
              onClick: () => { setMenuOpen(open => !open) },
            }, React.createElement('span', null, current?.label ?? ''), React.createElement('span', { 'aria-hidden': 'true' }, '▾')),
          })
        }
        return React.createElement(Input, {
          className: 'dsh-bu-input',
          type: row.kind === 'password' ? 'password' : 'text',
          value: shown,
          placeholder: row.placeholder ?? '',
          spellCheck: false,
          'aria-label': row.label,
          onChange: event => { setEditing(true); setDraft(event.target.value) },
          onBlur: event => { setEditing(false); write(event.target.value) },
          onKeyDown: event => { if (event.key === 'Enter') { setEditing(false); write(event.currentTarget.value) } },
        })
      })()

      return React.createElement('div', { className: 'dsh-bu-row' },
        React.createElement('div', { style: { minWidth: 0 } },
          React.createElement('div', { className: 'dsh-bu-label' }, row.label),
          row.hint === undefined ? null : React.createElement('div', { className: 'dsh-bu-hint' }, row.hint),
          note === '' ? null : React.createElement('div', { className: 'dsh-bu-error' }, note),
        ),
        control,
      )
    }

    /** The switches themselves, drawn the same way on the row page and on the bundle page. */
    const Fields = ({ form }) => React.createElement('div', null,
      ...GROUPS.map(group => React.createElement('div', { key: group.id },
        React.createElement('div', { className: 'dsh-bu-group' }, group.title),
        ...group.rows.map(row => React.createElement(Field, { key: row.path.join('.'), row, form })),
      )),
    )

    /** Why a form is not editable here, or `undefined` when it is. */
    const refusal = form => {
      if (form === undefined) {
        return '这个 DSH profile 没有提供 dsh-browser-use 的配置表单：升级 DSH，或直接改 profile 的 cordis.patch.yml。'
      }
      if (form.state.status === 'loading') return '正在读取配置…'
      if (form.state.status === 'unavailable' || !form.state.writable) {
        return '这里只读；请改 profile 的 cordis.patch.yml。'
      }
      return undefined
    }

    /**
     * The row's configuration page, which the Plugins page opens from the row's title. The page
     * owner hands over the form for this row's settings namespace.
     */
    const SwitchForm = (props) => {
      if (props.view !== 'page') return null
      const why = refusal(props.form)
      return why === undefined ? React.createElement(Fields, { form: props.form }) : React.createElement('p', { className: 'dsh-bu-hint' }, why)
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
      const form = { state: snapshot, mutate: (operations, revision) => controller.mutate(operations, revision) }
      const why = refusal(form)
      return why === undefined ? React.createElement(Fields, { form }) : React.createElement('p', { className: 'dsh-bu-hint' }, why)
    }

    /** The page the host serves: address, screenshot, element table, visible text. */
    const BrowserBody = () => React.createElement('iframe', {
      src: ROUTE,
      title: 'Browser agent',
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

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: KIND,
        priority: 'extension',
        title: () => 'Browser agent',
        guide: [{
          id: 'open',
          order: 40,
          title: () => 'Browser agent',
          description: () => 'Watch the page the browser tools are driving.',
          icon: Mark,
        }],
      }), 'dsh-browser-use: tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        BrowserBody,
      )), 'dsh-browser-use: tab body')

      // The Plugins page keys a row's configuration by `<package name>#<row id>`, and hands the page
      // its `form`; registering here is what gives the row title its configure control at all.
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
        { name: 'plugins.row.config', key: `${PACKAGE_NAME}#${ROW_ID}` },
        SwitchForm,
      )), 'dsh-browser-use: row configuration')

      // The same switches on the bundle's own page, which is where a person looking for them lands.
      // Its slot carries no form, so this needs the settings mirror — optional: without it the row
      // page above still edits everything.
      ctx.inject(['configForms'], injected => {
        configForms = injected.configForms
        injected.effect(() => injected.slots.inject('plugins.bundle.config', () => injected.slots.register(
          { name: 'plugins.bundle.config', key: PACKAGE_NAME },
          SwitchCard,
        )), 'dsh-browser-use: bundle configuration')
      })
    }

    return { name: 'dsh-browser-use-client', inject: ['slots', 'sidebarRightTabs'], apply }
  },
})
