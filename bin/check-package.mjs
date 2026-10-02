/**
 * Pack once, inspect the allow-list, then install that exact tarball outside the checkout and let it
 * build its own Python environment from the engine wheel it bundles, as it does on a user's machine.
 * CI uploads the checked tarball; the publishing job never repacks it.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'dist')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const engine = JSON.parse(await readFile(join(root, 'vendor', 'jev-ultrafast.json'), 'utf8'))
await mkdir(output, { recursive: true })
const [packed] = JSON.parse(execFileSync(npm, [
  'pack', '--json', '--ignore-scripts', '--pack-destination', output,
], { cwd: root, encoding: 'utf8' }))
assert.equal(packed.name, manifest.name)
assert.equal(packed.version, manifest.version)
assert.equal(basename(packed.filename), packed.filename)
const files = new Set(packed.files.map(file => file.path))
for (const path of [
  'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'icon.svg', 'cordis.patch.yml',
  'pyproject.toml', 'uv.lock', 'sidecar/bridge.py', 'bin/doctor.mjs', 'lib/provision.js', 'lib/python.js',
  'vendor/jev-ultrafast.json', 'vendor/requirements.txt', `vendor/${engine.wheel}`,
  'locale/en.json', 'locale/zh.json', 'bench/results.json', 'bench/fixture.html',
  ...Object.values(manifest.exports).flatMap(value => Object.values(
    typeof value === 'string' ? { path: value } : value,
  )).filter(path => !path.includes('*')).map(path => path.replace(/^\.\//u, '')),
]) assert.ok(files.has(path), `Missing npm package file: ${path}`)
assert.deepEqual([...files].filter(path => path.endsWith('.whl')), [`vendor/${engine.wheel}`],
  'The npm package must ship exactly the engine wheel vendor/jev-ultrafast.json names.')
for (const path of files) {
  assert.ok(!path.split('/').some(part => [
    '.env', '.npmrc', '.git', '.github', '.venv', 'node_modules', '__pycache__', 'test', 'dist',
  ].includes(part)), `Unexpected npm package file: ${path}`)
  assert.ok(!/\.(?:pem|key|pyc)$/u.test(path), `Unexpected npm package file: ${path}`)
}
for (const name of ['README.md', 'README.zh-CN.md']) {
  const readme = await readFile(join(root, name), 'utf8')
  for (const match of readme.matchAll(/<img[^>]*src="([^"]+)"|\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = (match[1] ?? match[2]).split('#')[0]
    if (!target || /^[a-z]+:/iu.test(target)) continue
    assert.ok(files.has(target) || [...files].some(path => path.startsWith(`${target.replace(/\/$/u, '')}/`)),
      `${name} references a file missing from npm: ${target}`)
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'dsh-package-check-'))
try {
  execFileSync(npm, [
    'install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock=false', '--omit=dev', '--registry=https://registry.npmjs.org/',
    join(output, packed.filename),
  ], { stdio: 'inherit' })
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { readFileSync, existsSync, realpathSync } from 'node:fs'
    import { dirname, join, sep } from 'node:path'
    import { pathToFileURL } from 'node:url'
    import vm from 'node:vm'
    const require = createRequire(${JSON.stringify(join(temporary, 'package.json'))})
    const name = ${JSON.stringify(manifest.name)}
    const packagePath = require.resolve(name + '/package.json')
    const installed = require(packagePath)
    assert.equal(installed.version, ${JSON.stringify(manifest.version)})
    const plugin = await import(pathToFileURL(require.resolve(name)))
    assert.equal(typeof plugin.apply, 'function')
    assert.ok(plugin.Config)
    let client
    vm.runInNewContext(readFileSync(require.resolve(name + '/client'), 'utf8'), {
      window: { __ModuleLoader__: { load: value => { client = value } } },
    })
    assert.equal(client.id, name)
    assert.equal(typeof client.factory, 'function')
    for (const language of ['en', 'zh']) assert.ok(require(name + '/locale/' + language + '.json').meta.title)
    const packageRoot = dirname(packagePath)
    assert.ok(readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8').includes('name: "' + name + '"'))
    assert.ok(existsSync(join(packageRoot, 'sidecar', 'bridge.py')))
    console.log('Installed npm tarball: host, client, schema, locales, bundle and Python bridge OK.')

    // What the plugin does on its first load on a machine that has no engine yet: no checkout, no git.
    // The environment is built with a Python 3.12+ this machine has (pip, by hash, from the lock's
    // requirements) or with uv when it has none — whichever this runner offers, it must end up ready.
    const { resolveConfig } = await import(pathToFileURL(join(packageRoot, 'lib', 'config.js')))
    const engine = await import(pathToFileURL(join(packageRoot, 'lib', 'engine.js')))
    const config = resolveConfig({})
    assert.ok(engine.installable(config), 'the default configuration must let the plugin install its engine')
    const report = await engine.ensureEngine(config, {
      onInstall: status => console.log('Installing the bundled engine into ' + status.environment + ':'),
      onOutput: line => console.log('  ' + line),
    })
    // The environment's python is a symlink to uv's interpreter: compare where it sits, not where it points.
    const inside = (path, directory) => (realpathSync(dirname(path)) + sep).startsWith(realpathSync(directory) + sep)
    const environment = join(packageRoot, '.venv')
    assert.equal(report.install?.state, 'installed', engine.reportText(report))
    assert.ok(report.engine, engine.reportText(report))
    assert.ok(inside(report.interpreter.command, environment), report.interpreter.command)
    assert.ok(inside(report.engine.enginePath, environment), report.engine.enginePath)
    assert.equal(report.engine.engine, ${JSON.stringify(engine.version)})
    assert.deepEqual(report.problems.filter(item => !item.informational && item.code !== 'no_browser'), [])
    console.log('Installed npm tarball: the bundled engine installs and imports: jev-ultrafast '
      + report.engine.engine + ', Browser Harness ' + report.engine.browserHarness + ', Python ' + report.engine.python + '.')
  `], { cwd: temporary, stdio: 'inherit' })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
await writeFile(join(output, 'pack.json'), JSON.stringify(packed, null, 2) + '\n')
console.log(`Verified ${packed.id}: ${packed.entryCount} files, ${packed.size} bytes; ${packed.integrity}`)
