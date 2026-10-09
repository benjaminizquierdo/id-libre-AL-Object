import { expect, test } from 'claude-code/testing'

import {
  applyAssignments,
  branchesText,
  changedFiles,
  describeGroup,
  freeIds,
  groupFindings,
  parseDecls,
  plan,
  poolFor,
  readGrep,
  readModel,
  repeatedIds,
} from '../hooks/al'
import type { Used } from '../hooks/al'

const APP_JSON = `{
  "id": "00000000-0000-0000-0000-000000000000",
  "name": "Demo",
  "idRanges":[
    // ---- Saas ----
    {
      "from": 51600,
      "to": 51799
    },
    // ---- OnPrem ----
    {
      "from": 7149215,
      "to": 7149234
    },
    {
      "from": 7268230,
      "to": 7268249
    }
  ],
  "resourceExposurePolicy": {
    "allowDebugging": false,
    // ,"applyToDevExtension": false
  },
  "preprocessorSymbols": ["OnPrem"]
}`

const OBJIDCONFIG = `{
  "idRanges": [
    { "from": 51600, "to": 51799, "description": "Saas" },
    { "from": 7149215, "to": 7149234, "description": "OnPrem1" },
    { "from": 7268230, "to": 7268249, "description": "OnPrem2" }
  ]
}`

const DUAL_NEW = [
  '#if OnPrem',
  'codeunit Id TCNnuevoATR',
  '#else',
  'codeunit Id TCNnuevoATR',
  '#endif',
  '',
  '{',
  '}',
].join('\r\n')

/** What the branches declare: codeunits 51600-51621 and every OnPrem one up to 7268233. */
function branchUse(): { used: Used; known: Set<string> } {
  const lines: string[] = []
  for (let i = 0; i < 22; i++) {
    lines.push(`aaa:src/C${i}.Codeunit.al\0codeunit ${51600 + i} TCNc${i}ATR`)
    const onPrem = i < 20 ? 7149215 + i : 7268230 + i - 20
    lines.push(`aaa:src/C${i}.Codeunit.al\0codeunit ${onPrem} TCNc${i}ATR`)
  }
  lines.push('bbb:src/C22.Codeunit.al\0codeunit 7268230 TCNc22ATR')
  lines.push('bbb:src/C23.Codeunit.al\0codeunit 7268231 TCNc23ATR')
  lines.push('bbb:src/C24.Codeunit.al\0codeunit 7268232 TCNc24ATR')
  lines.push('bbb:src/C25.Codeunit.al\0codeunit 7268233 TCNc25ATR')
  const used: Used = new Map()
  const known = new Set<string>()
  const names = new Map([
    ['aaa', ['main', 'origin/main']],
    ['bbb', ['origin/feature']],
  ])
  readGrep(lines.join('\n'), names, used, known)
  return { used, known }
}

test('ranges: comments in app.json name the pools, a trailing number joins them', async () => {
  const model = readModel(APP_JSON)
  expect(model.pools.map(pool => pool.name)).toEqual(['Saas', 'OnPrem'])
  expect(model.pools[1]!.ranges.map(range => range.from)).toEqual([7149215, 7268230])
})

test('ranges: .objidconfig descriptions name them too, and a single unnamed range stays one pool', async () => {
  const model = readModel('{ "idRanges": [ { "from": 51600, "to": 51799 }, { "from": 7149215, "to": 7149234 }, { "from": 7268230, "to": 7268249 } ] }', OBJIDCONFIG)
  expect(model.pools.map(pool => pool.name)).toEqual(['Saas', 'OnPrem'])
  const plain = readModel('{ "idRange": { "from": 50100, "to": 50149 } }')
  expect(plain.pools).toHaveLength(1)
  expect(plain.pools[0]!.name).toBe('')
  const typed = readModel(APP_JSON, '{ "objectRanges": { "table": [ { "from": 51700, "to": 51709, "description": "Tablas" } ] } }')
  expect(typed.typePools.table?.[0]!.ranges[0]!.from).toBe(51700)
})

test('declarations: placeholders, missing IDs and #if chains; code lines are not declarations', async () => {
  const decls = parseDecls(DUAL_NEW)
  expect(decls.map(decl => [decl.type, decl.idText, decl.name, decl.line])).toEqual([
    ['codeunit', 'Id', 'TCNnuevoATR', 1],
    ['codeunit', 'Id', 'TCNnuevoATR', 3],
  ])
  const more = parseDecls(
    [
      'table "Customer Bonus"',
      'pageextension 0 "Bonus Ext" extends "Customer Card"',
      'Table 51610 "Old (Copy)"',
      'permissionset 51600 TCNperms',
      '{',
      '    Permissions = table "Customer Bonus" = X,',
      '        page "Customer Card" = X;',
      '    // table 51611 Commented',
      '}',
      '/* codeunit 51612 InABlock',
      '   table structure */',
    ].join('\n'),
  )
  expect(more.map(decl => [decl.type, decl.id, decl.name])).toEqual([
    ['table', undefined, 'Customer Bonus'],
    ['pageextension', 0, 'Bonus Ext'],
    ['table', 51610, 'Old (Copy)'],
    ['permissionset', 51600, 'TCNperms'],
  ])
})

test('pools: #if OnPrem takes OnPrem, #else the other, no #if the first', async () => {
  const model = readModel(APP_JSON)
  const [onPrem, saas] = parseDecls(DUAL_NEW)
  expect(poolFor(onPrem!, model.pools).name).toBe('OnPrem')
  expect(poolFor(saas!, model.pools).name).toBe('Saas')
  expect(poolFor(parseDecls('codeunit Id X')[0]!, model.pools).name).toBe('Saas')
  expect(poolFor(parseDecls('#if not OnPrem\ncodeunit Id X\n#endif')[0]!, model.pools).name).toBe('Saas')
})

test('plan: a new object declared once per pool gets one free ID from each', async () => {
  const { used, known } = branchUse()
  const findings = plan({ model: readModel(APP_JSON), files: [{ file: 'src/New.Codeunit.al', decls: parseDecls(DUAL_NEW) }], used, known })
  expect(findings.map(one => [one.problem, one.pool?.name, one.proposal])).toEqual([
    ['sin-id', 'OnPrem', 7268234],
    ['sin-id', 'Saas', 51622],
  ])
  expect(describeGroup(findings)).toBe('codeunit TCNnuevoATR sin ID → OnPrem 7268234 · Saas 51622')
})

test('plan: a copied file keeps an ID another object has; a rename in place does not clash', async () => {
  const { used, known } = branchUse()
  const model = readModel(APP_JSON)
  const copied = plan({ model, files: [{ file: 'src/Copy.Codeunit.al', decls: parseDecls('codeunit 51603 TCNcopyATR') }], used, known })
  expect(copied.map(one => [one.problem, one.canAssign, one.proposal])).toEqual([['duplicado', true, 51622]])
  expect(describeGroup(copied)).toBe(
    'codeunit TCNcopyATR: el ID 51603 ya lo usa TCNc3ATR (main) → 51622 (Saas) · otros rangos: OnPrem 7268234',
  )
  const dual = parseDecls('#if OnPrem\ncodeunit 7149215 TCNcopyATR\n#else\ncodeunit 51600 TCNcopyATR\n#endif')
  const both = plan({ model, files: [{ file: 'src/Copy.Codeunit.al', decls: dual }], used, known })
  expect(describeGroup(both)).toBe(
    'codeunit TCNcopyATR: el ID 7149215 ya lo usa TCNc0ATR (main); el ID 51600 ya lo usa TCNc0ATR (main) → OnPrem 7268234 · Saas 51622',
  )
  expect(branchesText(['20250225.1020.BIC', 'origin/20250225.1020.BIC', 'main', 'origin/main'])).toBe('20250225.1020.BIC +1')
  const renamed = plan({ model, files: [{ file: 'src/C3.Codeunit.al', decls: parseDecls('codeunit 51603 TCNrenamedATR') }], used, known })
  expect(renamed).toHaveLength(0)
})

test('plan: an object the branches already have is never renumbered, only reported', async () => {
  const { used, known } = branchUse()
  const findings = plan({ model: readModel(APP_JSON), files: [{ file: 'src/Other.al', decls: parseDecls('codeunit 51604 TCNc3ATR') }], used, known })
  expect(findings.map(one => [one.problem, one.canAssign, one.proposal])).toEqual([['duplicado', false, undefined]])
  expect(describeGroup(findings)).toMatch(/no lo cambio/)
})

test('plan: of two new objects typed with the same ID, the first keeps it', async () => {
  const model = readModel(APP_JSON)
  const findings = plan({
    model,
    files: [
      { file: 'src/A.al', decls: parseDecls('codeunit 51650 TCNaATR') },
      { file: 'src/B.al', decls: parseDecls('codeunit 51650 TCNbATR') },
      { file: 'src/C.al', decls: parseDecls('codeunit 123 TCNcATR') },
    ],
    used: new Map(),
    known: new Set(),
  })
  expect(findings.map(one => [one.file, one.problem, one.proposal])).toEqual([
    ['src/B.al', 'duplicado', 51651],
    ['src/C.al', 'fuera-de-rango', 51652],
  ])
})

test('a single range with no name: the plain next number, written in place', async () => {
  const model = readModel('{ "idRanges": [ { "from": 50100, "to": 50149 } ] }')
  const used: Used = new Map()
  const known = new Set<string>()
  readGrep(
    ['a:src/A.al\0table 50100 "Customer Bonus Setup"', 'a:src/B.al\0table 50101 "Bonus Entry"', 'a:src/C.al\0page 50100 "Bonus Card"'].join('\n'),
    new Map([['a', ['main']]]),
    used,
    known,
  )
  const text = 'table Id "Bonus Ledger"\r\n{\r\n}\r\n'
  const findings = plan({ model, files: [{ file: 'src/D.al', decls: parseDecls(text) }], used, known })
  expect(describeGroup(findings)).toBe('table Bonus Ledger sin ID → 50102')
  const written = applyAssignments(text, [{ decl: findings[0]!.decl, id: findings[0]!.proposal! }])
  expect(written.text).toBe('table 50102 "Bonus Ledger"\r\n{\r\n}\r\n')
})

test('free IDs: after the highest in use, gaps only once the pool is full above', async () => {
  const model = readModel(APP_JSON)
  const saas = model.pools[0]!
  const taken = new Set([51600, 51601, 51603, 51650])
  expect(freeIds(saas, id => taken.has(id), 2)).toEqual([51651, 51652])
  const full = new Set([51602, 51799])
  expect(freeIds(saas, id => full.has(id), 2)).toEqual([51600, 51601])
  const onPrem = model.pools[1]!
  const usedOnPrem = new Set([7149215, 7268230])
  expect(freeIds(onPrem, id => usedOnPrem.has(id))).toEqual([7268231])
})

test('assignments: IDs written in place, line endings kept, a missing ID inserted', async () => {
  const text = `${DUAL_NEW}\r\n`
  const decls = parseDecls(text)
  const written = applyAssignments(text, [
    { decl: decls[0]!, id: 7268234 },
    { decl: decls[1]!, id: 51622 },
  ])
  expect(written.missed).toHaveLength(0)
  expect(written.text).toBe(text.replace('codeunit Id', 'codeunit 7268234').replace('codeunit Id', 'codeunit 51622'))
  const inserted = applyAssignments('table "Customer Bonus"\n{\n}', [{ decl: parseDecls('table "Customer Bonus"')[0]!, id: 51600 }])
  expect(inserted.text).toBe('table 51600 "Customer Bonus"\n{\n}')
  const stale = applyAssignments('codeunit 51600 Changed', [{ decl: decls[0]!, id: 1 }])
  expect(stale.missed).toHaveLength(1)
})

test('git: porcelain status and IDs two objects share', async () => {
  const porcelain = ['?? src/New.Codeunit.al', ' M src/A.al', 'R  src/B2.al', 'src/B.al', ' D src/Gone.al', 'A  README.md', ''].join('\0')
  expect(changedFiles(porcelain)).toEqual(['src/New.Codeunit.al', 'src/A.al', 'src/B2.al'])
  const used: Used = new Map()
  readGrep(
    ['a:src/X.al\0codeunit 51619 One', 'a:src/Y.al\0codeunit 51619 Two', 'b:src/Z.al\0codeunit 51630 Three', 'c:src/Z.al\0codeunit 51630 ThreeRenamed'].join('\n'),
    new Map([['a', ['main']]]),
    used,
    new Set(),
  )
  expect(repeatedIds(used).map(one => [one.id, one.owners.map(owner => owner.name)])).toEqual([[51619, ['One', 'Two']]])
  expect(groupFindings([])).toEqual([])
})
