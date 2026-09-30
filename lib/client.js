/**
 * The right-Sidebar half of the @rc/dsh-browser-use plugin.
 *
 * The web shell loads this file as a classic script and expects it to register itself through
 * `window.__ModuleLoader__.load({ id, factory })` with the package name as `id`. The body is one tab
 * whose content is the host route the plugin serves at `/browser-use/`, so the panel keeps working
 * without a build step and without touching the shell's own state.
 */
window.__ModuleLoader__.load({
  id: '@rc/dsh-browser-use',
  factory: (require) => {
    const React = require('react')

    const TAB_ID = 'dsh-browser-use/inspector'
    const KIND = 'browser-use'
    const ROUTE = '/browser-use/'

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
    }

    return { name: 'dsh-browser-use-client', inject: ['slots', 'sidebarRightTabs'], apply }
  },
})
