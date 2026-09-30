/**
 * Pack once, inspect the allow-list, then install that exact tarball outside the checkout.
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
  'pyproject.toml', 'uv.lock', 'sidecar/bridge.py', 'bin/doctor.mjs',
  'locale/en.json', 'locale/zh.json', 'bench/results.json', 'bench/fixture.html',
  ...Object.values(manifest.exports).flatMap(value => Object.values(
    typeof value === 'string' ? { path: value } : value,
  )).filter(path => !path.includes('*')).map(path => path.replace(/^\.\//u, '')),
]) assert.ok(files.has(path), `Missing npm package file: ${path}`)
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
    import { readFileSync, existsSync } from 'node:fs'
    import { dirname, join } from 'node:path'
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
  `], { cwd: temporary, stdio: 'inherit' })
} finally {
  await rm(temporary, { recursive: true, force: true })
}
await writeFile(join(output, 'pack.json'), JSON.stringify(packed, null, 2) + '\n')
console.log(`Verified ${packed.id}: ${packed.entryCount} files, ${packed.size} bytes; ${packed.integrity}`)
