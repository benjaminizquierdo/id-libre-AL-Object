import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A small AL app in a fake repository: main has codeunits 51600-51621 and
// their OnPrem twins, a colleague's branch has 7268232-7268233.

const ROOT = 'C:/work/demo'
const APP_JSON = `{
  "idRanges": [
    // ---- Saas ----
    { "from": 51600, "to": 51799 },
    // ---- OnPrem ----
    { "from": 7149215, "to": 7149234 },
    { "from": 7268230, "to": 7268249 }
  ]
}`
const NEW_FILE = 'src/TCNnuevoATR.Codeunit.al'
const NEW_TEXT = '#if OnPrem\r\ncodeunit Id TCNnuevoATR\r\n#else\r\ncodeunit Id TCNnuevoATR\r\n#endif\r\n{\r\n}\r\n'

function grepOutput(): string {
  const lines: string[] = []
  for (let i = 0; i < 22; i++) {
    const onPrem = i < 20 ? 7149215 + i : 7268230 + i - 20
    lines.push(`aaa:src/C${i}.Codeunit.al\0#if OnPrem`)
    lines.push(`aaa:src/C${i}.Codeunit.al\0codeunit ${onPrem} TCNc${i}ATR`)
    lines.push(`aaa:src/C${i}.Codeunit.al\0codeunit ${51600 + i} TCNc${i}ATR`)
  }
  lines.push('bbb:src/C22.Codeunit.al\0codeunit 7268232 TCNc22ATR')
  lines.push('bbb:src/C23.Codeunit.al\0codeunit 7268233 TCNc23ATR')
  return `${lines.join('\n')}\n`
}

type World = {
  files: Map<string, string>
  writes: string[]
  toasts: string[]
  logs: string[]
  status: Array<string | undefined>
  git: string[]
  registered: string[]
}

/** The engine hands paths on in the platform's spelling. */
const slash = (path: string) => path.replace(/\\/g, '/')

function world(
  on: On,
  porcelain: string,
  files: Record<string, string> = {},
  surfaces: readonly ('vscode' | 'terminal')[] = ['vscode'],
): World {
  const w: World = {
    files: new Map(Object.entries({ [`${ROOT}/app.json`]: APP_JSON, ...files })),
    writes: [],
    toasts: [],
    logs: [],
    status: [],
    git: [],
    registered: [],
  }
  const list = (dir: string) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of w.files.keys()) {
      if (!path.startsWith(`${dir}/`)) continue
      const rest = path.slice(dir.length + 1)
      const cut = rest.indexOf('/')
      names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
    }
    return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
  }
  const git = (args: readonly string[]) => {
    w.git.push(args.join(' '))
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${ROOT}\n`
    if (args[0] === 'rev-parse') return 'aaa\n'
    if (args[0] === 'for-each-ref') {
      return 'aaa refs/heads/main\naaa refs/remotes/origin/main\naaa refs/remotes/origin/HEAD\nbbb refs/remotes/origin/feature\n'
    }
    if (args[0] === 'grep') return grepOutput()
    if (args[1] === 'status') return porcelain
    return ''
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: [...surfaces] }))
  on('fs.exists', (_$, e) => ({ value: w.files.has(slash(e.path)) }))
  on('fs.list', (_$, e) => ({ value: list(slash(e.path)) }))
  on('fs.read', (_$, e) => {
    const text = w.files.get(slash(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(slash(e.path), e.text)
    w.writes.push(slash(e.path))
    return { value: undefined }
  })
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: git(e.argv.slice(1)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', (_$, e) => {
    w.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__al-id-libre__${e.name}` } }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  return w
}

const START = { cwd: ROOT, surface: 'vscode' as const, isInteractive: true }
const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

test('/id-libre lists the next free ID of each pool, across every branch', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, '')
  await $.session.start(START)
  await clock.settle()
  const shown = await $.command.run(command('id-libre', 'codeunit'))
  expect(shown.text).toMatch(/revisadas 3 ramas/)
  expect(shown.text).toMatch(/codeunit\s+Saas 51622 · OnPrem 7268234/)
  expect(w.git).toContain('fetch --all --quiet')
  expect(w.toasts).toHaveLength(0)
  const unknown = await $.command.run(command('id-libre', 'tabla'))
  expect(unknown.text).toMatch(/Tipo desconocido "tabla"/)
})

test('a new object without ID is announced once, and /asignar-id writes one ID per pool', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, `?? ${NEW_FILE}\0`, { [`${ROOT}/${NEW_FILE}`]: NEW_TEXT })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  await $.session.start(START)
  await clock.settle()
  expect(w.toasts).toEqual(['codeunit TCNnuevoATR sin ID → OnPrem 7268234 · Saas 51622 · /asignar-id para escribirlo'])
  expect(w.status[w.status.length - 1]).toBe('IDs AL: 1 objeto sin ID válido → /asignar-id')

  await clock.advance(5000)
  expect(w.toasts).toHaveLength(1)

  // Claude reads it once with the next prompt
  const first = await $.prompt.submit({ text: 'hola', wait: false, origin: { kind: 'composer' } })
  expect(first.context?.[0]).toMatch(/TCNnuevoATR sin ID → OnPrem 7268234 · Saas 51622/)
  const second = await $.prompt.submit({ text: 'otra cosa', wait: false, origin: { kind: 'composer' } })
  expect(second.context).toBeUndefined()

  // the model's tool skips the IDs already proposed
  const free = await $.tool.call({ tool: 'mcp__al-id-libre__id_libre', tipo: 'codeunit', cantidad: 2 })
  expect(String(free.result)).toMatch(/Saas \(51600-51799\): 51623, 51624/)
  expect(String(free.result)).toMatch(/OnPrem \(7149215-7149234, 7268230-7268249\): 7268235, 7268236/)
  expect(String(free.result)).toMatch(/una vez por rango con #if/)
  expect(String(free.result)).toMatch(/ya tienen un ID propuesto.*\n- codeunit TCNnuevoATR sin ID → OnPrem 7268234 · Saas 51622/)

  const assigned = await $.command.run(command('asignar-id'))
  expect(assigned.text).toMatch(/codeunit TCNnuevoATR: Id → 7268234 \(OnPrem\)/)
  expect(assigned.text).toMatch(/codeunit TCNnuevoATR: Id → 51622 \(Saas\)/)
  expect(w.files.get(`${ROOT}/${NEW_FILE}`)).toBe(
    '#if OnPrem\r\ncodeunit 7268234 TCNnuevoATR\r\n#else\r\ncodeunit 51622 TCNnuevoATR\r\n#endif\r\n{\r\n}\r\n',
  )
  expect(w.status[w.status.length - 1]).toBeUndefined()
})

test('an object the branches already have is reported, never renumbered', async ($, on) => {
  const clock = mock.clock(on)
  const file = 'src/C5.Codeunit.al'
  const w = world(on, ` M ${file}\0`, { [`${ROOT}/${file}`]: 'codeunit 51603 TCNc5ATR\n{\n}\n' })
  await $.session.start(START)
  await clock.settle()
  expect(w.toasts[0]).toBe('codeunit TCNc5ATR: el ID 51603 ya lo usa TCNc3ATR (main). Ya existe en otras ramas, así que no lo cambio')
  expect(w.status[w.status.length - 1]).toBe('IDs AL: 1 conflicto de ID → /id-libre')
  const assigned = await $.command.run(command('asignar-id'))
  expect(assigned.text).toMatch(/Sin tocar/)
  expect(w.writes).toHaveLength(0)
})

test('after Claude writes an .al file without a usable ID, it is told which to use', async ($, on) => {
  const clock = mock.clock(on)
  world(on, `?? ${NEW_FILE}\0`, { [`${ROOT}/${NEW_FILE}`]: NEW_TEXT })
  on('tool.call', () => ({ result: { filePath: 'x' }, text: 'ok' }) as never)
  await $.session.start(START)
  await clock.settle()
  const edited = await $.tool.call({ tool: 'Write', file_path: `C:\\work\\demo\\src\\TCNnuevoATR.Codeunit.al`, content: NEW_TEXT })
  expect(edited.context?.[0]).toMatch(/al-id-libre: codeunit TCNnuevoATR sin ID → OnPrem 7268234 · Saas 51622/)
  const other = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/README.md`, content: 'x' })
  expect(other.context).toBeUndefined()
})

test('a host that reports no surface still hears of it; a plain -p run does not', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, `?? ${NEW_FILE}\0`, { [`${ROOT}/${NEW_FILE}`]: NEW_TEXT }, [])
  let entrypoint = 'sdk-cli'
  on('env.get', () => ({ value: entrypoint }))
  await $.session.start(START)
  await clock.settle()
  expect(w.toasts).toHaveLength(0)
  entrypoint = 'claude-vscode'
  await clock.advance(5000)
  expect(w.toasts).toEqual(['codeunit TCNnuevoATR sin ID → OnPrem 7268234 · Saas 51622 · /asignar-id para escribirlo'])
})

test('a folder without app.json registers nothing and runs no git', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, '')
  w.files.delete(`${ROOT}/app.json`)
  await $.session.start(START)
  await clock.advance(20_000)
  expect(w.registered).toHaveLength(0)
  expect(w.git).toHaveLength(0)
})
