/**
 * The inspector a person opens beside the conversation: what the browser tools are looking at.
 *
 * The host half serves one same-origin route; the client half shows it in a right-Sidebar tab. The
 * page is deliberately small and reads only what a tool result already contains: the page address,
 * the visible text, the indexed element table, and the last executed action. The image beside it is
 * captured on demand, so the panel costs nothing while nobody is watching.
 *
 * @module dsh-browser-use/inspector
 */

const PREFIX = '/browser-use'

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Browser agent</title>
    <style>
      :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 14%, transparent); }
      * { box-sizing: border-box; }
      body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
      header { padding: 10px 12px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: inherit; }
      h1 { font-size: 12px; margin: 0 0 4px; letter-spacing: .08em; text-transform: uppercase; opacity: .6; font-weight: 600; }
      .url { word-break: break-all; }
      main { padding: 12px; display: grid; gap: 14px; }
      img { width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; }
      table { border-collapse: collapse; width: 100%; }
      td, th { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
      th { font-weight: 600; opacity: .6; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
      .index { white-space: nowrap; }
      .ops { white-space: nowrap; opacity: .75; }
      .value { opacity: .7; }
      .option { opacity: .7; padding-left: 22px !important; }
      .note { opacity: .6; }
      .empty { opacity: .6; padding: 12px; }
    </style>
  </head>
  <body>
    <header>
      <h1>Browser agent</h1>
      <div class="url" id="url">waiting for a browser tool…</div>
      <div class="note" id="meta"></div>
    </header>
    <main>
      <img id="shot" alt="" hidden />
      <div id="table"></div>
      <div class="note" id="text"></div>
    </main>
    <script>
      let current = null
      const $ = id => document.getElementById(id)

      function render(state) {
        const session = state.sessions[0]
        if (!session) {
          $('url').textContent = 'No browser tool has run in this Session yet.'
          $('meta').textContent = ''
          $('table').innerHTML = '<div class="empty">Ask the agent to open a page, and it appears here.</div>'
          $('text').textContent = ''
          $('shot').hidden = true
          current = null
          return
        }
        $('url').textContent = session.url || '(about:blank)'
        $('meta').textContent = 'observation ' + session.observation
          + (session.lastAction ? ' · last: ' + session.lastAction : '')
          + (session.title ? ' · ' + session.title : '')
        const rows = session.elements.map(element => {
          const label = String(element.label ?? '').replace(/</g, '&lt;')
          const value = element.value ? '<span class="value"> · ' + String(element.value).replace(/</g, '&lt;') + '</span>' : ''
          const options = (element.options ?? []).map(option =>
            '<tr><td class="option" colspan="3">' + option.index + ' → ' + String(option.label ?? '').replace(/</g, '&lt;') + '</td></tr>').join('')
          return '<tr><td class="index">[' + element.index + ']</td><td>' + (element.role ?? 'element') + '</td>'
            + '<td>' + label + value + '</td><td class="ops">' + (element.operations ?? []).join(', ') + '</td></tr>' + options
        }).join('')
        $('table').innerHTML = rows
          ? '<table><thead><tr><th>#</th><th>role</th><th>element</th><th>operations</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty">No reachable element on this page.</div>'
        const text = (session.text || '').replace(/\\s+/g, ' ').trim()
        $('text').textContent = text.length > 600 ? text.slice(0, 600) + '…' : text
        if (current !== session.label) {
          current = session.label
          $('shot').hidden = false
        }
      }

      async function poll() {
        try {
          const state = await (await fetch('state', { cache: 'no-store' })).json()
          render(state)
        } catch {
          $('meta').textContent = 'waiting for the host…'
        }
      }

      function refreshShot() {
        if ($('shot').hidden) return
        $('shot').src = 'screenshot?t=' + Date.now()
      }

      poll()
      refreshShot()
      setInterval(poll, 1000)
      setInterval(refreshShot, 3000)
    </script>
  </body>
</html>
`

function send(res, status, type, body) {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

/**
 * Serve the inspector route.
 * @param ctx - context that may provide `webServer` and `connection`.
 * @param sessions - the Session browsers the tools are using.
 * @returns a disposer for the route, or undefined when this composition has no web server.
 */
export function registerInspector(ctx, sessions) {
  const server = ctx.get('webServer')
  if (!server) return undefined
  const connection = ctx.get('connection')
  const handler = async (req, res) => {
    const rejection = connection?.requestRejection?.(req)
    if (rejection !== undefined) {
      send(res, rejection, 'text/plain; charset=utf-8', '')
      return
    }
    const path = String(req.url ?? '').split('?')[0]
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not found')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'GET only')
      return
    }
    if (path === PREFIX || path === `${PREFIX}/`) {
      send(res, 200, 'text/html; charset=utf-8', PAGE)
      return
    }
    if (path === `${PREFIX}/state`) {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ sessions: sessions.view() }))
      return
    }
    if (path === `${PREFIX}/screenshot`) {
      const label = new URL(req.url ?? '', 'http://localhost').searchParams.get('label') ?? undefined
      const shot = await sessions.capture(label)
      if (!shot) {
        send(res, 404, 'text/plain; charset=utf-8', 'No browser session to capture')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'image/jpeg')
      res.setHeader('cache-control', 'no-store')
      res.end(shot)
      return
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Not found')
  }
  return server.register({ kind: 'prefix', path: PREFIX, handler })
}
