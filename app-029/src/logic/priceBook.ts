/**
 * 供货商价目表批量录入与试算：
 * - 粘贴整张表（Excel 复制出的 TSV / CSV / 空白分隔），自动识别「材料名称 / 规格 / 单位 / 单价 / 生效日期」列；
 * - 归一化：全角→半角、去多余空白、英文小写、乘号统一、单位中文/符号统一（毫米→mm、平方米→㎡）；
 * - 逐行校验：缺列、单价为零或为负、日期写法不合法、同一种材料同一天重复；
 *   重复取舍先定：「留最后一条」（默认，早行被覆盖不写入）或「两条都留」（取价时同键以靠后行为准）；
 * - 与店内材料（板材/LED 模组/胶与配件/加工费）按归一化键 + 单位自动关联；
 * - 试算：换价前后重算本机已保存单据的合计差额；确认后写入本地价目库并记批次，
 *   报价单按「当天生效的最新版本」取价。
 * 全部为纯函数 + localStorage，不发任何网络请求。
 */

import type { Preset } from './materials'

export type ColRole = 'name' | 'spec' | 'unit' | 'price' | 'date' | 'ignore'
/** 同材料同日重复的取舍：last=留最后一条；keep=两条都留（取价时同键以靠后行为准） */
export type DupPolicy = 'last' | 'keep'
export type TargetSection = 'sheet' | 'led' | 'consumable' | 'labor'

/** 店内可定价条目（由 Preset 展开，供价目行关联） */
export interface PriceTarget {
  section: TargetSection
  id: string
  label: string
  unitNorm: string
  keyNorm: string
}

export interface ParsedRow {
  /** 原始行号（从 1 起，含表头行），与 Excel 行号一致 */
  lineNo: number
  cells: string[]
  name: string
  spec: string
  unit: string
  priceText: string
  dateText: string
  /** 归一化键：名称|规格|单位|生效日期 */
  key: string
  priceCents: number | null
  /** 归一化后的生效日期 YYYY-MM-DD */
  date: string | null
  issues: string[]
  /** 重复取舍为「留最后一条」时，本行被哪一行覆盖（不写入） */
  dupOf: number | null
  dupNote: string
  /** 关联到的店内材料（未关联为 null，仅入价目库、不影响单据） */
  target: PriceTarget | null
  checked: boolean
}

export interface ParsedTable {
  hasHeader: boolean
  columns: string[]
  mapping: ColRole[]
  rows: ParsedRow[]
  /** 表格级错误（如识别不出名称列/单价列） */
  error: string
}

export interface PriceEntry {
  id: string
  batchId: string
  name: string
  spec: string
  unit: string
  key: string
  unitPriceCents: number
  effectiveDate: string
  createdAt: number
  target: { section: TargetSection; id: string; label: string } | null
}

export interface PriceBatchItem {
  name: string
  spec: string
  unit: string
  priceCents: number
  effectiveDate: string
  targetLabel: string
  /** 写入前该店内材料的当前取价（未关联为 null） */
  oldCents: number | null
}

export interface PriceBatch {
  id: string
  createdAt: number
  items: PriceBatchItem[]
}

export interface PriceBookData {
  entries: PriceEntry[]
  batches: PriceBatch[]
}

export interface AppliedPrice {
  section: TargetSection
  id: string
  label: string
  oldCents: number
  newCents: number
  effectiveDate: string
  entryName: string
}

// ---------- 归一化 ----------

/** 全角英数标点 → 半角，全角空格 → 空格 */
export function toHalfWidth(s: string): string {
  return (s ?? '').replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ')
}

/** 名称/规格归一：全角→半角、乘号统一、去全部空白、英文小写、中文单位→符号 */
export function normalizeText(raw: string): string {
  let s = toHalfWidth(raw)
  s = s.replace(/[xX*✕✖]/g, '×')
  s = s.replace(/\s+/g, '')
  s = s.toLowerCase()
  s = s.replace(/平方米|平米/g, '㎡').replace(/毫米/g, 'mm').replace(/厘米/g, 'cm')
  return s
}

const UNIT_ALIAS: Record<string, string> = {
  m2: '㎡',
  'm²': '㎡',
  平方: '㎡',
  米: 'm',
  公斤: 'kg',
  千克: 'kg',
  克: 'g',
  升: 'l',
  毫升: 'ml'
}

/** 单位归一：在 normalizeText 基础上再处理「米/m」「m2/㎡」等单位写法 */
export function normalizeUnit(raw: string): string {
  const s = normalizeText(raw)
  return UNIT_ALIAS[s] ?? s
}

const KNOWN_UNITS = new Set([
  '张', '只', '台', '支', '套', '个', '字', '件', '根', '块', '条', '卷', '瓶', '罐', '桶', '箱', '包', '组', '对',
  '米', 'm', 'mm', 'cm', '㎡', 'm2', 'm²', '平方米', '平米', '公斤', 'kg', '克', 'g', '升', 'l', '毫升', 'ml',
  '小时', '工', '项', '次'
])

function isKnownUnit(s: string): boolean {
  return KNOWN_UNITS.has(s.trim()) || KNOWN_UNITS.has(normalizeUnit(s))
}

// ---------- 单价 / 日期解析 ----------

/** 解析单价为整数「分」；支持 ¥/￥/元/千分位逗号/全角数字；非法返回 null */
export function parsePriceCents(raw: string): number | null {
  const s = toHalfWidth(raw).trim().replace(/[¥￥,，\s]/g, '').replace(/元$/, '')
  if (!/^-?\d+(\.\d{1,6})?$/.test(s)) return null
  const cents = Math.round(Number(s) * 100)
  return Number.isFinite(cents) ? cents : null
}

/** 解析日期为 YYYY-MM-DD；支持 - / . 年月日 分隔与 8 位连写；非法（如 2026-13-01）返回 null */
export function parseDateText(raw: string): string | null {
  const s = toHalfWidth(raw).trim()
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s)
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 今天（本地日期）YYYY-MM-DD */
export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- 表格解析与列识别 ----------

function splitCells(line: string): string[] {
  if (line.includes('\t')) return line.split('\t')
  if (line.includes(',')) return line.split(',')
  if (line.includes('，') || line.includes('；')) return line.split(/[，；]/)
  if (/ {2,}/.test(line)) return line.split(/ {2,}/)
  return [line]
}

const HEADER_RES: Array<[ColRole, RegExp]> = [
  ['date', /生效|日期|执行|调价/],
  ['price', /单价|价格|售价|金额/],
  ['unit', /单位/],
  ['spec', /规格|型号|尺寸|参数/],
  ['name', /名称|品名|材料|物料|项目/]
]

function detectMapping(header: string[], data: Array<{ cells: string[] }>, n: number): ColRole[] {
  const mapping: ColRole[] = Array<ColRole>(n).fill('ignore')
  const used = new Set<number>()
  // 1) 表头关键词优先
  for (const [role, re] of HEADER_RES) {
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue
      if (header[i] && re.test(header[i])) {
        mapping[i] = role
        used.add(i)
        break
      }
    }
  }
  // 2) 内容推断补全（date 要先于 price 占列：20261001 两种都解析得出）
  const colValues = (i: number): string[] => data.map((d) => (d.cells[i] ?? '').trim()).filter((v) => v !== '')
  const ratio = (i: number, f: (s: string) => boolean): number => {
    const vs = colValues(i)
    return vs.length ? vs.filter(f).length / vs.length : 0
  }
  const ensure = (role: ColRole, score: (i: number) => number, min: number): void => {
    if (mapping.includes(role)) return
    let best = -1
    let bs = min
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue
      const s = score(i)
      if (s > bs) {
        bs = s
        best = i
      }
    }
    if (best >= 0) {
      mapping[best] = role
      used.add(best)
    }
  }
  ensure('date', (i) => ratio(i, (v) => parseDateText(v) !== null), 0.6)
  ensure('price', (i) => ratio(i, (v) => { const c = parsePriceCents(v); return c !== null && c > 0 }), 0.6)
  ensure('unit', (i) => ratio(i, (v) => isKnownUnit(v)), 0.6)
  ensure('name', (i) => ratio(i, (v) => !/^[\d.,]+$/.test(v)), 0.5)
  ensure('spec', (i) => ratio(i, (v) => v !== '' && !/^[\d.,]+$/.test(v)), 0.3)
  return mapping
}

/** 把粘贴文本解析成表格：切行列 + 自动识别列角色（尚未做行级校验） */
export function parsePriceTable(text: string): ParsedTable {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ lineNo: i + 1, cells: splitCells(l) }))
    .filter((x) => x.cells.some((c) => c.trim() !== ''))
  const empty: ParsedTable = { hasHeader: false, columns: [], mapping: [], rows: [], error: '' }
  if (lines.length === 0) {
    empty.error = '没有可解析的数据行'
    return empty
  }
  const n = Math.max(...lines.map((l) => l.cells.length))
  const first = lines[0]
  const headerHit = first.cells.filter((c) => HEADER_RES.some(([, re]) => re.test(c))).length
  const hasHeader = headerHit >= 1 && lines.length > 1
  const headerCells = hasHeader ? first.cells : []
  const columns = Array.from({ length: n }, (_, i) => (headerCells[i] ?? '').trim() || `第${i + 1}列`)
  const mapping = detectMapping(headerCells.map((c) => c ?? ''), hasHeader ? lines.slice(1) : lines, n)
  const dataLines = hasHeader ? lines.slice(1) : lines
  const rows: ParsedRow[] = dataLines.map((l) => ({
    lineNo: l.lineNo,
    cells: l.cells,
    name: '',
    spec: '',
    unit: '',
    priceText: '',
    dateText: '',
    key: '',
    priceCents: null,
    date: null,
    issues: [],
    dupOf: null,
    dupNote: '',
    target: null,
    checked: false
  }))
  return { hasHeader, columns, mapping, rows, error: '' }
}

// ---------- 行级校验 ----------

export interface ValidateOptions {
  dupPolicy: DupPolicy
  /** 表中没有日期列时，整批统一使用的生效日期 */
  defaultDate: string
}

/** 按当前列映射提取字段、归一化并逐行校验（就地更新 table.rows，可重复调用） */
export function validateRows(table: ParsedTable, targets: PriceTarget[], opts: ValidateOptions): void {
  const colOf = (role: ColRole): number => table.mapping.indexOf(role)
  const ci = { name: colOf('name'), spec: colOf('spec'), unit: colOf('unit'), price: colOf('price'), date: colOf('date') }
  table.error = ''
  if (ci.name < 0) table.error = '识别不出「材料名称」列，请在上方列映射中手动指定'
  else if (ci.price < 0) table.error = '识别不出「单价」列，请在上方列映射中手动指定'
  const defaultOk = ci.date >= 0 || parseDateText(opts.defaultDate) !== null
  if (ci.date < 0 && !defaultOk) table.error = '表中没有日期列，且「统一生效日期」写法不合法'

  for (const r of table.rows) {
    const get = (i: number): string => (i >= 0 ? (r.cells[i] ?? '').trim() : '')
    r.name = get(ci.name)
    r.spec = get(ci.spec)
    r.unit = get(ci.unit)
    r.priceText = get(ci.price)
    r.dateText = get(ci.date)
    r.issues = []
    r.dupOf = null
    r.dupNote = ''
    r.target = null

    if (!r.name) r.issues.push('缺材料名称')
    if (!r.priceText) {
      r.issues.push('缺单价')
      r.priceCents = null
    } else {
      r.priceCents = parsePriceCents(r.priceText)
      if (r.priceCents === null) r.issues.push(`单价「${r.priceText}」不是数字`)
      else if (r.priceCents <= 0) r.issues.push(`单价为零或为负（${r.priceText}）`)
    }
    if (ci.date >= 0) {
      if (!r.dateText) {
        r.issues.push('缺生效日期')
        r.date = null
      } else {
        r.date = parseDateText(r.dateText)
        if (r.date === null) r.issues.push(`日期「${r.dateText}」写法不合法`)
      }
    } else {
      r.date = parseDateText(opts.defaultDate)
      r.dateText = opts.defaultDate
    }
    const key = `${normalizeText(r.name)}|${normalizeText(r.spec)}|${normalizeUnit(r.unit)}`
    r.key = `${key}|${r.date ?? `?${r.dateText}`}`
    if (r.issues.length === 0) {
      r.target = matchTarget(normalizeText(r.name), normalizeText(r.spec), normalizeUnit(r.unit), targets)
    }
  }

  // 同一种材料同一天重复：按事先定好的取舍处理
  const groups = new Map<string, ParsedRow[]>()
  for (const r of table.rows) {
    if (r.issues.length > 0) continue
    const g = groups.get(r.key)
    if (g) g.push(r)
    else groups.set(r.key, [r])
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const nos = g.map((r) => r.lineNo)
    for (const r of g) {
      const others = nos.filter((n) => n !== r.lineNo).join('、')
      r.dupNote = `与第 ${others} 行同材料同日重复`
    }
    if (opts.dupPolicy === 'last') {
      const last = g[g.length - 1]
      for (const r of g) {
        if (r !== last) r.dupOf = last.lineNo
      }
    }
  }

  for (const r of table.rows) {
    r.checked = r.issues.length === 0 && r.dupOf === null
  }
}

// ---------- 与店内材料关联 ----------

export function presetTargets(preset: Preset): PriceTarget[] {
  const out: PriceTarget[] = []
  for (const s of preset.acrylicSheets) out.push({ section: 'sheet', id: s.id, label: s.spec, unitNorm: normalizeUnit('张'), keyNorm: normalizeText(s.spec) })
  for (const m of preset.ledModules) out.push({ section: 'led', id: m.id, label: m.spec, unitNorm: normalizeUnit('只'), keyNorm: normalizeText(m.spec) })
  for (const c of preset.consumables) out.push({ section: 'consumable', id: c.id, label: c.spec, unitNorm: normalizeUnit(c.unit), keyNorm: normalizeText(c.spec) })
  for (const l of preset.labor) out.push({ section: 'labor', id: l.id, label: l.spec, unitNorm: normalizeUnit(l.unit), keyNorm: normalizeText(l.spec) })
  return out
}

/** 归一化键互相包含 + 单位一致即关联；多个候选取键最长（最具体）者 */
export function matchTarget(nameNorm: string, specNorm: string, unitNorm: string, targets: PriceTarget[]): PriceTarget | null {
  const rowKey = nameNorm + specNorm
  if (rowKey.length < 2 || !unitNorm) return null
  let best: PriceTarget | null = null
  for (const t of targets) {
    if (t.unitNorm !== unitNorm) continue
    if (!(t.keyNorm.includes(rowKey) || rowKey.includes(t.keyNorm))) continue
    if (!best || t.keyNorm.length > best.keyNorm.length) best = t
  }
  return best
}

export function targetPriceCents(preset: Preset, t: { section: TargetSection; id: string }): number | null {
  switch (t.section) {
    case 'sheet':
      return preset.acrylicSheets.find((s) => s.id === t.id)?.priceCents ?? null
    case 'led':
      return preset.ledModules.find((m) => m.id === t.id)?.priceCents ?? null
    case 'consumable':
      return preset.consumables.find((c) => c.id === t.id)?.unitPriceCents ?? null
    case 'labor':
      return preset.labor.find((l) => l.id === t.id)?.unitPriceCents ?? null
    default:
      return null
  }
}

// ---------- 按生效日期取价 ----------

/**
 * 以 date 当天生效的价目覆盖 preset 单价，返回新 preset（深拷贝，不改原对象）。
 * 同一材料取「生效日期 ≤ date 的最新一条」；同日期多条以录入顺序靠后者为准。
 */
export function applyToPreset(base: Preset, entries: PriceEntry[], date: string): { preset: Preset; applied: AppliedPrice[] } {
  const preset: Preset = JSON.parse(JSON.stringify(base))
  const best = new Map<string, PriceEntry>()
  for (const e of entries) {
    if (!e.target || e.effectiveDate > date) continue
    const k = `${e.target.section}|${e.target.id}`
    const prev = best.get(k)
    if (!prev || prev.effectiveDate < e.effectiveDate || (prev.effectiveDate === e.effectiveDate && prev.createdAt <= e.createdAt)) {
      best.set(k, e)
    }
  }
  const applied: AppliedPrice[] = []
  for (const e of best.values()) {
    const t = e.target as { section: TargetSection; id: string; label: string }
    const oldCents = targetPriceCents(preset, t)
    if (oldCents === null) continue
    if (t.section === 'sheet') {
      const it = preset.acrylicSheets.find((s) => s.id === t.id)
      if (it) it.priceCents = e.unitPriceCents
    } else if (t.section === 'led') {
      const it = preset.ledModules.find((m) => m.id === t.id)
      if (it) it.priceCents = e.unitPriceCents
    } else if (t.section === 'consumable') {
      const it = preset.consumables.find((c) => c.id === t.id)
      if (it) it.unitPriceCents = e.unitPriceCents
    } else {
      const it = preset.labor.find((l) => l.id === t.id)
      if (it) it.unitPriceCents = e.unitPriceCents
    }
    applied.push({
      section: t.section,
      id: t.id,
      label: t.label,
      oldCents,
      newCents: e.unitPriceCents,
      effectiveDate: e.effectiveDate,
      entryName: `${e.name} ${e.spec}`.trim()
    })
  }
  applied.sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0))
  return { preset, applied }
}
