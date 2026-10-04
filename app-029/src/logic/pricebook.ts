/**
 * 供货商价目表批量录入与试算（纯逻辑，无网络、无 Vue 依赖，便于自检）：
 * - 粘贴整表 → 自动识别「材料名称 / 规格 / 单位 / 单价 / 生效日期」五列（顺序任意，可含多余列）；
 * - 全角半角、多余空格、大小写、中文/英文单位统一归一；
 * - 逐行校验：缺列、单价为空/零/负/非法、日期非法、同一种材料同一天重复、名称对不上本店价目；
 * - 解析通过后按「生效日期 ≤ 取价日取最近一条」生成生效价目，覆盖到 Preset 各单价字段；
 * - 试算：同一项目用「旧价 Preset / 换价后 Preset」各算一遍 BOM，逐行、逐单给出差额，按影响排序。
 * 金额一律整数「分」。
 */

import { buildBom } from './materials'
import type { Preset } from './materials'
import type { Project } from './types'
import type { LayoutResult } from './layout'

// ---------------------------------------------------------------------------
// 1. 归一化
// ---------------------------------------------------------------------------

/** 全角 ASCII（！～ 0xFF01-0xFF5E）转半角，全角空格转普通空格；其余字符不动（不做 NFKC，避免误伤汉字） */
export function toHalfWidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0)
    else out += ch
  }
  return out
}

/** 文本归一：全角→半角、括号统一、合并连续空白（不改变大小写，单位归一另行处理） */
export function normalizeText(s: string): string {
  return toHalfWidth(s)
    .replace(/[（｛【]/g, '(')
    .replace(/[）｝】]/g, ')')
    .replace(/[，、；]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把尺寸连接符统一成半角 x（×/X/＊/x 都算同一个写法） */
function unifyDim(s: string): string {
  return s.toLowerCase().replace(/[×✕＊*]/g, 'x')
}

/** 用于名称/规格比对的紧凑键：小写、去全部空白、连接符统一 */
export function compactKey(s: string): string {
  return unifyDim(normalizeText(s)).replace(/\s+/g, '')
}

const UNIT_ALIASES: Record<string, string> = {
  平方米: '㎡',
  平米: '㎡',
  平方: '㎡',
  'm2': '㎡',
  'm²': '㎡',
  '㎡': '㎡',
  米: '米',
  公尺: '米',
  m: '米',
  只: '只',
  个: '只',
  支: '支',
  管: '支',
  pcs: '只',
  台: '台',
  套: '套',
  组: '套',
  张: '张',
  片: '张',
  字: '字',
  瓦: '瓦',
  w: '瓦'
}

/** 单位归一：大小写、中文/英文、上标 ² 等写法统一到本店口径（㎡/米/只/台/支/套/张/字/瓦） */
export function normalizeUnit(raw: string): string {
  const s = unifyDim(normalizeText(raw).toLowerCase()).replace(/\s+/g, '')
  if (!s) return ''
  if (UNIT_ALIASES[s]) return UNIT_ALIASES[s]
  // 「m²」经全角转换后可能写作 m2
  if (s === 'm2' || s === 'm²') return '㎡'
  return s
}

/** 单价解析：接受 38、38.5、¥38.50、1,200.00、38.5元/支、３８．５（全角）等；返回整数分或 null */
export function parsePrice(raw: string): { cents: number | null; reason: string } {
  const s0 = normalizeText(raw)
  if (!s0) return { cents: null, reason: '单价为空' }
  let s = s0.replace(/[¥￥$€]/g, '').replace(/,/g, '').replace(/\s+/g, '')
  // 去掉货币/计价单位尾巴：38.5元、38.50 元/支
  s = s.replace(/元.*$/, '')
  if (s === '') return { cents: null, reason: '单价为空' }
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return { cents: null, reason: `单价「${normalizeText(raw)}」不是数字` }
  const n = Number(s)
  if (!Number.isFinite(n)) return { cents: null, reason: `单价「${normalizeText(raw)}」不是数字` }
  if (n === 0) return { cents: null, reason: '单价为 0' }
  if (n < 0) return { cents: null, reason: `单价为负（${n}）` }
  return { cents: Math.round(n * 100), reason: '' }
}

/** 日期解析：2026-10-01 / 2026/10/1 / 2026.10.01 / 20261001 / 2026年10月1日；返回 YYYY-MM-DD 或 null */
export function parseDate(raw: string): string | null {
  const s = normalizeText(raw).replace(/\s+/g, '')
  if (!s) return null
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  // 真实日历日校验（拒绝 2026-02-31）
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  if (y < 2000 || y > 2100) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// 2. 本店价目目录（由 Preset 构造，粘贴表中的行必须能对到其中一种材料）
// ---------------------------------------------------------------------------

export type PriceTargetType = 'sheet' | 'ledModule' | 'consumable' | 'labor' | 'psuWatt' | 'panelArea' | 'panelPerimeter' | 'panelLabor'

export interface PriceTarget {
  type: PriceTargetType
  /** sheet/ledModule/consumable/labor 用 preset 项 id；面板类用 `${panelMaterialId}`；电源用 'psu' */
  id: string
  /** 界面显示名 */
  label: string
  /** 本店口径单位 */
  unit: string
  /** 当前生效单价（分），面板按米/按字类同 */
  currentPriceCents: number
}

export function buildCatalog(preset: Preset): PriceTarget[] {
  const targets: PriceTarget[] = []
  for (const s of preset.acrylicSheets) {
    targets.push({ type: 'sheet', id: s.id, label: s.spec, unit: '张', currentPriceCents: s.priceCents })
  }
  for (const m of preset.ledModules) {
    targets.push({ type: 'ledModule', id: m.id, label: m.spec, unit: '只', currentPriceCents: m.priceCents })
  }
  targets.push({ type: 'psuWatt', id: 'psu', label: '防水开关电源 IP67（12V/24V，按每瓦单价）', unit: '瓦', currentPriceCents: preset.psu.pricePerWattCents })
  for (const c of preset.consumables) {
    targets.push({ type: 'consumable', id: c.id, label: c.spec, unit: c.unit, currentPriceCents: c.unitPriceCents })
  }
  for (const l of preset.labor) {
    targets.push({ type: 'labor', id: l.id, label: l.spec, unit: l.unit, currentPriceCents: l.unitPriceCents })
  }
  for (const pm of preset.panelMaterials) {
    targets.push({ type: 'panelArea', id: pm.id, label: `${pm.name}（按面积计价）`, unit: '㎡', currentPriceCents: pm.areaPriceCentsPerM2 })
    targets.push({ type: 'panelPerimeter', id: pm.id, label: `${pm.name}（按米周长计价）`, unit: '米', currentPriceCents: pm.perimeterPriceCentsPerM })
    targets.push({ type: 'panelLabor', id: pm.id, label: `${pm.name}（按字加工费）`, unit: '字', currentPriceCents: pm.charLaborCents })
  }
  return targets
}

/** 拆比对记号：CJK 逐字、字母数字串（保留小数点，如 1.44、3030） */
function tokens(s: string): string[] {
  return unifyDim(s).toLowerCase().match(/[一-鿿]|[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? []
}

export interface MatchResult {
  target: PriceTarget | null
  /** 同单位口径下命中多个，需写全规格 */
  ambiguous: PriceTarget[]
  /** 名称+规格唯一确定了一种材料，但供货商单位写法（如装配按 PCS）与本店口径（字）不一致，已按本店口径取价 */
  unitMismatch: boolean
}

/** 名称+规格 对目录做包含式匹配：本行每个记号都要出现在某个目录项里 */
export function matchTarget(nameNorm: string, specNorm: string, unitNorm: string, catalog: PriceTarget[]): MatchResult {
  const rowTokens = tokens(compactKey(`${nameNorm} ${specNorm}`))
  if (rowTokens.length === 0) return { target: null, ambiguous: [], unitMismatch: false }
  const containsAll = (t: PriceTarget): boolean => {
    const hay = compactKey(t.label)
    return rowTokens.every((tok) => hay.includes(tok))
  }
  /**
   * 多个候选时只按「本行额外命中的关键区分词」决出唯一：
   * 计算行内记号在候选标签里除公共前缀外的辨识度，出现型号级差异词（12v/24v、功率/亮度/灯数）且唯一才采信；
   * 无法唯一区分就一律报歧义，绝不乱配价。
   */
  const resolve = (hits: PriceTarget[], unitMismatch: boolean): MatchResult => {
    if (hits.length === 1) return { target: hits[0], ambiguous: [], unitMismatch }
    // 统计每个候选独有的“区分记号”：仅出现在该候选标签中的行内 token
    let unique: PriceTarget | null = null
    let uniqueCount = 0
    for (const t of hits) {
      const hay = compactKey(t.label)
      const others = hits.filter((x) => x !== t)
      const distinguishing = rowTokens.filter((tok) => others.every((o) => !compactKey(o.label).includes(tok)) && hay.includes(tok))
      if (distinguishing.length > 0) {
        unique = t
        uniqueCount += 1
      }
    }
    if (uniqueCount === 1 && unique) return { target: unique, ambiguous: [], unitMismatch }
    return { target: null, ambiguous: hits, unitMismatch: false }
  }

  // 1) 先要求单位口径一致
  const hitSame = catalog.filter((t) => t.unit === unitNorm && containsAll(t))
  if (hitSame.length > 0) return resolve(hitSame, false)

  // 2) 单位口径不一致时，名称+规格在整份目录里唯一确定一种材料，才按本店单位取价（软提示）
  const hitAny = catalog.filter(containsAll)
  if (hitAny.length === 1) return { target: hitAny[0], ambiguous: [], unitMismatch: true }
  if (hitAny.length > 1) {
    const r = resolve(hitAny, true)
    if (r.target) return r
  }
  return { target: null, ambiguous: [], unitMismatch: false }
}

// ---------------------------------------------------------------------------
// 3. 粘贴整表解析与列识别
// ---------------------------------------------------------------------------

export type DupPolicy = 'reject' | 'last' | 'keep'

export const DUP_POLICY_LABEL: Record<DupPolicy, string> = {
  reject: '拦下重复（默认，最稳）',
  last: '留最后一条（同材料同天后写的覆盖先写的）',
  keep: '两条都留（取价日按最近录入取价）'
}

export type ColumnKey = 'name' | 'spec' | 'unit' | 'price' | 'date'

export interface ColumnMap {
  name: number
  spec: number
  unit: number
  price: number
  date: number
}

const HEADER_KEYWORDS: Record<ColumnKey, string[]> = {
  name: ['材料名称', '材料', '名称', '品名', '物料', '商品名称', '商品', '项目名称', '货名'],
  spec: ['规格型号', '规格/型号', '规格', '型号', '产品规格'],
  unit: ['计量单位', '单位'],
  price: ['含税单价', '单价(元)', '单价（元）', '单价元', '最新单价', '报价单价', '单价', '价格', '报价'],
  date: ['生效日期', '执行日期', '启用日期', '调价日期', '生效时间', '生效', '执行', '启用', '日期']
}

function splitCells(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim())
  // 退化到 CSV：支持引号包裹的字段
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQ = !inQ
      }
    } else if (ch === ',' && !inQ) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

/** 行号一律按粘贴内容物理行计（首行 = 1，通常即表头），错误提示直接引用该号 */
export interface ParsedRow {
  /** 物理行号（1 起，含表头） */
  lineNo: number
  name: string
  spec: string
  unit: string
  priceText: string
  dateText: string
  nameNorm: string
  specNorm: string
  unitNorm: string
  priceCents: number | null
  date: string | null
  target: PriceTarget | null
  errors: string[]
  /** 单位写法与本店口径不一致但已按本店取价的软提示 */
  warnings: string[]
  /** reject：重复错误；last：先条 dropped / 后条 kept；keep：kept 两条 */
  dupTag?: 'dup-error' | 'dropped' | 'kept'
  dupOfLine?: number
}

export interface ParseTableResult {
  /** 识别到的表头物理行号（1 起） */
  headerLine: number | null
  columns: ColumnMap | null
  /** 表头级错误（缺列等），存在时整批拦下 */
  tableErrors: string[]
  rows: ParsedRow[]
}

function scoreHeader(cells: string[]): { map: ColumnMap; score: number } | null {
  const map: Partial<Record<ColumnKey, number>> = {}
  const used = new Set<number>()
  // 按关键词特异性从高到低认领列，避免「单价」抢掉「生效日期」之类
  const order: ColumnKey[] = ['spec', 'date', 'name', 'unit', 'price']
  for (const key of order) {
    let best = -1
    let bestLen = -1
    cells.forEach((c, i) => {
      if (used.has(i)) return
      const text = normalizeText(c)
      const kw = HEADER_KEYWORDS[key].find((k) => text.includes(k))
      if (kw && kw.length > bestLen) {
        best = i
        bestLen = kw.length
      }
    })
    if (best >= 0) {
      map[key] = best
      used.add(best)
    }
  }
  if (map.name !== undefined && map.spec !== undefined && map.unit !== undefined && map.price !== undefined && map.date !== undefined) {
    return { map: map as ColumnMap, score: used.size }
  }
  return null
}

export function parsePastedTable(text: string, policy: DupPolicy, catalog: PriceTarget[]): ParseTableResult {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  // 找得分最高的表头行（最多扫前 15 行）
  let headerLine: number | null = null
  let columns: ColumnMap | null = null
  let bestScore = 0
  lines.slice(0, 15).forEach((line, idx) => {
    if (!line.trim()) return
    const hit = scoreHeader(splitCells(line))
    if (hit && hit.score > bestScore) {
      bestScore = hit.score
      columns = hit.map
      headerLine = idx + 1
    }
  })

  if (!columns) {
    // 指出究竟缺哪几列，便于供货商改表头
    const present = new Set<ColumnKey>()
    const firstCells = lines.find((l) => l.trim()) ? splitCells(lines.find((l) => l.trim()) as string) : []
    for (const key of ['name', 'spec', 'unit', 'price', 'date'] as ColumnKey[]) {
      if (firstCells.some((c) => HEADER_KEYWORDS[key].some((k) => normalizeText(c).includes(k)))) present.add(key)
    }
    const missingNames: Record<ColumnKey, string> = { name: '材料名称', spec: '规格', unit: '单位', price: '单价', date: '生效日期' }
    const missing = (['name', 'spec', 'unit', 'price', 'date'] as ColumnKey[]).filter((k) => !present.has(k)).map((k) => missingNames[k])
    return {
      headerLine: null,
      columns: null,
      tableErrors: [
        `未能识别表头：缺少「${missing.join('、')}」列（或表头不在前 15 行）。`,
        '表头需包含：材料名称 / 规格 / 单位 / 单价 / 生效日期（列的顺序不限，多余列会被忽略）。'
      ],
      rows: []
    }
  }

  const cm = columns as ColumnMap
  const rows: ParsedRow[] = []
  lines.forEach((line, idx) => {
    const lineNo = idx + 1
    if (lineNo <= (headerLine as number)) return
    if (!line.trim()) return // 空行跳过、不编号
    const cells = splitCells(line)
    const cell = (i: number): string => (i < cells.length ? cells[i] : '')
    const name = normalizeText(cell(cm.name))
    const spec = normalizeText(cell(cm.spec))
    const unitRaw = cell(cm.unit)
    const priceText = normalizeText(cell(cm.price))
    const dateText = normalizeText(cell(cm.date))
    const errors: string[] = []
    const warnings: string[] = []

    if (!name) errors.push('材料名称为空')
    const unitNorm = unitRaw.trim() ? normalizeUnit(unitRaw) : ''
    if (!unitNorm) errors.push('单位为空或无法识别')
    const price = parsePrice(priceText)
    if (price.cents === null) errors.push(price.reason)
    const date = parseDate(dateText)
    if (!date) errors.push(dateText ? `生效日期「${dateText}」写法不合法` : '生效日期为空（支持 2026-10-01 / 2026/10/1 / 2026年10月1日 / 20261001）')

    let target: PriceTarget | null = null
    if (name && unitNorm) {
      const m = matchTarget(name, spec, unitNorm, catalog)
      if (m.ambiguous.length > 0) {
        errors.push(`材料同时对得上 ${m.ambiguous.length} 项：${m.ambiguous.slice(0, 3).map((t) => t.label).join('；')}${m.ambiguous.length > 3 ? '…' : ''}，请把规格写全`)
      } else if (!m.target) {
        errors.push('本店价目里没有这种材料（名称/规格对不上，或单位不是本店口径）')
      } else {
        target = m.target
        if (m.unitMismatch) warnings.push(`供货商单位「${unitRaw.trim()}」按本店口径「${m.target.unit}」计（名称+规格唯一匹配，已自动归并）`)
      }
    }

    rows.push({
      lineNo,
      name,
      spec,
      unit: normalizeText(unitRaw),
      priceText,
      dateText,
      nameNorm: name,
      specNorm: spec,
      unitNorm,
      priceCents: price.cents,
      date,
      target,
      errors,
      warnings
    })
  })

  // 同材料同生效日期重复：归一后的材料（已对上目录用目录身份，没对上用名称+规格+单位）+ 日期
  // 本行若本身已有其它错误（如日期非法），不具备参与“同生效日重复”判定的资格，避免一条错行株连其它行
  const groups = new Map<string, ParsedRow[]>()
  for (const r of rows) {
    if (!r.date || r.errors.length > 0) continue
    const matKey = r.target ? `${r.target.type}:${r.target.id}` : `raw:${compactKey(r.nameNorm)}|${compactKey(r.specNorm)}|${r.unitNorm}`
    const key = `${matKey}@${r.date}`
    const arr = groups.get(key) ?? []
    arr.push(r)
    groups.set(key, arr)
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    if (policy === 'reject') {
      // 同一天出现多条同材料：全部拦下，错误里互相指出行号
      for (let i = 0; i < arr.length; i++) {
        const others = arr.map((r) => r.lineNo).filter((n) => n !== arr[i].lineNo)
        arr[i].errors.push(`同一种材料在 ${arr[0].date} 重复出现（第 ${others.join('、')} 行也是）`)
        arr[i].dupTag = 'dup-error'
        arr[i].dupOfLine = others[0]
      }
    } else if (policy === 'last') {
      for (let i = 0; i < arr.length - 1; i++) {
        arr[i].dupTag = 'dropped'
        arr[i].dupOfLine = arr[arr.length - 1].lineNo
      }
      arr[arr.length - 1].dupTag = 'kept'
    } else {
      for (const r of arr) r.dupTag = 'kept'
    }
  }

  return { headerLine, columns, tableErrors: [], rows }
}

/** 可提交的行：无任何错误；last 策略下被后条覆盖的行不提交 */
export function committableRows(parsed: ParsedRow[]): ParsedRow[] {
  return parsed.filter((r) => r.errors.length === 0 && r.dupTag !== 'dropped')
}

// ---------------------------------------------------------------------------
// 4. 价目簿存储模型与生效解析
// ---------------------------------------------------------------------------

export interface PriceEntry {
  id: string
  /** 入库序号，越大越新（同生效日多版本时决定取价） */
  seq: number
  batchId: string
  targetType: PriceTargetType
  targetId: string
  /** 落库时的目录标签快照，便于后来材料改名仍能审计 */
  label: string
  unit: string
  /** 供货商原始写法，审计用 */
  rawName: string
  rawSpec: string
  priceCents: number
  effectiveDate: string
}

export interface PriceBatch {
  id: string
  supplier: string
  note: string
  appliedAt: number
  /** 该批内出现的生效日期 */
  dates: string[]
  entryCount: number
  status: 'applied' | 'reverted'
  revertedAt?: number
}

export interface PriceAuditEvent {
  at: number
  kind: 'commit' | 'revert'
  batchId: string
  detail: string
}

export interface PriceBook {
  /** 单调递增的条目序号 */
  seq: number
  entries: PriceEntry[]
  batches: PriceBatch[]
  audit: PriceAuditEvent[]
}

export function emptyBook(): PriceBook {
  return { seq: 0, entries: [], batches: [], audit: [] }
}

export function batchLabel(b: PriceBatch): string {
  const t = new Date(b.appliedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}${b.supplier ? ` · ${b.supplier}` : ''}`
}

/** 某取价日实际参与取价的批次（条目所属批次状态为 applied） */
function liveEntries(book: PriceBook): PriceEntry[] {
  const liveBatches = new Set(book.batches.filter((b) => b.status === 'applied').map((b) => b.id))
  return book.entries.filter((e) => liveBatches.has(e.batchId))
}

/** 取价口径：effectiveDate ≤ asOf 取最近日期；同一天多条取最新入库（seq 最大） */
export function activeEntriesAt(book: PriceBook, asOf: string): Map<string, PriceEntry> {
  const out = new Map<string, PriceEntry>()
  for (const e of liveEntries(book)) {
    if (e.effectiveDate > asOf) continue
    const key = `${e.targetType}:${e.targetId}`
    const cur = out.get(key)
    if (!cur || e.effectiveDate > cur.effectiveDate || (e.effectiveDate === cur.effectiveDate && e.seq > cur.seq)) {
      out.set(key, e)
    }
  }
  return out
}

/** 把生效条目覆盖到一份深拷贝的 Preset 上（绝不改原 preset） */
export function applyEntriesToPreset(preset: Preset, entries: Iterable<PriceEntry>): Preset {
  const next: Preset = JSON.parse(JSON.stringify(preset))
  for (const e of entries) {
    switch (e.targetType) {
      case 'sheet': {
        const t = next.acrylicSheets.find((x) => x.id === e.targetId)
        if (t) t.priceCents = e.priceCents
        break
      }
      case 'ledModule': {
        const t = next.ledModules.find((x) => x.id === e.targetId)
        if (t) t.priceCents = e.priceCents
        break
      }
      case 'consumable': {
        const t = next.consumables.find((x) => x.id === e.targetId)
        if (t) t.unitPriceCents = e.priceCents
        break
      }
      case 'labor': {
        const t = next.labor.find((x) => x.id === e.targetId)
        if (t) t.unitPriceCents = e.priceCents
        break
      }
      case 'psuWatt':
        next.psu.pricePerWattCents = e.priceCents
        break
      case 'panelArea': {
        const t = next.panelMaterials.find((x) => x.id === e.targetId)
        if (t) t.areaPriceCentsPerM2 = e.priceCents
        break
      }
      case 'panelPerimeter': {
        const t = next.panelMaterials.find((x) => x.id === e.targetId)
        if (t) t.perimeterPriceCentsPerM = e.priceCents
        break
      }
      case 'panelLabor': {
        const t = next.panelMaterials.find((x) => x.id === e.targetId)
        if (t) t.charLaborCents = e.priceCents
        break
      }
    }
  }
  return next
}

export function effectivePreset(preset: Preset, book: PriceBook, asOf: string): Preset {
  return applyEntriesToPreset(preset, activeEntriesAt(book, asOf).values())
}

/** 取价口径说明（报价单脚注用）：列出最近生效批次 */
export function pricingSummary(book: PriceBook, asOf: string): string {
  const active = activeEntriesAt(book, asOf)
  if (active.size === 0) return `取价口径：内置/预设单价（截至 ${asOf} 无已生效调价批次）`
  const batchIds = new Set([...active.values()].map((e) => e.batchId))
  const batches = book.batches.filter((b) => batchIds.has(b.id)).sort((a, b) => b.appliedAt - a.appliedAt)
  const latest = batches[0]
  return `取价口径：${asOf} 当天生效价目（共 ${active.size} 项，最近批次 ${batchLabel(latest)}）`
}

// ---------------------------------------------------------------------------
// 5. 提交一批 / 整批退回（纯函数操作 book，落盘由 store 包一层）
// ---------------------------------------------------------------------------

let tempSeq = 0
function genId(prefix: string): string {
  tempSeq += 1
  return `${prefix}${Date.now().toString(36)}${tempSeq}${Math.random().toString(36).slice(2, 5)}`
}

export interface CommitResult {
  book: PriceBook
  batch: PriceBatch
  /** 本次被覆盖的、原先同一天生效的旧条目数（退回本批后它们自动恢复） */
  coveredCount: number
  changes: string[]
}

/**
 * 把校验通过并勾选的行提交成一个批次。
 * 同一材料同一天若此前已有生效条目：新条目 seq 更大自动成为取价版本（旧条目不删，退回本批即恢复）。
 */
export function commitRows(book: PriceBook, rows: ParsedRow[], meta: { supplier?: string; note?: string; appliedAt?: number }): CommitResult {
  const next: PriceBook = JSON.parse(JSON.stringify(book))
  const batchId = genId('b')
  const appliedAt = meta.appliedAt ?? Date.now()
  const dates = [...new Set(rows.map((r) => r.date as string))].sort()
  const entries: PriceEntry[] = []
  const changes: string[] = []
  let coveredCount = 0

  for (const r of rows) {
    if (!r.target || r.priceCents === null || !r.date) continue
    next.seq += 1
    const key = `${r.target.type}:${r.target.id}`
    const prev = liveEntries(next)
      .filter((e) => `${e.targetType}:${e.targetId}` === key && e.effectiveDate === r.date)
      .sort((a, b) => b.seq - a.seq)[0]
    if (prev) coveredCount += 1
    entries.push({
      id: genId('e'),
      seq: next.seq,
      batchId,
      targetType: r.target.type,
      targetId: r.target.id,
      label: r.target.label,
      unit: r.target.unit,
      rawName: r.name,
      rawSpec: r.spec,
      priceCents: r.priceCents,
      effectiveDate: r.date
    })
    changes.push(
      `${r.target.label}（${r.date} 生效）：${prev ? `${(prev.priceCents / 100).toFixed(2)} 元 → ` : ''}${(r.priceCents / 100).toFixed(2)} 元${prev ? '（同日旧价被覆盖）' : '（新增价目）'}`
    )
  }

  const batch: PriceBatch = {
    id: batchId,
    supplier: (meta.supplier ?? '').trim(),
    note: (meta.note ?? '').trim(),
    appliedAt,
    dates,
    entryCount: entries.length,
    status: 'applied'
  }
  next.entries.push(...entries)
  next.batches.unshift(batch)
  next.audit.unshift({
    at: appliedAt,
    kind: 'commit',
    batchId,
    detail: `提交批次 ${changes.length} 条${coveredCount ? `，覆盖同日旧价 ${coveredCount} 条` : ''}；生效日期 ${dates.join('、')}`
  })
  return { book: next, batch, coveredCount, changes }
}

export interface RevertResult {
  book: PriceBook
  batch: PriceBatch
  affectedEntries: PriceEntry[]
}

/** 整批退回：批次标记 reverted，其条目退出取价（数据保留在审计里）；被它盖掉的旧价自动重新生效 */
export function revertBatch(book: PriceBook, batchId: string, at: number = Date.now()): RevertResult | null {
  const batch = book.batches.find((b) => b.id === batchId)
  if (!batch || batch.status !== 'applied') return null
  const next: PriceBook = JSON.parse(JSON.stringify(book))
  const tb = next.batches.find((b) => b.id === batchId) as PriceBatch
  tb.status = 'reverted'
  tb.revertedAt = at
  const affectedEntries = next.entries.filter((e) => e.batchId === batchId)
  next.audit.unshift({
    at,
    kind: 'revert',
    batchId,
    detail: `整批退回 ${affectedEntries.length} 条价目（原批次 ${batchLabel(batch)}）；被该批盖掉的旧价自动恢复`
  })
  return { book: next, batch: tb, affectedEntries }
}

// ---------------------------------------------------------------------------
// 6. 试算：这批新价换上后，已算过的单据每单差多少
// ---------------------------------------------------------------------------

export interface ImpactLine {
  group: string
  spec: string
  unit: string
  qty: number
  oldPriceCents: number
  newPriceCents: number
  oldAmountCents: number
  newAmountCents: number
  deltaCents: number
}

export interface OrderImpact {
  projectId: string
  projectName: string
  oldTotalCents: number
  newTotalCents: number
  deltaCents: number
  lines: ImpactLine[]
}

export interface TrialInput {
  project: Project
  layout: LayoutResult
}

/**
 * @param asOf 取价日（默认取本批最晚生效日，即“全部换上之后”的口径）
 */
export function simulateImpacts(
  basePreset: Preset,
  currentBook: PriceBook,
  trialRows: ParsedRow[],
  asOf: string,
  inputs: TrialInput[]
): OrderImpact[] {
  // 试算簿：已落库价目 + 本批勾选项（作为新批次的临时条目，不落盘）
  const trialBook: PriceBook = JSON.parse(JSON.stringify(currentBook))
  const tempBatchId = '__trial__'
  for (const r of trialRows) {
    if (!r.target || r.priceCents === null || !r.date || r.errors.length > 0 || r.dupTag === 'dropped') continue
    trialBook.seq += 1
    trialBook.entries.push({
      id: `trial-${r.lineNo}`,
      seq: trialBook.seq,
      batchId: tempBatchId,
      targetType: r.target.type,
      targetId: r.target.id,
      label: r.target.label,
      unit: r.target.unit,
      rawName: r.name,
      rawSpec: r.spec,
      priceCents: r.priceCents,
      effectiveDate: r.date
    })
  }
  trialBook.batches.push({
    id: tempBatchId,
    supplier: '',
    note: '',
    appliedAt: Date.now(),
    dates: [],
    entryCount: 0,
    status: 'applied'
  })

  const oldPreset = effectivePreset(basePreset, currentBook, asOf)
  const newPreset = effectivePreset(basePreset, trialBook, asOf)

  const impacts: OrderImpact[] = []
  for (const { project, layout } of inputs) {
    const oldBom = buildBom(project, layout, oldPreset)
    const newBom = buildBom(project, layout, newPreset)
    const newMap = new Map(newBom.materials.map((m) => [`${m.kind}|${m.spec}|${m.unit}`, m]))
    const lines: ImpactLine[] = []
    for (const om of oldBom.materials) {
      const nm = newMap.get(`${om.kind}|${om.spec}|${om.unit}`)
      if (!nm) continue
      const delta = nm.amountCents - om.amountCents
      if (delta === 0) continue
      lines.push({
        group: om.kind,
        spec: om.spec,
        unit: om.unit,
        qty: om.qty,
        oldPriceCents: om.unitPriceCents,
        newPriceCents: nm.unitPriceCents,
        oldAmountCents: om.amountCents,
        newAmountCents: nm.amountCents,
        deltaCents: delta
      })
    }
    const deltaTotal = newBom.totalCents - oldBom.totalCents
    if (deltaTotal !== 0 || lines.length > 0) {
      // 完整性：逐行差额合计必须等于整单合计差（新旧 BOM 条目集一致时恒成立；
      // 若未来 BOM 结构随单价变化会在这里暴露，而不是给出对不上的数）
      const lineSum = lines.reduce((s, l) => s + l.deltaCents, 0)
      if (lineSum !== deltaTotal) {
        lines.push({
          group: 'acrylic',
          spec: '（其它随价目联动的取整/取档差异）',
          unit: '',
          qty: 0,
          oldPriceCents: 0,
          newPriceCents: 0,
          oldAmountCents: 0,
          newAmountCents: 0,
          deltaCents: deltaTotal - lineSum
        })
      }
      impacts.push({
        projectId: project.id,
        projectName: project.name,
        oldTotalCents: oldBom.totalCents,
        newTotalCents: newBom.totalCents,
        deltaCents: deltaTotal,
        lines
      })
    }
  }
  // 影响从大到小（按差额绝对值）
  return impacts.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
}
