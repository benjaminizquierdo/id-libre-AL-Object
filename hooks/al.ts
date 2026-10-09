// The AL side of al-id-libre, with no `$` in it: reading object declarations,
// the app's ID ranges, and choosing free IDs. register.ts feeds it what git
// and the files say; the tests call it directly.

export const OBJECT_TYPES = [
  'table',
  'tableextension',
  'page',
  'pageextension',
  'report',
  'reportextension',
  'codeunit',
  'query',
  'xmlport',
  'enum',
  'enumextension',
  'permissionset',
  'permissionsetextension',
] as const

export type ObjectType = (typeof OBJECT_TYPES)[number]

export const isObjectType = (text: string): text is ObjectType =>
  (OBJECT_TYPES as readonly string[]).includes(text)

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** One object, whatever its ID: AL names are case-insensitive. */
export const objectKey = (type: ObjectType, name: string) => `${type}|${name.toLowerCase()}`

// ---------------------------------------------------------------- declarations

/** One `#if` chain a declaration sits in: its conditions so far, and whether it is past `#else`. */
export type Frame = { exprs: string[]; isElse: boolean }

export type Decl = {
  type: ObjectType
  /** The ID as written (`51600`, `Id`, `0`); undefined when the line has none. */
  idText?: string
  /** The ID, when `idText` is a number. */
  id?: number
  name: string
  /** 0-based line. */
  line: number
  /** Where the ID starts in the line, or where one goes when there is none. */
  start: number
  end: number
  frames: Frame[]
}

const TYPE_RE = new RegExp(
  `^\\s*(${[...OBJECT_TYPES].sort((a, b) => b.length - a.length).join('|')})(?=\\s)`,
  'i',
)
/** What the AL snippets leave in place of the ID (`table Id MyTable`), and the usual stand-ins. */
const PLACEHOLDER = /^(id|x+|\?+)$/i
const DIRECTIVE = /^\s*#(if|elif|else|endif)\b(.*)$/i
const CLAUSE = /^(extends|implements)$/i

/** The pattern `git grep -i -E` finds numbered declarations with. */
export const GREP_PATTERN = `^[[:space:]]*(${OBJECT_TYPES.join('|')})[[:space:]]+[0-9]+([[:space:]]|$)`

/**
 * The line with its comments blanked out, offsets kept: `//` to the end and
 * `/* ... *\/` (which may run on from the line before).
 */
export function stripComments(line: string, isInBlock: boolean): { code: string; isInBlock: boolean } {
  let code = ''
  let i = 0
  while (i < line.length) {
    if (isInBlock) {
      const close = line.indexOf('*/', i)
      const end = close < 0 ? line.length : close + 2
      code += ' '.repeat(end - i)
      i = end
      isInBlock = close < 0
      continue
    }
    const c = line[i]!
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1)
      const end = close < 0 ? line.length : close + 1
      code += line.slice(i, end)
      i = end
    } else if (c === '/' && line[i + 1] === '/') {
      code += ' '.repeat(line.length - i)
      i = line.length
    } else if (c === '/' && line[i + 1] === '*') {
      code += '  '
      i += 2
      isInBlock = true
    } else {
      code += c
      i++
    }
  }
  return { code, isInBlock }
}

type Token = { text: string; start: number; end: number; isQuoted: boolean }

/** The words after the object type, up to `{`; undefined for a line that is code, not a declaration. */
function tokenize(line: string, from: number): Token[] | undefined {
  const tokens: Token[] = []
  let i = from
  while (i < line.length) {
    const c = line[i]!
    if (/\s|,/.test(c)) {
      i++
    } else if (c === '"') {
      const close = line.indexOf('"', i + 1)
      if (close < 0) return undefined
      tokens.push({ text: line.slice(i + 1, close), start: i, end: close + 1, isQuoted: true })
      i = close + 1
    } else if (c === '{') {
      tokens.push({ text: '{', start: i, end: i + 1, isQuoted: false })
      break
    } else if ('=;():\''.includes(c)) {
      return undefined
    } else {
      let j = i
      while (j < line.length && !/[\s",{=;():']/.test(line[j]!)) j++
      tokens.push({ text: line.slice(i, j), start: i, end: j, isQuoted: false })
      i = j
    }
  }
  return tokens
}

const endsHere = (token: Token | undefined) =>
  token === undefined || token.text === '{' || (!token.isQuoted && CLAUSE.test(token.text))

/** The declaration a line holds, comments already blanked; undefined when it holds none. */
export function parseDeclLine(line: string, lineNo = 0, frames: Frame[] = []): Decl | undefined {
  const match = TYPE_RE.exec(line)
  if (match === null) return undefined
  const tokens = tokenize(line, match[0].length)
  const first = tokens?.[0]
  if (tokens === undefined || first === undefined || first.text === '{') return undefined
  const second = tokens[1]
  const base = { type: match[1]!.toLowerCase() as ObjectType, line: lineNo, frames }
  if (!first.isQuoted && /^\d+$/.test(first.text)) {
    if (endsHere(second)) return undefined
    const id = Number(first.text)
    return { ...base, idText: first.text, id, name: second!.text, start: first.start, end: first.end }
  }
  if (!first.isQuoted && PLACEHOLDER.test(first.text) && !endsHere(second)) {
    return { ...base, idText: first.text, name: second!.text, start: first.start, end: first.end }
  }
  if (endsHere(second) && (first.isQuoted || !CLAUSE.test(first.text))) {
    return { ...base, name: first.text, start: first.start, end: first.start }
  }
  return undefined
}

/** Every object declaration in an AL file, with the `#if` chains around it. */
export function parseDecls(text: string): Decl[] {
  const decls: Decl[] = []
  const stack: Frame[] = []
  let isInBlock = false
  text.split('\n').forEach((raw, lineNo) => {
    const stripped = stripComments(raw.replace(/\r$/, ''), isInBlock)
    isInBlock = stripped.isInBlock
    const directive = DIRECTIVE.exec(stripped.code)
    if (directive !== null) {
      const kind = directive[1]!.toLowerCase()
      const expr = directive[2]!.trim()
      const top = stack[stack.length - 1]
      if (kind === 'if') stack.push({ exprs: [expr], isElse: false })
      else if (kind === 'elif') top?.exprs.push(expr)
      else if (kind === 'else' && top !== undefined) top.isElse = true
      else if (kind === 'endif') stack.pop()
      return
    }
    const frames = stack.map(frame => ({ exprs: [...frame.exprs], isElse: frame.isElse }))
    const decl = parseDeclLine(stripped.code, lineNo, frames)
    if (decl !== undefined) decls.push(decl)
  })
  return decls
}

// ---------------------------------------------------------------- ranges

export type Range = { from: number; to: number; label?: string }

/** Ranges whose labels differ only by a trailing number ("OnPrem1", "OnPrem2") form one pool. */
export type Pool = { key: string; name: string; ranges: Range[] }

export type AppModel = {
  pools: Pool[]
  /** Pools of one object type, from `.objidconfig`'s `objectRanges`. */
  typePools: Partial<Record<ObjectType, Pool[]>>
}

export const poolsOf = (model: AppModel, type: ObjectType): Pool[] => model.typePools[type] ?? model.pools

export const poolLabel = (pool: Pool): string =>
  pool.name !== '' ? pool.name : pool.ranges.map(range => `${range.from}-${range.to}`).join(', ')

export const rangesText = (pool: Pool): string =>
  pool.ranges.map(range => `${range.from}-${range.to}`).join(', ')

/** JSON with comments and trailing commas, as app.json allows. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  const source = text.replace(/^﻿/, '')
  while (i < source.length) {
    const c = source[i]!
    if (c === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      i = close < 0 ? source.length : close + 2
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function cleanLabel(comment: string): string | undefined {
  const text = comment.replace(/^[\s\-=*#/]+|[\s\-=*#/]+$/g, '')
  return text === '' || /[{}":]/.test(text) ? undefined : text
}

/**
 * The comment above each `idRanges` entry (`// ---- Saas ----` gives "Saas"),
 * the last one seen standing for the entries after it.
 */
export function rangeCommentLabels(text: string): Array<string | undefined> {
  const key = /"idRanges"\s*:\s*\[/i.exec(text)
  if (key === null) return []
  const labels: Array<string | undefined> = []
  let label: string | undefined
  let depth = 0
  let i = key.index + key[0].length
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const isLine = text[i + 1] === '/'
      const close = isLine ? text.indexOf('\n', i) : text.indexOf('*/', i + 2)
      const end = close < 0 ? text.length : close
      if (depth === 0) label = cleanLabel(text.slice(i + 2, end)) ?? label
      i = isLine ? end : end + 2
      continue
    }
    if (c === '{') {
      if (depth === 0) labels.push(label)
      depth++
    } else if (c === '}') {
      depth--
    } else if (c === ']' && depth === 0) {
      break
    }
    i++
  }
  return labels
}

function toRanges(value: unknown, label?: string): Range[] {
  if (value === null || typeof value !== 'object') return []
  const { from, to, description } = value as { from?: unknown; to?: unknown; description?: unknown }
  if (typeof from !== 'number' || typeof to !== 'number' || to < from) return []
  const text = typeof description === 'string' && description.trim() !== '' ? description.trim() : label
  return [text === undefined ? { from, to } : { from, to, label: text }]
}

export function makePools(ranges: readonly Range[]): Pool[] {
  const pools: Pool[] = []
  for (const range of ranges) {
    const name = (range.label ?? '').replace(/[\s_-]*\d+$/, '').trim()
    const key = name.toLowerCase()
    const pool = pools.find(one => one.key === key)
    if (pool === undefined) pools.push({ key, name, ranges: [range] })
    else pool.ranges.push(range)
  }
  return pools
}

/**
 * The app's ranges from app.json (`idRanges`, or the old `idRange`), labelled
 * by the comments above them. A `.objidconfig` (AL Object ID Ninja) may name
 * them, narrow them to logical ranges, or give an object type its own.
 */
export function readModel(appJson: string, objidconfig?: string): AppModel {
  const app = parseJsonc(appJson) as { idRanges?: unknown; idRange?: unknown }
  const listed = Array.isArray(app.idRanges) ? app.idRanges : app.idRange !== undefined ? [app.idRange] : []
  const labels = rangeCommentLabels(appJson)
  let ranges = listed.flatMap((range, i) => toRanges(range, labels[i]))
  const typePools: AppModel['typePools'] = {}
  if (objidconfig !== undefined) {
    try {
      const config = parseJsonc(objidconfig) as { idRanges?: unknown; objectRanges?: unknown }
      const logical = Array.isArray(config.idRanges) ? config.idRanges.flatMap(range => toRanges(range)) : []
      const isInside = (one: Range) => ranges.some(range => one.from >= range.from && one.to <= range.to)
      if (logical.length > 0 && logical.every(isInside)) ranges = logical
      if (config.objectRanges !== null && typeof config.objectRanges === 'object') {
        for (const [type, list] of Object.entries(config.objectRanges)) {
          const lower = type.toLowerCase()
          const own = Array.isArray(list) ? list.flatMap(range => toRanges(range)) : []
          if (isObjectType(lower) && own.length > 0) typePools[lower] = makePools(own)
        }
      }
    } catch {
      // a .objidconfig that does not parse is left out; app.json still holds
    }
  }
  return { pools: makePools(ranges), typePools }
}

// ---------------------------------------------------------------- pools by #if

const WORDS = /[A-Za-z_][A-Za-z0-9_]*/g

function poolNamed(expr: string, pools: readonly Pool[]): { pool: Pool; isNegated: boolean } | undefined {
  const isNegated = /^\s*not\b/i.test(expr)
  for (const word of expr.match(WORDS) ?? []) {
    const key = word.toLowerCase()
    if (key === 'not' || key === 'and' || key === 'or') continue
    const pool = pools.find(one => one.key !== '' && (one.key === key || one.key === key.replace(/\d+$/, '')))
    if (pool !== undefined) return { pool, isNegated }
  }
  return undefined
}

const otherThan = (pool: Pool, pools: readonly Pool[]) => pools.find(one => one !== pool) ?? pool

/**
 * The pool a declaration takes its ID from: the one its `#if` names
 * (`#if OnPrem` → OnPrem), the other one past `#else`, else the first.
 */
export function poolFor(decl: Decl, pools: readonly Pool[]): Pool {
  for (const frame of [...decl.frames].reverse()) {
    const current = frame.isElse ? undefined : frame.exprs[frame.exprs.length - 1]
    const hit = current === undefined ? undefined : poolNamed(current, pools)
    if (hit !== undefined) return hit.isNegated ? otherThan(hit.pool, pools) : hit.pool
    for (const earlier of frame.isElse ? frame.exprs : frame.exprs.slice(0, -1)) {
      const was = poolNamed(earlier, pools)
      if (was !== undefined) return was.isNegated ? was.pool : otherThan(was.pool, pools)
    }
  }
  return pools[0]!
}

function* idsOf(pool: Pool): Generator<number> {
  for (const range of pool.ranges) for (let id = range.from; id <= range.to; id++) yield id
}

/**
 * The next free IDs of a pool: those after the highest one in use, so the ID
 * of an object deleted long ago is not handed out again (in Business Central
 * a reused table ID can clash with what a tenant still holds); the gaps below
 * only once nothing is left above.
 */
export function freeIds(pool: Pool, isTaken: (id: number) => boolean, count = 1): number[] {
  let highest = -1
  let at = 0
  for (const id of idsOf(pool)) {
    if (isTaken(id)) highest = at
    at++
  }
  const after: number[] = []
  const gaps: number[] = []
  at = 0
  for (const id of idsOf(pool)) {
    if (!isTaken(id)) (at > highest ? after : gaps).push(id)
    if (after.length >= count) break
    at++
  }
  return [...after, ...gaps].slice(0, count)
}

export const firstFree = (pool: Pool, isTaken: (id: number) => boolean): number | undefined =>
  freeIds(pool, isTaken)[0]

// ---------------------------------------------------------------- IDs in use

/** One object declaring an ID: its name, the branches it is in, and its files. */
export type Owner = { name: string; where: string[]; paths: string[] }

export type Used = Map<ObjectType, Map<number, Owner[]>>

export function addOwner(used: Used, type: ObjectType, id: number, name: string, where: string, path: string): void {
  let ids = used.get(type)
  if (ids === undefined) {
    ids = new Map()
    used.set(type, ids)
  }
  const owners = ids.get(id) ?? []
  const owner = owners.find(one => sameName(one.name, name))
  if (owner === undefined) {
    owners.push({ name, where: [where], paths: [path] })
  } else {
    if (!owner.where.includes(where)) owner.where.push(where)
    if (!owner.paths.includes(path)) owner.paths.push(path)
  }
  ids.set(id, owners)
}

/**
 * Reads `git grep -z` over commits (`<sha>:<path>\0<line>` per line) into the
 * IDs used, each under the branch names of its commit, and the objects known.
 */
export function readGrep(
  output: string,
  names: ReadonlyMap<string, readonly string[]>,
  used: Used,
  known: Set<string>,
): void {
  for (const line of output.split('\n')) {
    const nul = line.indexOf('\0')
    const colon = line.indexOf(':')
    if (nul < 0 || colon < 0 || colon > nul) continue
    const sha = line.slice(0, colon)
    const path = line.slice(colon + 1, nul)
    const decl = parseDeclLine(stripComments(line.slice(nul + 1), false).code)
    if (decl?.id === undefined || decl.id === 0) continue
    for (const where of names.get(sha) ?? [sha.slice(0, 8)]) addOwner(used, decl.type, decl.id, decl.name, where, path)
    known.add(objectKey(decl.type, decl.name))
  }
}

/** The `.al` files `git status --porcelain=v1 -z` lists as added, changed or untracked. */
export function changedFiles(porcelain: string): string[] {
  const entries = porcelain.split('\0')
  const files: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++ // the old path follows
    if (x === 'D' || y === 'D') continue
    const path = entry.slice(3)
    if (/\.al$/i.test(path)) files.push(path)
  }
  return files
}

/** IDs that two different objects declare across the branches (a file renamed in place aside). */
export function repeatedIds(used: Used): Array<{ type: ObjectType; id: number; owners: Owner[] }> {
  const repeated: Array<{ type: ObjectType; id: number; owners: Owner[] }> = []
  for (const [type, ids] of used) {
    for (const [id, owners] of ids) {
      const apart = owners.filter(
        (owner, i) => !owners.some((other, j) => j < i && other.paths.some(path => owner.paths.includes(path))),
      )
      if (apart.length > 1) repeated.push({ type, id, owners: apart })
    }
  }
  return repeated.sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)
}

/** How many objects declare themselves once per pool (the `#if OnPrem ... #else ...` habit). */
export function objectsInSeveralPools(used: Used, model: AppModel): number {
  const pools = new Map<string, Set<string>>()
  for (const [type, ids] of used) {
    for (const [id, owners] of ids) {
      const pool = poolsOf(model, type).find(one => one.ranges.some(range => id >= range.from && id <= range.to))
      if (pool === undefined) continue
      for (const owner of owners) {
        const key = objectKey(type, owner.name)
        const seen = pools.get(key) ?? new Set<string>()
        seen.add(pool.key)
        pools.set(key, seen)
      }
    }
  }
  return [...pools.values()].filter(seen => seen.size > 1).length
}

// ---------------------------------------------------------------- the plan

export type Problem = 'sin-id' | 'duplicado' | 'fuera-de-rango'

export type Finding = {
  /** The file as git names it (relative to the repository), or to the app outside git. */
  file: string
  decl: Decl
  problem: Problem
  /** The other objects that declare the same ID. */
  clash: Owner[]
  /** Whether a new ID may be written: the object has none, or no branch has it yet. */
  canAssign: boolean
  pool?: Pool
  proposal?: number
  /** The first free ID of each other pool, shown beside the proposal. */
  others: Array<{ pool: Pool; id?: number }>
}

export type PlanInput = {
  model: AppModel
  files: ReadonlyArray<{ file: string; decls: readonly Decl[] }>
  /** The IDs the branches declare. */
  used: Used
  /** `objectKey` of each object a branch declares with an ID. */
  known: ReadonlySet<string>
}

const setOf = <K, V>(map: Map<K, Set<V>>, key: K): Set<V> => {
  let set = map.get(key)
  if (set === undefined) {
    set = new Set()
    map.set(key, set)
  }
  return set
}

/**
 * What the changed files declare without a usable ID, and the ID each should
 * take: the lowest one free in its pool across the branches, the files, and
 * what this plan already handed out.
 */
export function plan({ model, files, used, known }: PlanInput): Finding[] {
  const ordered = [...files].sort((a, b) => a.file.localeCompare(b.file))
  const written = new Map<ObjectType, Set<number>>()
  for (const { decls } of ordered) for (const decl of decls) if (decl.id) setOf(written, decl.type).add(decl.id)
  const handedOut = new Map<ObjectType, Set<number>>()
  const takenFor = (type: ObjectType) => (id: number) =>
    used.get(type)?.has(id) === true || written.get(type)?.has(id) === true || handedOut.get(type)?.has(id) === true
  // the files' own IDs as far as read: the first of two new objects keeps a shared ID
  const seen: Used = new Map()
  const findings: Finding[] = []
  for (const { file, decls } of ordered) {
    for (const decl of decls) {
      const pools = poolsOf(model, decl.type)
      const problem = problemOf(decl, file, pools, used, seen)
      if (problem === undefined) {
        if (decl.id) addOwner(seen, decl.type, decl.id, decl.name, 'sin commit', file)
        continue
      }
      const canAssign = problem.problem === 'sin-id' || !known.has(objectKey(decl.type, decl.name))
      const finding: Finding = { file, decl, ...problem, canAssign, others: [] }
      if (canAssign && pools.length > 0) {
        const pool = poolFor(decl, pools)
        const isTaken = takenFor(decl.type)
        const proposal = firstFree(pool, isTaken)
        finding.pool = pool
        if (proposal !== undefined) {
          finding.proposal = proposal
          setOf(handedOut, decl.type).add(proposal)
          addOwner(seen, decl.type, proposal, decl.name, 'sin commit', file)
        }
        finding.others = pools.filter(one => one !== pool).map(one => ({ pool: one, id: firstFree(one, isTaken) }))
      } else if (decl.id) {
        addOwner(seen, decl.type, decl.id, decl.name, 'sin commit', file)
      }
      findings.push(finding)
    }
  }
  return findings
}

function problemOf(
  decl: Decl,
  file: string,
  pools: readonly Pool[],
  used: Used,
  seen: Used,
): { problem: Problem; clash: Owner[] } | undefined {
  const id = decl.id
  if (!id) return { problem: 'sin-id', clash: [] }
  // another object with the ID; the same file under another name in a branch is a rename
  const others = (map: Used) =>
    (map.get(decl.type)?.get(id) ?? []).filter(owner => !sameName(owner.name, decl.name) && !owner.paths.includes(file))
  const clash = [...others(used), ...others(seen)]
  if (clash.length > 0) return { problem: 'duplicado', clash }
  const isInRange = pools.some(pool => pool.ranges.some(range => id >= range.from && id <= range.to))
  if (pools.length > 0 && !isInRange) return { problem: 'fuera-de-rango', clash: [] }
  return undefined
}

/** The findings of one object (its declarations in one file), in file order. */
export function groupFindings(findings: readonly Finding[]): Finding[][] {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = `${finding.file}|${objectKey(finding.decl.type, finding.decl.name)}`
    groups.set(key, [...(groups.get(key) ?? []), finding])
  }
  return [...groups.values()]
}

/** Points the edits at the same declarations a plan saw, and writes each ID in. */
export function applyAssignments(
  text: string,
  assignments: ReadonlyArray<{ decl: Decl; id: number }>,
): { text: string; missed: Array<{ decl: Decl; id: number }> } {
  const fresh = parseDecls(text)
  const lines = text.split('\n')
  const missed: Array<{ decl: Decl; id: number }> = []
  const edits: Array<{ line: number; start: number; end: number; text: string }> = []
  for (const assignment of assignments) {
    const { decl } = assignment
    const found = fresh.find(
      one => one.line === decl.line && one.type === decl.type && sameName(one.name, decl.name) && one.idText === decl.idText,
    )
    if (found === undefined) missed.push(assignment)
    else edits.push({
      line: found.line,
      start: found.start,
      end: found.end,
      text: found.idText === undefined ? `${assignment.id} ` : String(assignment.id),
    })
  }
  for (const edit of edits.sort((a, b) => b.line - a.line || b.start - a.start)) {
    const line = lines[edit.line]!
    lines[edit.line] = line.slice(0, edit.start) + edit.text + line.slice(edit.end)
  }
  return { text: lines.join('\n'), missed }
}

// ---------------------------------------------------------------- wording

/** Where an object is: its first branch and how many more, a remote twin (`origin/main` beside `main`) not counted. */
export function branchesText(where: readonly string[]): string {
  const own = where.filter(name => !where.some(other => other !== name && name.endsWith(`/${other}`)))
  return own.length > 1 ? `${own[0]} +${own.length - 1}` : (own[0] ?? '')
}

export const ownerText = (owner: Owner) => `${owner.name} (${branchesText(owner.where)})`

/** The proposal with its pool named, unless the app has a single unnamed one. */
function proposalText(finding: Finding): string {
  const pool = finding.pool
  if (pool === undefined) return 'la app no tiene idRanges en app.json'
  if (finding.proposal === undefined) return `no queda ningún ID libre en ${poolLabel(pool)}`
  const isPlain = finding.others.length === 0 && pool.name === ''
  return isPlain ? String(finding.proposal) : `${finding.proposal} (${poolLabel(pool)})`
}

function reasonText(finding: Finding): string {
  const { id } = finding.decl
  if (finding.problem === 'sin-id') return 'sin ID'
  return finding.problem === 'duplicado'
    ? `el ID ${id} ya lo usa ${ownerText(finding.clash[0]!)}`
    : `el ID ${id} está fuera de los rangos de app.json`
}

function findingText(finding: Finding): string {
  const object = `${finding.decl.type} ${finding.decl.name}`
  const reason = reasonText(finding)
  const lead = finding.problem === 'sin-id' ? `${object} ${reason}` : `${object}: ${reason}`
  if (!finding.canAssign) return `${lead}. Ya existe en otras ramas, así que no lo cambio`
  const others = finding.others.map(other => `${poolLabel(other.pool)} ${other.id ?? 'lleno'}`).join(' · ')
  const hasOthers = others !== '' && finding.proposal !== undefined
  return `${lead} → ${proposalText(finding)}${hasOthers ? ` · otros rangos: ${others}` : ''}`
}

/**
 * One line for an object's findings. Declared once per pool (`#if OnPrem`
 * ... `#else`), it reads as one object with one proposal per pool.
 */
export function describeGroup(group: readonly Finding[]): string {
  const first = group[0]!
  const isOnePerPool = group.length > 1 && group.every(one => one.canAssign && one.pool !== undefined)
  if (!isOnePerPool) return group.map(findingText).join('; ')
  const ids = group.map(one => `${poolLabel(one.pool!)} ${one.proposal ?? 'lleno'}`).join(' · ')
  const reasons = [...new Set(group.map(reasonText))]
  const object = `${first.decl.type} ${first.decl.name}`
  const lead = reasons.length === 1 && reasons[0] === 'sin ID' ? `${object} sin ID` : `${object}: ${reasons.join('; ')}`
  return `${lead} → ${ids}`
}
