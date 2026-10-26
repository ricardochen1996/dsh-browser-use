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
 * The connection switches and jev's own switches are here, because they are the fields `lib/config.js`
 * marks live: how a Session reaches a browser (`mode`, `attachSharing`) is the first question a person
 * has, and it is re-read at the next `browser_open` rather than when the plugin applies. The browser,
 * delegation and timing settings stay profile-patch settings: they decide which tools exist, so a form
 * field for them would promise an immediacy the plugin cannot keep.
 */
window.__ModuleLoader__.load({
  id: '@ricardochen1996/dsh-browser-use',
  factory: (require) => {
    const React = require('react')
    const { Button, Input, Menu, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { IconRefreshOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')

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
      'field.mode': '连接方式',
      'option.launch': '启动独立浏览器（launch）',
      'option.attach': '驱动已打开的 Chrome（attach）',
      'hint.mode': 'launch：插件自己启动一个只属于本会话的浏览器；attach：接管你正在用的 Chrome（需先在 chrome://inspect/#remote-debugging 允许远程调试）。改动对下一次 browser_open 生效。',
      'field.attachSharing': '共享方式',
      'option.exclusive': '独占（只给第一个活跃会话）',
      'option.shared': '共享（每个会话各开一个标签页）',
      'hint.attachSharing': '仅 attach 模式可选：独占把浏览器留给第一个活跃会话；共享时每个会话各开自己的标签页，互不抢页面。launch 模式下固定为独占。',
      'field.decider': '决策者',
      'option.typesafe': 'Jev',
      'option.chat': '文本模型（不需要 Jev key）',
      'hint.decider': 'Jev 常开，这里只决定由谁回答：Jev 用下面的端点与密钥；文本模型不需要 Jev key，固定走主会话路由、关闭推理。',
      'field.jevURL': 'Jev URL',
      'field.jevModel': 'Jev Model',
      'field.jevKey': 'Jev 密钥',
      'hint.jevKey': '只写不读：保存后不再回显；留空表示保留已存密钥（没有就用主会话路由的 key）。',
      'update.check': '检查更新',
      'update.checking': '正在检查…',
      'update.updateTo': '更新到',
      'update.updating': '更新中',
      'update.updated': '已更新到',
      'update.refresh': '刷新界面',
      'update.restart': '重启 DSH 后生效',
      'update.failed': '更新失败',
      'update.busyAgent': '有 agent 在运行，稍后再试',
      'update.busyOther': '另一个更新正在进行',
      'update.tooFresh': '新版本发布未满发布年龄限制',
      'update.retry': '重试',
      'update.force': '强制更新',
      'update.upToDate': '已是最新版本',
      'note.saved': '已写入',
      'note.rejected': 'Host 拒绝了这次修改',
      'refuse.noForm': '这个 DSH profile 没有提供 dsh-browser-use 的配置表单：升级 DSH，或直接改 profile 的 cordis.patch.yml。',
      'refuse.loading': '正在读取配置…',
      'refuse.readonly': '这里只读；请改 profile 的 cordis.patch.yml。',
    }

    /** English copy — also what a language this plugin ships no dictionary for falls back to. */
    const en = {
      'tab.title': 'Browser agent',
      'tab.description': 'Watch the page the browser tools are driving.',
      'field.mode': 'Connection',
      'option.launch': 'Launch its own browser (launch)',
      'option.attach': 'Drive the Chrome you use (attach)',
      'hint.mode': 'launch starts a browser that belongs to this Session alone; attach takes over the Chrome you are using (allow remote debugging at chrome://inspect/#remote-debugging). Applies at the next browser_open.',
      'field.attachSharing': 'Sharing',
      'option.exclusive': 'Exclusive (the first live Session)',
      'option.shared': 'Shared (a tab each)',
      'hint.attachSharing': 'Attach mode only: exclusive keeps the browser for the first live Session; shared gives each Session its own tab. Fixed to exclusive in launch mode.',
      'field.decider': 'Decider',
      'option.typesafe': 'Jev',
      'option.chat': 'Text model (no Jev key needed)',
      'hint.decider': 'Jev is always on; this only chooses who answers: Jev uses the endpoint and key below, while the text model needs no Jev key and uses the main conversation route, with reasoning off.',
      'field.jevURL': 'Jev URL',
      'field.jevModel': 'Jev Model',
      'field.jevKey': 'Jev API key',
      'hint.jevKey': 'Write-only: never echoed back. Leave empty to keep a stored key, or spend the main route\'s key when none is stored.',
      'update.check': 'Check for updates',
      'update.checking': 'Checking…',
      'update.updateTo': 'Update to',
      'update.updating': 'Updating',
      'update.updated': 'Updated to',
      'update.refresh': 'Refresh UI',
      'update.restart': 'Restart DSH to apply',
      'update.failed': 'Update failed',
      'update.busyAgent': 'An agent is running — retry later',
      'update.busyOther': 'Another update is in progress',
      'update.tooFresh': 'The new release is still in its age hold',
      'update.retry': 'Retry',
      'update.force': 'Force update',
      'update.upToDate': 'Up to date',
      'note.saved': 'Saved',
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
     * What inline styles cannot express — hover, focus, the narrow-window stack — stated in the
     * shell's own tokens so the form follows the theme it is drawn in.
     *
     * A row is a two-column grid whose second track is the 280px control column. The track is fixed
     * on purpose: the hints are long paragraphs, and a flexbox row sized those to their max-content
     * width and then shrank the control, which wrapped a select's label inside the control's own
     * height — the misalignment this form used to show. The label and the control share the first
     * line (`align-items:center`), and each hint sits under the label in the first column, where a
     * wide window leaves it readable and a narrow one wraps it without moving the control.
     */
    const STYLE_ID = 'dsh-browser-use-config'
    /** Every rule this half injects, in one place so a rewritten tag is the whole style. */
    const RULES = [
      '.dsh-bu-form{display:flex;flex-direction:column}',
      '.dsh-bu-group + .dsh-bu-group{margin-top:20px}',
      '.dsh-bu-row{display:grid;grid-template-columns:minmax(0,1fr) 280px;column-gap:24px;align-items:center;padding:8px 0}',
      '.dsh-bu-label{grid-column:1;grid-row:1;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-bu-control{grid-column:2;grid-row:1;display:flex;align-items:center;justify-content:flex-end;min-width:0}',
      '.dsh-bu-control > *{flex:1 1 auto;min-width:0;max-width:280px}',
      '.dsh-bu-anchor{width:100%}',
      '.dsh-bu-hint{grid-column:1;grid-row:2;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.dsh-bu-note{grid-column:1;grid-row:3;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}',
      '.dsh-bu-error{grid-column:1;grid-row:3;margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      // A select and a text input share the column, so they draw the same box: 32px high, one
      // line, the label ellipsized rather than wrapped when it cannot fit. The Input primitive's
      // wrapper adds padding and a border on top of its width, so `border-box` keeps the text
      // field exactly as wide as the select beside it.
      '.dsh-bu-input{box-sizing:border-box;width:100%;flex:none}',
      '.dsh-bu-input input{width:100%}',
      '.dsh-bu-select{display:flex;align-items:center;justify-content:space-between;gap:8px;box-sizing:border-box;width:100%;height:32px;padding:0 10px;',
      'border:0.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;white-space:nowrap;cursor:pointer}',
      '.dsh-bu-select > span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-bu-select:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-bu-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      // A row another switch has to unlock first: it still shows the stored value, and says why it
      // cannot be changed from here rather than looking broken.
      '.dsh-bu-select:disabled{opacity:.55;cursor:default}',
      // The plugin page's actions row. The shell draws its own buttons beside this control, so it
      // is only the short text and the error line that need a rule here.
      '.dsh-bu-update{display:inline-flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-bu-update-error{color:var(--dsw-alias-state-error-primary)}',
      // Below the shell's content width the two columns can no longer share a line comfortably,
      // so the control moves under the label and takes the form's full width.
      '@media (max-width:720px){',
      '.dsh-bu-row{grid-template-columns:minmax(0,1fr)}',
      '.dsh-bu-control{grid-column:1;grid-row:2;margin-top:8px}',
      '.dsh-bu-control > *{max-width:none}',
      '.dsh-bu-hint{grid-row:3}',
      '.dsh-bu-note,.dsh-bu-error{grid-row:4}',
      '}',
    ].join('')

    /**
     * Put this bundle's rules into the document. An existing tag is rewritten in place rather than
     * left alone: DSH can hot-swap a changed client bundle into a live page, and the rules that
     * bundle's previous generation injected have to be replaced with these, not shadowed by them.
     */
    const ensureStyle = () => {
      if (typeof document === 'undefined') return
      let style = document.getElementById(STYLE_ID)
      if (style === null) {
        style = document.createElement('style')
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      style.textContent = RULES
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
     *
     * The connection group comes first because it is the first question: how this Session reaches a
     * browser at all. Both rows write live fields, so the next `browser_open` honours them.
     * `attachSharing` is refused while `mode` is `launch` — the schema rejects that pair, so opening a
     * menu of values it would reject would only produce a refusal; and the reverse edit, moving `mode`
     * back to `launch` while sharing is `shared`, carries the reset with it (`alsoWrite`) so the pair
     * the person asked for is one write and one valid configuration, never a rejected half.
     *
     * The Jev key is the one `password` row: the Host strips `role('secret')` fields from every
     * response, so it always starts blank, a blank draft writes nothing (the stored key survives), and
     * the key a person pastes is the only thing that ever crosses that field's wire.
     */
    const GROUPS = [
      {
        id: 'connection',
        rows: [
          { path: ['mode'], label: 'field.mode', kind: 'select', options: [
            { id: 'launch', label: 'option.launch' },
            { id: 'attach', label: 'option.attach' },
          ], hint: 'hint.mode',
          alsoWrite: (value, section) => value === 'attach' || read(section, ['attachSharing']) !== 'shared'
            ? []
            : [{ op: 'set', path: ['attachSharing'], value: 'exclusive' }] },
          { path: ['attachSharing'], label: 'field.attachSharing', kind: 'select', options: [
            { id: 'exclusive', label: 'option.exclusive' },
            { id: 'shared', label: 'option.shared' },
          ], hint: 'hint.attachSharing',
          enabledWhen: section => read(section, ['mode']) === 'attach' },
        ],
      },
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
          { path: ['jev', 'typesafe', 'apiKey'], label: 'field.jevKey', kind: 'password', placeholder: 'sk-…',
            hint: 'hint.jevKey' },
        ],
      },
    ]

    /** The value at one path of the namespace section, as the Host resolved it. */
    const read = (section, path) => path.reduce((node, key) => (node === null || typeof node !== 'object' ? undefined : node[key]), section)

    /** The text one row holds, for the input that edits it. */
    const textOf = value => (value === undefined || value === null ? '' : String(value))

    /**
     * One setting row: its label at the start of the line, its control in the form's fixed control
     * column, and its hint under the label. The shell's own settings rows read this way.
     */
    const Field = ({ row, form, t }) => {
      const stored = read(form.state.value, row.path)
      const [draft, setDraft] = React.useState(() => textOf(stored))
      const [editing, setEditing] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const shown = editing ? draft : textOf(stored)
      const label = t(row.label)
      /** A row whose value only makes sense once another one is set, and would be refused before it. */
      const blocked = row.enabledWhen !== undefined && !row.enabledWhen(form.state.value)

      const write = value => {
        setNote(null)
        // Secrets never ride a response, so an empty secret input means "leave it as stored".
        if (row.kind === 'password' && value === '') return
        // A write can have to carry a second value: the schema refuses some pairs, and writing one
        // half alone would hand the person a refusal instead of the change they asked for.
        const extra = row.alsoWrite === undefined ? [] : row.alsoWrite(value, form.state.value)
        Promise.resolve(form.mutate([{ op: 'set', path: row.path, value }, ...extra], form.state.revision))
          // A secret comes back empty, so a saved key would otherwise look like nothing happened.
          .then(accepted => {
            if (!accepted) setNote({ tone: 'error', text: t('note.rejected') })
            else if (row.kind === 'password') setNote({ tone: 'saved', text: t('note.saved') })
          })
          .catch(error => { setNote({ tone: 'error', text: String(error?.message ?? error) }) })
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
          if (blocked) {
            // One switch depends on another: refuse the control instead of opening a menu of values
            // the schema would reject. The row's hint says which switch has to move first.
            return React.createElement('button', {
              type: 'button',
              className: 'dsh-bu-select',
              disabled: true,
              'aria-disabled': 'true',
              'aria-label': label,
              title: t(row.hint ?? ''),
            }, React.createElement('span', null, current === undefined ? '' : t(current.label)))
          }
          return React.createElement(Menu, {
            open: menuOpen,
            onClose: () => { setMenuOpen(false) },
            items: row.options.map(option => ({ id: option.id, label: t(option.label) })),
            selectedId: current?.id,
            align: 'end',
            portal: true,
            className: 'dsh-bu-anchor',
            onSelect: id => { setMenuOpen(false); write(id) },
            anchor: React.createElement('button', {
              type: 'button',
              className: 'dsh-bu-select',
              'aria-haspopup': 'menu',
              'aria-expanded': menuOpen,
              'aria-label': label,
              title: current === undefined ? undefined : t(current.label),
              onClick: () => { setMenuOpen(open => !open) },
            }, React.createElement('span', null, current === undefined ? '' : t(current.label)),
            React.createElement('span', { 'aria-hidden': 'true' }, '▾')),
          })
        }
        return React.createElement(Input, {
          className: 'dsh-bu-input',
          type: row.kind === 'password' ? 'password' : 'text',
          // A secret is typed once, on purpose: no browser password manager may fill it in.
          ...(row.kind === 'password' ? { autoComplete: 'new-password' } : {}),
          value: shown,
          placeholder: row.placeholder ?? '',
          spellCheck: false,
          'aria-label': label,
          onChange: event => { setEditing(true); setDraft(event.target.value) },
          onBlur: event => { setEditing(false); write(event.target.value) },
          onKeyDown: event => { if (event.key === 'Enter') { setEditing(false); write(event.currentTarget.value) } },
        })
      })()

      // The label and its control share the first line of the grid; the hint and the write note
      // stack under the label, so a long explanation never moves the control or changes its width.
      return React.createElement('div', { className: 'dsh-bu-row' },
        React.createElement('div', { className: 'dsh-bu-label' }, label),
        React.createElement('div', { className: 'dsh-bu-control' }, control),
        row.hint === undefined ? null : React.createElement('div', { className: 'dsh-bu-hint' }, t(row.hint)),
        note === null ? null
          : React.createElement('div', { className: note.tone === 'saved' ? 'dsh-bu-note' : 'dsh-bu-error' }, note.text),
      )
    }

    /** The switches themselves, drawn the same way on the row page and on the bundle page. */
    const Fields = ({ form, t }) => React.createElement('div', { className: 'dsh-bu-form' },
      ...GROUPS.map(group => React.createElement('div', { key: group.id, className: 'dsh-bu-group' },
        ...group.rows.map(row => React.createElement(Field, { key: row.path.join('.'), row, form, t })),
      )),
    )

    /**
     * The plugin page's update control. dshmarket publishes a versioned, same-origin update API for
     * plugin-owned surfaces (`UPDATE-API-V1.md` in that package), so this half asks it whether a
     * newer release of this bundle is installable and drives the install through it. Everything —
     * envelope, endpoints, restart ownership — is discovered from the capabilities answer; a Host
     * that does not mount the market has none of these routes, and the control does not appear.
     */
    const UPDATE_API_CAPABILITIES = '/dsh-market/api/v1/capabilities'
    const UPDATE_API_SCHEMA = 'dsh-market/update-api/v1'

    /**
     * Read one JSON body from the market, or `undefined` when the answer is not the versioned
     * envelope this control knows. A network failure is the caller's to read as "no market here".
     */
    const readMarketJson = async (fetchImpl, url, init) => {
      const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', ...init })
      const body = await response.json().catch(() => undefined)
      return body !== null && typeof body === 'object' && body.schema === UPDATE_API_SCHEMA ? body : undefined
    }

    /**
     * The update state one plugin page reads: the check, the install it offers, its progress and its
     * end. Instances are self-contained — the component mounts the singleton below, and
     * `test/inspector.mjs` builds its own with a recording fetch, so every state the page can draw
     * is checked without a market.
     */
    const createUpdateStore = ({
      fetch: fetchImpl = (...args) => fetch(...args),
      wait = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds) }),
      packageName = PACKAGE_NAME,
    } = {}) => {
      let state = { phase: 'checking' }
      const listeners = new Set()
      let capabilities
      let started = false
      /** The installed version the open page reports; a market answer that disagrees is its cache. */
      let pageVersion
      const publish = next => {
        state = { ...state, ...next }
        for (const listener of [...listeners]) listener()
      }
      const subscribe = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
      const getSnapshot = () => state

      /** The market's endpoints, once per page: its presence cannot change without a reload. */
      const discover = async () => {
        if (capabilities !== undefined) return capabilities
        try {
          const body = await readMarketJson(fetchImpl, UPDATE_API_CAPABILITIES)
          const endpoints = body?.endpoints
          if (body?.features?.check === true
            && typeof endpoints?.updates === 'string' && typeof endpoints?.operations === 'string') {
            capabilities = { updates: endpoints.updates, operations: endpoints.operations }
            return capabilities
          }
        } catch {
          // No market mounted, or its routes are not reachable from this page: hide the control.
        }
        return undefined
      }

      /**
       * Ask whether a newer release exists; `force` bypasses the market's own short cache. A cached
       * answer that names a different installed version than the page shows is stale — after an
       * update, or a package edited on disk — and is re-asked once with `force`, because the page's
       * own version comes from the Host and is the present truth.
       */
      const check = async (force = false, rechecked = false) => {
        if (state.phase === 'updating') return
        publish({ phase: 'checking', failure: undefined })
        const api = await discover()
        if (api === undefined) {
          publish({ phase: 'unavailable' })
          return
        }
        try {
          const query = `?name=${encodeURIComponent(packageName)}${force ? '&force=1' : ''}`
          const info = (await readMarketJson(fetchImpl, `${api.updates}${query}`))?.package
          if (info === undefined || typeof info.latestVersion !== 'string') {
            publish({ phase: 'unavailable' })
            return
          }
          if (!rechecked && pageVersion !== undefined && typeof info.installedVersion === 'string'
            && info.installedVersion !== pageVersion) {
            await check(true, true)
            return
          }
          publish({
            phase: info.updateAvailable === true && info.latestVersion !== info.installedVersion
              && info.latestVersion !== pageVersion ? 'available' : 'current',
            installedVersion: typeof info.installedVersion === 'string' ? info.installedVersion : undefined,
            latestVersion: info.latestVersion,
          })
        } catch {
          publish({ phase: 'unavailable' })
        }
      }

      /** Follow one accepted operation until it settles, publishing the progress it reports. */
      const poll = async (api, operationId) => {
        for (let attempt = 0; attempt < 240; attempt += 1) {
          await wait(attempt === 0 ? 600 : 1200)
          let operation
          try {
            const body = await readMarketJson(fetchImpl, `${api.operations}?operationId=${encodeURIComponent(operationId)}`)
            operation = body?.operation
          } catch {
            operation = undefined
          }
          if (operation === undefined || typeof operation.state !== 'string') {
            publish({
              phase: 'failed', progress: undefined,
              failure: { code: 'UPDATE_UNREADABLE', message: 'the update operation could not be read', retryable: true },
            })
            return
          }
          if (operation.state === 'succeeded') {
            publish({
              phase: 'succeeded',
              progress: undefined,
              installedVersion: typeof operation.installedVersion === 'string' ? operation.installedVersion : state.latestVersion,
              refreshRequired: operation.outcome?.refreshRequired === true,
              restartRequired: operation.outcome?.restartRequired === true,
            })
            return
          }
          if (operation.state === 'failed' || operation.state === 'cancelled' || operation.state === 'rolled-back') {
            publish({
              phase: 'failed', progress: undefined,
              failure: operation.failure ?? {
                code: operation.state === 'cancelled' ? 'UPDATE_CANCELLED' : 'UPDATE_FAILED',
                message: 'the update did not complete',
                retryable: operation.state === 'cancelled',
              },
            })
            return
          }
          publish({ phase: 'updating', progress: operation.progress })
        }
        publish({
          phase: 'failed', progress: undefined,
          failure: { code: 'UPDATE_TIMEOUT', message: 'the update is still running', retryable: true },
        })
      }

      /** Start the update and follow it; a refusal is published with the code the market named. */
      const start = async (force = false) => {
        if (state.phase === 'updating') return
        publish({ phase: 'updating', failure: undefined, progress: undefined })
        const api = await discover()
        if (api === undefined) {
          publish({ phase: 'unavailable' })
          return
        }
        try {
          const body = await readMarketJson(fetchImpl, api.updates, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ packageName, ...(force ? { force: true } : {}) }),
          })
          const operation = body?.operation
          if (operation === undefined || typeof operation.operationId !== 'string') {
            publish({
              phase: 'failed', progress: undefined,
              failure: body?.failure ?? { code: 'UPDATE_REFUSED', message: 'the update was refused', retryable: true },
            })
            return
          }
          publish({ phase: 'updating', progress: operation.progress })
          await poll(api, operation.operationId)
        } catch (error) {
          publish({
            phase: 'failed', progress: undefined,
            failure: { code: 'UPDATE_FAILED', message: String(error?.message ?? error), retryable: true },
          })
        }
      }

      return {
        subscribe,
        getSnapshot,
        /**
         * Run the first check once per page; later mounts read the state the first one produced.
         * The page passes the installed version it draws, so a stale market cache can be spotted.
         */
        ensureStarted: (installedVersion) => {
          if (typeof installedVersion === 'string') pageVersion = installedVersion
          if (started) return Promise.resolve()
          started = true
          return check(false)
        },
        check,
        start,
      }
    }

    /** The state the plugin page reads; one per loaded bundle, because an update outlives one page view. */
    const updateStore = createUpdateStore()

    /** The shell's update button draws a refresh glyph; this control uses the same one. */
    const updateIcon = () => React.createElement(IconRefreshOutlineRegular, { size: 13 })

    /**
     * The actions-row control the Plugins page renders beside Uninstall: a check that becomes an
     * install offer when a newer release exists, then the progress and the outcome of installing it.
     * It decides from the page's subject, so another bundle's page never shows it.
     */
    const UpdateAction = (props) => {
      const t = props.t ?? bound
      const subject = props.subject
      const ours = (subject?.kind === 'bundle' || subject?.kind === 'row') && subject.pkg?.name === PACKAGE_NAME
      const installedVersion = ours ? subject.pkg?.version : undefined
      const state = React.useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot)
      React.useEffect(() => {
        if (ours) void updateStore.ensureStarted(installedVersion)
      }, [ours, installedVersion])
      if (!ours) return null
      const check = force => { void updateStore.check(force === true) }
      const update = force => { void updateStore.start(force === true) }
      const refresh = () => {
        if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') window.location.reload()
      }
      const button = (label, onClick, extra = {}) => React.createElement(Button,
        { size: 'sm', variant: 'outline', ...extra, onClick }, label)
      const failure = state.failure
      const failureText = failure?.code === 'AGENTS_RUNNING'
        ? t('update.busyAgent')
        : failure?.code === 'OPERATION_BUSY'
          ? t('update.busyOther')
          : failure?.code === 'RELEASE_TOO_FRESH' || failure?.code === 'VERSION_UNCHANGED'
            ? t('update.tooFresh')
            : t('update.failed')
      let content
      if (state.phase === 'available') {
        content = [button(`${t('update.updateTo')} v${state.latestVersion}`, () => { update(false) }, { icon: updateIcon() })]
      } else if (state.phase === 'current') {
        content = [button(t('update.check'), () => { check(true) }, { icon: updateIcon(), title: t('update.upToDate') })]
      } else if (state.phase === 'updating') {
        const percent = state.progress?.percent
        content = [button(typeof percent === 'number' ? `${t('update.updating')} ${percent}%` : t('update.updating'), undefined, { disabled: true })]
      } else if (state.phase === 'succeeded') {
        content = [
          React.createElement('span', { key: 'done' }, `${t('update.updated')} v${state.installedVersion ?? ''}`),
          state.refreshRequired ? button(t('update.refresh'), refresh, { key: 'refresh', icon: updateIcon() }) : null,
          state.restartRequired ? React.createElement('span', { key: 'restart' }, t('update.restart')) : null,
          !state.refreshRequired && !state.restartRequired
            ? button(t('update.check'), () => { check(true) }, { key: 'again' })
            : null,
        ]
      } else if (state.phase === 'failed') {
        const forceable = failure?.code === 'RELEASE_TOO_FRESH' || failure?.code === 'VERSION_UNCHANGED'
        content = [
          React.createElement('span', {
            key: 'failed', className: 'dsh-bu-update-error', title: failure?.message,
          }, failureText),
          button(t('update.retry'), () => { update(false) }, { key: 'retry' }),
          forceable ? button(t('update.force'), () => { update(true) }, { key: 'force' }) : null,
        ]
      } else if (state.phase === 'checking') {
        content = [button(t('update.checking'), undefined, { disabled: true, icon: updateIcon() })]
      } else {
        return null
      }
      return React.createElement('span', { className: 'dsh-bu-update' }, ...content)
    }

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

      // The bundle page's actions row: this plugin's own update check and install, driven by the
      // Market's public update API. The slot hands every contribution the open page's subject, and
      // the control hides itself for any bundle that is not this package.
      ctx.effect(() => ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register(
        { name: 'plugins.detail.actions', id: 'dsh-browser-use/update', order: 40, locale: NS },
        UpdateAction,
      )), 'dsh-browser-use: update control')

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

    // `marketUpdates` is the update store's factory, returned for `test/inspector.mjs` only: Cordis
    // reads `name`, `inject` and `apply`, and an offline check can drive the same states the page
    // draws without a market or a browser.
    return { name: 'dsh-browser-use-client', inject: ['slots', 'sidebarRightTabs', 'locale'], apply, marketUpdates: createUpdateStore }
  },
})
