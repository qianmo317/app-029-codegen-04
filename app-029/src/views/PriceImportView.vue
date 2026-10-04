<script setup lang="ts">
import { computed, ref } from 'vue'
import { ensureFont, fontState } from '../logic/fontLoader'
import { computeLayout } from '../logic/layout'
import { buildBom, yuan } from '../logic/materials'
import {
  applyToPreset,
  parsePriceTable,
  presetTargets,
  targetPriceCents,
  todayStr,
  validateRows,
  type ColRole,
  type DupPolicy,
  type ParsedRow,
  type PriceBatch,
  type PriceBookData,
  type PriceEntry
} from '../logic/priceBook'
import { listProjects, loadPreset, loadPriceBook, savePriceBook } from '../logic/store'

const ROLE_LABELS: Array<{ value: ColRole; label: string }> = [
  { value: 'name', label: '材料名称' },
  { value: 'spec', label: '规格' },
  { value: 'unit', label: '单位' },
  { value: 'price', label: '单价' },
  { value: 'date', label: '生效日期' },
  { value: 'ignore', label: '（忽略）' }
]

interface TrialRow {
  id: string
  name: string
  oldTotal: number
  newTotal: number
  diff: number
  note: string
}

const raw = ref('')
const table = ref<ReturnType<typeof parsePriceTable> | null>(null)
const dupPolicy = ref<DupPolicy>('last')
const defaultDate = ref(todayStr())
const trial = ref<TrialRow[] | null>(null)
const running = ref(false)
const doneMsg = ref('')
const book = ref<PriceBookData>(loadPriceBook())

const preset = loadPreset()
const targets = presetTargets(preset)

function revalidate(): void {
  if (!table.value) return
  validateRows(table.value, targets, { dupPolicy: dupPolicy.value, defaultDate: defaultDate.value })
  trial.value = null
}

function parse(): void {
  doneMsg.value = ''
  trial.value = null
  table.value = parsePriceTable(raw.value)
  revalidate()
}

function setRole(i: number, role: ColRole): void {
  const t = table.value
  if (!t) return
  // 每个角色最多占一列：其它列上的同角色先清掉
  t.mapping.forEach((r, j) => {
    if (j !== i && r === role && role !== 'ignore') t.mapping[j] = 'ignore'
  })
  t.mapping[i] = role
  revalidate()
}

const hasDateCol = computed(() => (table.value ? table.value.mapping.includes('date') : false))

const problems = computed(() => {
  const t = table.value
  if (!t) return []
  const out: string[] = []
  for (const r of t.rows) {
    for (const s of r.issues) out.push(`第 ${r.lineNo} 行：${s}`)
    if (r.dupOf !== null) out.push(`第 ${r.lineNo} 行：${r.dupNote}，按取舍「留最后一条」被第 ${r.dupOf} 行覆盖（不写入）`)
  }
  return out
})

const dupKept = computed(() => {
  const t = table.value
  if (!t || dupPolicy.value !== 'keep') return []
  return t.rows.filter((r) => r.dupNote).map((r) => `第 ${r.lineNo} 行：${r.dupNote}，两条都留，取价时以靠后行为准`)
})

const selectedRows = computed(() => {
  const t = table.value
  if (!t) return []
  return t.rows.filter((r) => r.checked && r.issues.length === 0 && r.dupOf === null)
})

const linkedCount = computed(() => selectedRows.value.filter((r) => r.target).length)

function rowToEntry(r: ParsedRow, batchId: string, createdAt: number): PriceEntry {
  return {
    id: `e${createdAt.toString(36)}`,
    batchId,
    name: r.name,
    spec: r.spec,
    unit: r.unit,
    key: r.key,
    unitPriceCents: r.priceCents as number,
    effectiveDate: r.date as string,
    createdAt,
    target: r.target ? { section: r.target.section, id: r.target.id, label: r.target.label } : null
  }
}

/** 试算：本批换上去以后，本机已保存单据的合计各差多少（按影响从大到小） */
async function runTrial(): Promise<void> {
  const rows = selectedRows.value
  if (!rows.length || running.value) return
  running.value = true
  trial.value = null
  try {
    const today = todayStr()
    const cur = loadPriceBook()
    const oldPreset = applyToPreset(loadPreset(), cur.entries, today).preset
    const pending = rows.map((r, i) => rowToEntry(r, 'trial', Date.now() + i))
    const newPreset = applyToPreset(loadPreset(), [...cur.entries, ...pending], today).preset
    const out: TrialRow[] = []
    for (const p of listProjects()) {
      try {
        await ensureFont(p.layout.settings.fontId, p.layout.settings.weight)
      } catch {
        // 字体不可用：下面 fontState 会给出标注
      }
      if (fontState(p.layout.settings.fontId, p.layout.settings.weight).state !== 'ready') {
        out.push({ id: p.id, name: p.name, oldTotal: 0, newTotal: 0, diff: 0, note: '字体不可用，无法重算该单' })
        continue
      }
      const lay = computeLayout(p.layout, { autoSize: true })
      const b0 = buildBom(p, lay, oldPreset, { acknowledgeThinStroke: true })
      const b1 = buildBom(p, lay, newPreset, { acknowledgeThinStroke: true })
      const diff = b1.totalCents - b0.totalCents
      out.push({
        id: p.id,
        name: p.name,
        oldTotal: b0.totalCents,
        newTotal: b1.totalCents,
        diff,
        note: diff === 0 ? '本批调价不涉及该单用料' : ''
      })
    }
    out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    trial.value = out
  } finally {
    running.value = false
  }
}

/** 确认写入：勾选的价目进本机价目库，并记一批「改了哪几条、从哪天起生效」 */
function commit(): void {
  const rows = selectedRows.value
  if (!rows.length) return
  const now = Date.now()
  const batchId = `b${now.toString(36)}`
  const today = todayStr()
  const cur = loadPriceBook()
  const oldPreset = applyToPreset(loadPreset(), cur.entries, today).preset
  const entries = rows.map((r, i) => rowToEntry(r, batchId, now + i))
  const batch: PriceBatch = {
    id: batchId,
    createdAt: now,
    items: rows.map((r) => ({
      name: r.name,
      spec: r.spec,
      unit: r.unit,
      priceCents: r.priceCents as number,
      effectiveDate: r.date as string,
      targetLabel: r.target?.label ?? '（未关联店内材料，仅入价目库）',
      oldCents: r.target ? targetPriceCents(oldPreset, r.target) : null
    }))
  }
  const next: PriceBookData = { entries: [...cur.entries, ...entries], batches: [batch, ...cur.batches] }
  savePriceBook(next)
  book.value = next
  doneMsg.value = `已写入 ${rows.length} 条价目（批次 ${batchId}），各条自其生效日期起生效；报价单按当天生效版本取价。`
  table.value = null
  raw.value = ''
  trial.value = null
}

/** 整批退回：不写入任何价目 */
function rejectAll(): void {
  table.value = null
  raw.value = ''
  trial.value = null
  doneMsg.value = '已整批退回，未写入任何价目。'
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}
</script>

<template>
  <div class="page">
    <section class="card">
      <header>
        <h1>供货商价目批量录入</h1>
        <span class="hint">整张表粘进来 → 自动认列 → 归一 → 逐行校验 → 试算 → 确认写入</span>
      </header>
      <p class="muted">
        从 Excel/微信里复制整张价目表粘贴到下面（制表符、逗号或连续空格分列均可；首行可以是表头）。
        需要「材料名称、单价」两列；「规格、单位、生效日期」可缺，缺日期列时整批用统一生效日期。
      </p>
      <textarea
        v-model="raw"
        rows="8"
        style="width: 100%; font-family: monospace"
        placeholder="材料名称	规格	单位	单价	生效日期&#10;亚克力板	1220×2440×3mm	张	288.00	2026-10-01&#10;LED 模组	2835 双灯	只	1.45	2026-10-01"
      ></textarea>
      <div class="row" style="margin-top: 8px">
        <button class="primary" :disabled="!raw.trim()" @click="parse">解析表格</button>
        <span class="tag ok" v-if="doneMsg">{{ doneMsg }}</span>
      </div>
    </section>

    <template v-if="table">
      <section class="card">
        <header>
          <h2>① 列识别与归一化</h2>
          <span class="hint">{{ table.hasHeader ? '已按表头自动识别，可手动改' : '未检测到表头，已按内容推断，可手动改' }}</span>
        </header>
        <div class="row" style="flex-wrap: wrap; gap: 10px">
          <label v-for="(c, i) in table.columns" :key="i" class="mono" style="display: flex; align-items: center; gap: 4px">
            {{ c }}
            <select :value="table.mapping[i]" @change="setRole(i, ($event.target as HTMLSelectElement).value as ColRole)">
              <option v-for="r in ROLE_LABELS" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
          </label>
        </div>
        <div class="field" v-if="!hasDateCol" style="margin-top: 10px">
          <label>统一生效日期（表中没有日期列）</label>
          <div class="ctl"><input type="text" v-model="defaultDate" style="width: 140px" @change="revalidate" /></div>
        </div>
        <div class="field" style="margin-top: 10px">
          <label>同一种材料同一天重复出现的取舍（先定再校验）</label>
          <div class="ctl">
            <label><input type="radio" value="last" v-model="dupPolicy" @change="revalidate" /> 留最后一条（早的行被覆盖，不写入）</label>
            <label style="margin-left: 14px"><input type="radio" value="keep" v-model="dupPolicy" @change="revalidate" /> 两条都留（取价时同键以靠后行为准）</label>
          </div>
        </div>
        <p class="muted">
          归一化规则：全角→半角、去掉多余空格、英文统一小写、×/x/* 统一为×、毫米→mm、平方米→㎡、单位大写或中文按同一词表归一。
          写法不同的同一材料会归一成同一条目再校验与关联。
        </p>
        <div v-if="table.error" class="banner bad">{{ table.error }}</div>
      </section>

      <section class="card">
        <header>
          <h2>② 逐行校验</h2>
          <span class="hint">
            共 {{ table.rows.length }} 行；可写入 {{ selectedRows.length }} 行（其中关联店内材料 {{ linkedCount }} 行）
          </span>
        </header>
        <div v-if="problems.length" class="banner bad">
          <b>拦下 {{ problems.length }} 处问题：</b>
          <ul class="notes" style="color: inherit">
            <li v-for="(p, i) in problems" :key="i">{{ p }}</li>
          </ul>
        </div>
        <div v-if="dupKept.length" class="banner warn">
          <ul class="notes" style="color: inherit">
            <li v-for="(p, i) in dupKept" :key="i">{{ p }}</li>
          </ul>
        </div>
        <table>
          <thead>
            <tr>
              <th>行号</th><th>材料名称</th><th>规格</th><th>单位</th>
              <th class="num">单价（元）</th><th>生效日期</th><th>关联店内材料</th><th>状态</th><th>写入</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in table.rows" :key="r.lineNo" :style="r.issues.length || r.dupOf !== null ? 'opacity:.55' : ''">
              <td class="mono">{{ r.lineNo }}</td>
              <td>{{ r.name || '—' }}</td>
              <td>{{ r.spec || '—' }}</td>
              <td>{{ r.unit || '—' }}</td>
              <td class="num">{{ r.priceCents === null ? r.priceText || '—' : yuan(r.priceCents) }}</td>
              <td class="mono">{{ r.date ?? r.dateText ?? '—' }}</td>
              <td>{{ r.target ? r.target.label : '（未关联，仅入价目库）' }}</td>
              <td>
                <span v-if="r.issues.length" class="tag bad">{{ r.issues[0] }}</span>
                <span v-else-if="r.dupOf !== null" class="tag warn">被第 {{ r.dupOf }} 行覆盖</span>
                <span v-else class="tag ok">通过</span>
              </td>
              <td>
                <input type="checkbox" v-model="r.checked" :disabled="r.issues.length > 0 || r.dupOf !== null" @change="trial = null" />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="card">
        <header>
          <h2>③ 试算影响</h2>
          <span class="hint">校验通过的勾选行换上去，重算本机已保存单据，按影响从大到小排列</span>
        </header>
        <div class="row">
          <button class="primary" :disabled="!selectedRows.length || running" @click="runTrial">
            {{ running ? '试算中…' : `试算这 ${selectedRows.length} 条换上去的影响` }}
          </button>
          <span class="muted" v-if="problems.length">错误行与被覆盖行已自动排除，不参与试算与写入。</span>
        </div>
        <table v-if="trial" style="margin-top: 10px">
          <thead>
            <tr>
              <th>单据（项目）</th><th class="num">现合计（元）</th><th class="num">换价后（元）</th><th class="num">差额（元）</th><th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in trial" :key="t.id">
              <td>{{ t.name }}</td>
              <td class="num">{{ t.note && !t.oldTotal ? '—' : yuan(t.oldTotal) }}</td>
              <td class="num">{{ t.note && !t.oldTotal ? '—' : yuan(t.newTotal) }}</td>
              <td class="num" :style="t.diff > 0 ? 'color:var(--danger);font-weight:700' : t.diff < 0 ? 'color:var(--ok,#2a7);font-weight:700' : ''">
                {{ t.note && !t.oldTotal ? '—' : (t.diff > 0 ? '+' : '') + yuan(t.diff) }}
              </td>
              <td class="muted">{{ t.note }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="trial && !trial.length" class="muted">本机还没有已保存的单据，换价不影响任何单据。</p>
      </section>

      <section class="card">
        <header>
          <h2>④ 确认写入 / 整批退回</h2>
          <span class="hint">写入后记录本批改了哪几条、从哪天起生效</span>
        </header>
        <div class="row">
          <button class="primary" :disabled="!selectedRows.length" @click="commit">确认写入 {{ selectedRows.length }} 条</button>
          <button class="danger" @click="rejectAll">整批退回</button>
        </div>
      </section>
    </template>

    <section class="card">
      <header>
        <h2>改价记录</h2>
        <span class="hint">价目库累计 {{ book.entries.length }} 条 · {{ book.batches.length }} 批</span>
      </header>
      <p v-if="!book.batches.length" class="muted">暂无写入记录。确认写入后，这里记清每批改了哪几条、从哪天起生效。</p>
      <div v-for="b in book.batches" :key="b.id" class="card" style="padding: 10px 12px; margin-bottom: 10px">
        <header style="margin-bottom: 6px">
          <h3>批次 {{ b.id }}</h3>
          <span class="hint">{{ fmtTime(b.createdAt) }} · {{ b.items.length }} 条</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>材料</th><th>规格</th><th>单位</th><th class="num">新单价（元）</th><th>生效日期</th><th>关联店内材料</th><th class="num">原取价（元）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, i) in b.items" :key="i">
              <td>{{ it.name }}</td>
              <td>{{ it.spec || '—' }}</td>
              <td>{{ it.unit || '—' }}</td>
              <td class="num">{{ yuan(it.priceCents) }}</td>
              <td class="mono">{{ it.effectiveDate }}</td>
              <td>{{ it.targetLabel }}</td>
              <td class="num">{{ it.oldCents === null ? '—' : yuan(it.oldCents) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
