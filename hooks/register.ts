import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import {
  OBJECT_TYPES,
  GREP_PATTERN,
  applyAssignments,
  changedFiles,
  describeGroup,
  freeIds,
  groupFindings,
  isObjectType,
  objectKey,
  objectsInSeveralPools,
  ownerText,
  parseDecls,
  plan,
  poolLabel,
  poolsOf,
  rangesText,
  readGrep,
  readModel,
  repeatedIds,
} from './al'
import type { AppModel, Decl, Finding, ObjectType, Used } from './al'

// Watches the AL apps of the session for objects declared without a usable
// ID and proposes the lowest free one, checked against every local and
// remote branch and the uncommitted files. /asignar-id writes the proposals.

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
const FETCH_EVERY_MS = 10 * 60_000
const SKIP_DIRS = new Set(['node_modules', '.alpackages', '.snapshots', '.alcache', 'bin', 'obj', 'out'])
const MAX_COMMITS = 300

type App = { dir: string; name: string; repo?: string; model: AppModel; problem?: string }
type Refs = { key: string; used: Used; known: Set<string>; branches: number }
type Files = Array<{ file: string; decls: Decl[] }>
type Scan = { app: App; refs: Refs; files: Files; findings: Finding[] }

let apps: App[] = []
let intervalMs = 5000
let canFetch = true
let isPolling = false
let fetching: Promise<string | undefined> | undefined
let statusText: string | undefined
let contextKey = ''
let lastScans: Scan[] = []
const refsCache = new Map<string, Refs>()
const fileCache = new Map<string, { mtimeMs: number; decls: Decl[] }>()
const fetchedAt = new Map<string, number>()
const firstSeen = new Map<string, number>()
const announced = new Set<string>()
let seenCount = 0

const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')
const fold = (path: string) => (/^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path)
const isUnder = (path: string, dir: string) => fold(path) === fold(dir) || fold(path).startsWith(`${fold(dir)}/`)
const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const git = ($: EngineInterface, cwd: string, args: readonly string[], timeoutMs = 30_000) =>
  $.process.run(['git', ...args], { cwd, env: GIT_ENV, timeoutMs })

/** The app a file belongs to: the deepest app folder holding it. */
const appOf = (path: string): App | undefined =>
  apps.filter(app => isUnder(path, app.dir)).sort((a, b) => b.dir.length - a.dir.length)[0]

// ---------------------------------------------------------------- the apps

async function findApps($: EngineInterface): Promise<App[]> {
  const root = norm(await $.session.root())
  const dirs: string[] = []
  let listed = 0
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (dirs.length >= 10 || listed >= 200) return
    if (await $.fs.exists(`${dir}/app.json`)) dirs.push(dir)
    if (depth >= 2) return
    listed++
    for (const entry of await $.fs.list(dir).catch(() => [])) {
      const isSkipped = entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())
      if (entry.kind === 'dir' && !isSkipped) await visit(`${dir}/${entry.name}`, depth + 1)
    }
  }
  await visit(root, 0)
  return Promise.all(dirs.map(dir => loadApp($, dir)))
}

async function loadApp($: EngineInterface, dir: string): Promise<App> {
  const name = dir.slice(dir.lastIndexOf('/') + 1)
  try {
    const appJson = await $.fs.read(`${dir}/app.json`)
    const hasConfig = await $.fs.exists(`${dir}/.objidconfig`)
    const model = readModel(appJson, hasConfig ? await $.fs.read(`${dir}/.objidconfig`) : undefined)
    const top = await git($, dir, ['rev-parse', '--show-toplevel']).catch(() => undefined)
    const repo = top?.exitCode === 0 ? norm(top.stdout.trim()) : undefined
    const app: App = { dir, name, model }
    if (repo !== undefined) app.repo = repo
    if (model.pools.length === 0) app.problem = 'app.json no tiene idRanges'
    return app
  } catch (error) {
    return { dir, name, model: { pools: [], typePools: {} }, problem: `no pude leer app.json: ${String(error)}` }
  }
}

// ---------------------------------------------------------------- what git and the files say

/** The IDs every branch declares, read again only when a branch moved. */
async function readRefs($: EngineInterface, repo: string): Promise<Refs> {
  const listed = await git($, repo, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(objectname) %(refname)',
    'refs/heads',
    'refs/remotes',
  ])
  if (listed.exitCode !== 0) throw new Error(`git for-each-ref: ${firstLine(listed.stderr)}`)
  const head = await git($, repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const headSha = head.exitCode === 0 ? head.stdout.trim() : ''
  const names = new Map<string, string[]>()
  if (headSha !== '') names.set(headSha, [])
  for (const line of listed.stdout.split('\n')) {
    const space = line.indexOf(' ')
    const ref = line.slice(space + 1).trim()
    // refs/remotes/origin/HEAD only points at another branch
    if (space < 0 || ref === '' || ref.endsWith('/HEAD')) continue
    const sha = line.slice(0, space)
    const name = ref.replace(/^refs\/(heads|remotes)\//, '')
    names.set(sha, [...(names.get(sha) ?? []), name])
  }
  if (headSha !== '' && names.get(headSha)?.length === 0) names.set(headSha, ['HEAD'])
  const shas = [...names.keys()].slice(0, MAX_COMMITS)
  const key = shas.map(sha => `${sha}=${names.get(sha)?.join(',')}`).join(' ')
  const cached = refsCache.get(repo)
  if (cached?.key === key) return cached
  const used: Used = new Map()
  const known = new Set<string>()
  if (shas.length > 0) {
    const args = ['grep', '-z', '-I', '-i', '-E', '--no-color', '-e', GREP_PATTERN, ...shas, '--', '*.al']
    const found = await git($, repo, args, 120_000)
    if (found.exitCode > 1) throw new Error(`git grep: ${firstLine(found.stderr)}`)
    readGrep(found.stdout, names, used, known)
  }
  const branches = new Set([...names.values()].flat().filter(name => name !== 'HEAD')).size
  const refs = { key, used, known, branches }
  refsCache.set(repo, refs)
  return refs
}

/** The app's added, changed and untracked .al files; outside git, all of them. */
async function readFiles($: EngineInterface, app: App): Promise<Files> {
  const repo = app.repo
  if (repo === undefined) return readAllFiles($, app)
  const status = await git($, app.dir, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '*.al',
  ])
  if (status.exitCode !== 0) throw new Error(`git status: ${firstLine(status.stderr)}`)
  const files = changedFiles(status.stdout).filter(file => appOf(`${repo}/${file}`) === app)
  const read = await Promise.all(
    files.map(async file => {
      const text = await $.fs.read(`${repo}/${file}`).catch(() => undefined)
      return text === undefined ? undefined : { file, decls: parseDecls(text) }
    }),
  )
  return read.filter(one => one !== undefined)
}

async function readAllFiles($: EngineInterface, app: App): Promise<Files> {
  const found: Array<{ path: string; mtimeMs: number }> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || found.length >= 3000) return
    for (const entry of await $.fs.list(dir).catch(() => [])) {
      const path = `${dir}/${entry.name}`
      const isSkipped = entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())
      if (entry.kind === 'dir' && !isSkipped && appOf(`${path}/x.al`) === app) await walk(path, depth + 1)
      else if (entry.kind === 'file' && /\.al$/i.test(entry.name)) found.push({ path, mtimeMs: entry.mtimeMs })
    }
  }
  await walk(app.dir, 0)
  return Promise.all(
    found.map(async ({ path, mtimeMs }) => {
      const cached = fileCache.get(path)
      const decls = cached?.mtimeMs === mtimeMs ? cached.decls : parseDecls(await $.fs.read(path))
      fileCache.set(path, { mtimeMs, decls })
      return { file: path.slice(app.dir.length + 1), decls }
    }),
  )
}

async function scanApp($: EngineInterface, app: App): Promise<Scan> {
  const files = await readFiles($, app)
  let refs: Refs
  if (app.repo !== undefined) {
    refs = await readRefs($, app.repo)
  } else {
    // outside git the files are all there is: each numbered object already exists
    const known = new Set<string>()
    for (const { decls } of files) for (const decl of decls) if (decl.id) known.add(objectKey(decl.type, decl.name))
    refs = { key: '', used: new Map(), known, branches: 0 }
  }
  // first come, first served: a file seen earlier keeps its proposal
  for (const { file } of files) if (!firstSeen.has(`${app.dir}|${file}`)) firstSeen.set(`${app.dir}|${file}`, seenCount++)
  const order = (file: string) => firstSeen.get(`${app.dir}|${file}`) ?? 0
  const ordered = [...files].sort((a, b) => order(a.file) - order(b.file) || a.file.localeCompare(b.file))
  const findings = plan({ model: app.model, files: ordered, used: refs.used, known: refs.known })
  return { app, refs, files: ordered, findings }
}

async function scanAll($: EngineInterface): Promise<Scan[]> {
  const scans: Scan[] = []
  for (const app of apps) if (app.problem === undefined) scans.push(await scanApp($, app))
  lastScans = scans
  return scans
}

/**
 * Brings the remote branches up to date (`git fetch --all`), at most once per
 * `maxAgeMs`; says why when it could not, so the answer can tell.
 */
function refresh($: EngineInterface, maxAgeMs: number): Promise<string | undefined> {
  if (!canFetch) return Promise.resolve(undefined)
  fetching ??= (async () => {
    const now = await $.clock.now()
    const repos = [...new Set(apps.flatMap(app => (app.repo === undefined ? [] : [app.repo])))]
    const failures: string[] = []
    for (const repo of repos) {
      if (now - (fetchedAt.get(repo) ?? -Infinity) < maxAgeMs) continue
      fetchedAt.set(repo, now)
      const fetched = await git($, repo, ['fetch', '--all', '--quiet'], 60_000).catch((error: unknown) => ({
        exitCode: -1,
        stderr: String(error),
      }))
      if (fetched.exitCode !== 0) failures.push(firstLine(fetched.stderr) || `código ${fetched.exitCode}`)
    }
    return failures.length === 0
      ? undefined
      : `No pude actualizar las ramas remotas (git fetch: ${failures[0]}); uso las que ya tienes en local.`
  })().finally(() => {
    fetching = undefined
  })
  return fetching
}

// ---------------------------------------------------------------- telling the person

const assignable = (scans: readonly Scan[]) =>
  scans.flatMap(scan =>
    groupFindings(scan.findings.filter(one => one.canAssign)).map(group => ({ scan, group })),
  )

/** A toast and a transcript line for each new finding, and the status line for all of them. */
function announce($: EngineInterface, scans: readonly Scan[]): void {
  const groups = scans.flatMap(scan => groupFindings(scan.findings).map(group => ({ scan, group })))
  const current = new Set<string>()
  for (const { scan, group } of groups) {
    const first = group[0]!
    const proposals = group.map(one => `${one.problem}:${one.decl.idText ?? ''}:${one.proposal ?? ''}`).join(',')
    const key = `${scan.app.dir}|${first.file}|${objectKey(first.decl.type, first.decl.name)}|${proposals}`
    current.add(key)
    if (announced.has(key)) continue
    announced.add(key)
    const action = group.some(one => one.canAssign && one.proposal !== undefined) ? ' · /asignar-id para escribirlo' : ''
    const text = `${describeGroup(group)}${action}`
    $.ui.toast(text, { timeoutMs: 15_000 })
    $.ui.log(`IDs AL · ${text} (${first.file}:${first.decl.line + 1})`)
  }
  for (const key of [...announced]) if (!current.has(key)) announced.delete(key)
  const toAssign = assignable(scans).length
  const blocked = groups.length - toAssign
  const status =
    toAssign > 0
      ? `IDs AL: ${plural(toAssign, 'objeto', 'objetos')} sin ID válido → /asignar-id`
      : blocked > 0
        ? `IDs AL: ${plural(blocked, 'conflicto', 'conflictos')} de ID → /id-libre`
        : undefined
  if (status !== statusText) {
    $.ui.status(status)
    statusText = status
  }
}

/** Whether anyone sees the session: a surface draws it, or a host (VS Code, the desktop app) runs it. */
async function isWatched($: EngineInterface): Promise<boolean> {
  if ((await $.session.surfaces()).length > 0) return true
  // a plain `claude -p` draws nowhere
  return (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) !== 'sdk-cli'
}

async function tick($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    if (!(await isWatched($))) return
    void refresh($, FETCH_EVERY_MS)
    announce($, await scanAll($))
  } catch (error) {
    $.ui.log(`al-id-libre: ${String(error)}`, { to: 'debug' })
  } finally {
    isPolling = false
  }
}

// ---------------------------------------------------------------- answers

/** IDs taken for a new object: the branches', the files', and the ones proposed already. */
function takenIn(scan: Scan, type: ObjectType): (id: number) => boolean {
  const taken = new Set<number>(scan.refs.used.get(type)?.keys() ?? [])
  for (const { decls } of scan.files) for (const decl of decls) if (decl.type === type && decl.id) taken.add(decl.id)
  for (const one of scan.findings) if (one.decl.type === type && one.proposal !== undefined) taken.add(one.proposal)
  return id => taken.has(id)
}

const checkedText = (scan: Scan) =>
  scan.app.repo === undefined
    ? 'sin git: revisados los archivos de la carpeta'
    : `revisadas ${plural(scan.refs.branches, 'rama', 'ramas')} y los cambios sin commit`

function habitNote(scan: Scan): string | undefined {
  const pools = scan.app.model.pools
  if (pools.length < 2 || objectsInSeveralPools(scan.refs.used, scan.app.model) < 3) return undefined
  return `En esta app los objetos suelen declararse una vez por rango con #if … #else … #endif (${pools.map(poolLabel).join(', ')}): cada declaración lleva el ID de su rango.`
}

function freeText(scan: Scan, type: ObjectType, count: number): string {
  const isTaken = takenIn(scan, type)
  const rows = poolsOf(scan.app.model, type).map(pool => {
    const ids = freeIds(pool, isTaken, count)
    return `- ${poolLabel(pool)} (${rangesText(pool)}): ${ids.length > 0 ? ids.join(', ') : 'no queda ningún ID libre'}`
  })
  // the objects already waiting for an ID keep theirs: the free ones above are for others
  const waiting = groupFindings(scan.findings.filter(one => one.canAssign && one.decl.type === type)).map(
    group => `- ${describeGroup(group)} · ${group[0]!.file}`,
  )
  return [
    `${scan.app.name} · ${type}: IDs libres para un objeto nuevo (${checkedText(scan)}):`,
    ...rows,
    ...(waiting.length > 0
      ? ['Objetos de los cambios sin commit que ya tienen un ID propuesto (usa ese para ellos):', ...waiting]
      : []),
    habitNote(scan),
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

function report(scan: Scan, wanted: ObjectType | undefined): string {
  const types = wanted === undefined ? OBJECT_TYPES : [wanted]
  const rows = types.map(type => {
    const isTaken = takenIn(scan, type)
    const ids = poolsOf(scan.app.model, type).map(pool => `${poolLabel(pool)} ${freeIds(pool, isTaken)[0] ?? 'lleno'}`)
    return `  ${type.padEnd(24)}${ids.join(' · ')}`
  })
  const lines = [`Siguientes IDs libres en ${scan.app.name} (${checkedText(scan)}):`, ...rows]
  const groups = groupFindings(scan.findings)
  if (groups.length > 0) {
    lines.push('', 'Objetos de tus cambios con un ID que revisar:')
    for (const group of groups) lines.push(`  - ${describeGroup(group)} · ${group[0]!.file}:${group[0]!.decl.line + 1}`)
  }
  const repeated = repeatedIds(scan.refs.used).filter(one => wanted === undefined || one.type === wanted)
  if (repeated.length > 0) {
    lines.push('', 'IDs que ya comparten objetos distintos en las ramas:')
    for (const one of repeated.slice(0, 10)) lines.push(`  - ${one.type} ${one.id}: ${one.owners.map(ownerText).join(', ')}`)
    if (repeated.length > 10) lines.push(`  … y ${repeated.length - 10} más`)
  }
  if (scan.findings.some(one => one.canAssign && one.proposal !== undefined)) {
    lines.push('', 'Escribe /asignar-id para poner los IDs propuestos.')
  }
  return lines.join('\n')
}

async function assignAll($: EngineInterface): Promise<string> {
  const fetchNote = await refresh($, 60_000)
  const scans = await scanAll($)
  const done: string[] = []
  const left: string[] = []
  for (const scan of scans) {
    const base = scan.app.repo ?? scan.app.dir
    const byFile = new Map<string, Finding[]>()
    for (const group of groupFindings(scan.findings)) {
      const ready = group.filter(one => one.canAssign && one.proposal !== undefined)
      if (ready.length < group.length) {
        const rest = group.filter(one => !ready.includes(one))
        left.push(`  - ${describeGroup(rest)} · ${rest[0]!.file}:${rest[0]!.decl.line + 1}`)
      }
      for (const one of ready) byFile.set(one.file, [...(byFile.get(one.file) ?? []), one])
    }
    for (const [file, findings] of byFile) {
      const path = `${base}/${file}`
      const assignments = findings.map(one => ({ decl: one.decl, id: one.proposal! }))
      const written = applyAssignments(await $.fs.read(path), assignments)
      if (written.missed.length < assignments.length) await $.fs.write(path, written.text)
      for (const one of findings) {
        if (written.missed.some(missed => missed.decl === one.decl)) {
          left.push(`  - ${file}: cambió mientras lo leía; vuelve a ejecutar /asignar-id`)
          continue
        }
        const pool = one.pool !== undefined && (one.pool.name !== '' || one.others.length > 0) ? ` (${poolLabel(one.pool)})` : ''
        done.push(`  - ${one.decl.type} ${one.decl.name}: ${one.decl.idText ?? 'sin ID'} → ${one.proposal}${pool} · ${file}:${one.decl.line + 1}`)
      }
    }
  }
  announce($, await scanAll($))
  const parts = [fetchNote]
  parts.push(
    done.length > 0
      ? `IDs asignados (${scans.map(checkedText).join('; ')}):\n${done.join('\n')}`
      : 'No hay objetos nuevos sin ID en tus cambios. /id-libre muestra los siguientes IDs libres.',
  )
  if (left.length > 0) parts.push(`Sin tocar:\n${left.join('\n')}`)
  return parts.filter(part => part !== undefined).join('\n\n')
}

/** Notes for the model about an .al file it just wrote: the IDs to use, when its objects lack one. */
async function afterEdit($: EngineInterface, filePath: string, ran: ToolCallResult): Promise<ToolCallResult> {
  if (ran.deny !== undefined || ran.isError === true || !/\.al$/i.test(filePath)) return ran
  const path = norm(filePath)
  const app = appOf(path)
  if (app === undefined || app.problem !== undefined) return ran
  try {
    const scan = await scanApp($, app)
    const base = app.repo ?? app.dir
    const mine = scan.findings.filter(one => one.canAssign && fold(`${base}/${one.file}`) === fold(path))
    if (mine.length === 0) return ran
    const note = `al-id-libre: ${groupFindings(mine).map(describeGroup).join('; ')}. Usa esos IDs: están comprobados en todas las ramas y en los cambios sin commit.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  } catch {
    return ran
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  intervalMs = Math.min(Math.max(Number(options.intervalSeconds ?? 5) || 5, 2), 300) * 1000
  canFetch = options.fetch !== false
  apps = []
  lastScans = []
  isPolling = false
  fetching = undefined
  statusText = undefined
  contextKey = ''
  seenCount = 0
  for (const map of [refsCache, fileCache, fetchedAt, firstSeen]) map.clear()
  announced.clear()

  on('session.start', async ($, e, next) => {
    try {
      apps = await findApps($)
    } catch (error) {
      $.ui.log(`al-id-libre: ${String(error)}`, { to: 'debug' })
    }
    if (apps.length > 0) {
      await $.command.register({
        name: 'id-libre',
        description: 'Siguientes IDs libres de objetos AL (todas las ramas y los cambios sin commit)',
        argumentHint: '[tipo]',
      })
      await $.command.register({
        name: 'asignar-id',
        description: 'Escribe un ID libre en los objetos AL nuevos que no lo tienen o lo tienen repetido',
      })
      await $.tool.register({
        name: 'id_libre',
        description:
          'Siguientes IDs libres para un objeto AL de Business Central en esta app, comprobados en todas las ramas de git (locales y remotas) y en los cambios sin commit. Úsala antes de crear un objeto AL nuevo para elegir su ID.',
        inputSchema: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: [...OBJECT_TYPES], description: 'Tipo de objeto AL' },
            cantidad: { type: 'integer', minimum: 1, maximum: 20, description: 'Cuántos IDs libres por rango (1 si se omite)' },
          },
          required: ['tipo'],
        },
        isDeferred: false,
      })
      $.clock.every(intervalMs, () => {
        void tick($)
      })
      void tick($)
    }
    return next(e)
  })

  on('command.run', { command: 'id-libre' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    if (wanted !== '' && !isObjectType(wanted)) {
      return { text: `Tipo desconocido "${wanted}". Tipos: ${OBJECT_TYPES.join(', ')}.` }
    }
    try {
      const fetchNote = await refresh($, 60_000)
      const scans = await scanAll($)
      announce($, scans)
      const problems = apps.filter(app => app.problem !== undefined).map(app => `${app.name}: ${app.problem}`)
      const parts = [fetchNote, ...problems, ...scans.map(scan => report(scan, wanted === '' ? undefined : wanted))]
      return { text: parts.filter(part => part !== undefined).join('\n\n') }
    } catch (error) {
      return { text: `No pude calcular los IDs libres: ${String(error)}` }
    }
  })

  on('command.run', { command: 'asignar-id' }, async $ => {
    try {
      return { text: await assignAll($) }
    } catch (error) {
      return { text: `No pude asignar los IDs: ${String(error)}` }
    }
  })

  on('tool.call', { tool: 'mcp__al-id-libre__id_libre' }, async ($, e) => {
    const type = String(e.tipo ?? '').toLowerCase()
    if (!isObjectType(type)) return { result: `Tipo desconocido "${type}". Tipos: ${OBJECT_TYPES.join(', ')}.` }
    const count = Math.min(Math.max(Math.trunc(Number(e.cantidad ?? 1)) || 1, 1), 20)
    const fetchNote = await refresh($, 120_000)
    const scans = await scanAll($)
    const parts = [fetchNote, ...scans.map(scan => freeText(scan, type, count))]
    return { result: parts.filter(part => part !== undefined).join('\n\n') }
  }).catch(() => ({ result: 'al-id-libre: no pude calcular los IDs libres; vuelve a intentarlo.' }))

  // a failure here must never cost the edit itself
  on('tool.call', { tool: 'Write' }, async ($, e, next) => afterEdit($, e.file_path, await next(e))).catch(
    ($, e, next) => next(e),
  )
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => afterEdit($, e.file_path, await next(e))).catch(
    ($, e, next) => next(e),
  )

  // what the person sees, Claude reads too: once per set of findings
  on('prompt.submit', async ($, e, next) => {
    const groups = assignable(lastScans).map(({ group }) => `- ${describeGroup(group)} · ${group[0]!.file}`)
    const key = groups.join('\n')
    if (key === contextKey) return next(e)
    contextKey = key
    if (key === '') return next(e)
    const note = [
      'al-id-libre: estos objetos AL de los cambios sin commit no tienen un ID válido; las propuestas están comprobadas en todas las ramas:',
      ...groups,
      'Si el usuario lo pide, escribe esos IDs (o dile que use /asignar-id).',
    ].join('\n')
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))
}
