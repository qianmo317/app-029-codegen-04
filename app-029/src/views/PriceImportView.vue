<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ensureFont } from '../logic/fontLoader'
import { computeLayout } from '../logic/layout'
import { yuan } from '../logic/materials'
import {
  batchLabel,
  buildCatalog,
  commitRows,
  committableRows,
  DUP_POLICY_LABEL,
  parsePastedTable,
  pricingSummary,
  revertBatch,
  simulateImpacts,
  todayIso,
  type DupPolicy,
  type OrderImpact,
  type PriceBook
} from '../logic/pricebook'
import { listProjects, loadPreset, loadPriceBook, savePriceBook } from '../logic/store'

const SAMPLE = `材料名称\t规格\t单位\t单价\t生效日期
亚克力专用结构胶 300ml\t亚克力专用结构胶 300ml\t支\t42.00\t2026-10-15
亚克力专用结构胶300ml\t亚克力专用结构胶300ml\t支\t45\t2026-11-01
ＬＥＤ 模组 12V 0.72W 60lm 单灯（3030）\tLED 模组 12V 0.72W 60lm 单灯（3030）\t个\t０．９５\t2026/10/15
亚克力板 1220×2440×3mm\t亚克力板 1220×2440×3mm（透明/乳白）\t张\t310\t2026年10月15日
面板切割/雕刻（含异形修边）\t面板切割/雕刻（含异形修边）\t㎡\t-5\t2026-10-15
不锈钢挂件/自攻螺丝（每字 4 套）\t不锈钢挂件/自攻螺丝（每字 4 套）\t套\t0.6\t2026-10-15
电源线 RVV 2×1.0mm²\t电源线 RVV 2×1.0mm²\t米\t0\t2026.10.15
不锈钢挂件/自攻螺丝（每字4套）\t不锈钢挂件/自攻螺丝（每字 4 套）\t套\t0.8\t2026-10-15
发光字装配（面板+扣边+接线）\t发光字装配（面板+扣边+接线）\tPCS\t40\t20261015`

const pasted = ref('')
const policy = ref<DupPolicy>('reject')
const supplier = ref('')
const note = ref('')
const book = ref<PriceBook>(loadPriceBook())
const basePreset = ref(loadPreset())
const selected = ref<Set<number>>(new Set())
const impacts = ref<OrderImpact[] | null>(null)
const trialAsOf = ref('')
const expandedImpact = ref<string | null>(null)
const resultMsg = ref('')
const confirmRevertId = ref<string | null>(null)

const catalog = computed(() => buildCatalog(basePreset.value))
const parsed = computed(() => (pasted.value.trim() ? parsePastedTable(pasted.value, policy.value, catalog.value) : null))

const errorRows = computed(() => (parsed.value ? parsed.value.rows.filter((r) => r.errors.length > 0) : []))
const validRows = computed(() => (parsed.value ? committableRows(parsed.value.rows) : []))
const droppedRows = computed(() => (parsed.value ? parsed.value.rows.filter((r) => r.dupTag === 'dropped') : []))

const headerDesc = computed(() => {
  const p = parsed.value
  if (!p || !p.columns) return ''
  const c = p.columns
  return `识别到表头在第 ${p.headerLine} 行：名称→第${c.name + 1}列 · 规格→第${c.spec + 1}列 · 单位→第${c.unit + 1}列 · 单价→第${c.price + 1}列 · 日期→第${c.date + 1}列（其余列忽略）`
})

/** 本次粘贴里同一种材料 + 同一天实际会提交几条（last/keep 策略下可能 >1） */
const trialRows = computed(() => {
  if (!parsed.value) return []
  return validRows.value.filter((r) => selected.value.has(r.lineNo) && r.date)
})

/** 试算取价日：默认本批最晚生效日（=“全部换上之后”的口径） */
const trialDate = computed(() => {
  if (trialAsOf.value) return trialAsOf.value
  const dates = trialRows.value.map((r) => r.date).filter((d): d is string => !!d).sort()
  return dates.length ? dates[dates.length - 1] : todayIso()
})

// 粘贴内容 / 重复取舍一变，旧的勾选与试算作废，避免拿过期结果提交
watch([pasted, policy], () => {
  selected.value = new Set()
  impacts.value = null
  trialAsOf.value = ''
  resultMsg.value = ''
})
// 勾选变化后旧试算已与当前选择不符（保留取价日覆盖）
watch(trialRows, () => {
  impacts.value = null
})

const allValidSelected = computed({
  get: () => validRows.value.length > 0 && validRows.value.every((r) => selected.value.has(r.lineNo)),
  set: (v: boolean) => {
    const next = new Set(selected.value)
    for (const r of validRows.value) {
      if (v) next.add(r.lineNo)
      else next.delete(r.lineNo)
    }
    selected.value = next
  }
})

function toggleRow(lineNo: number): void {
  const next = new Set(selected.value)
  if (next.has(lineNo)) next.delete(lineNo)
  else next.add(lineNo)
  selected.value = next
}

function loadSample(): void {
  pasted.value = SAMPLE
  resultMsg.value = ''
}

function clearAll(): void {
  pasted.value = ''
  selected.value = new Set()
  impacts.value = null
  resultMsg.value = ''
  trialAsOf.value = ''
}

// ---------- 已算过的单据：本地项目 + 字体就绪后可重算 BOM ----------
async function buildInputs() {
  const projects = listProjects()
  const inputs: Array<{ project: (typeof projects)[number]; layout: ReturnType<typeof computeLayout> }> = []
  for (const p of projects) {
    try {
      await ensureFont(p.layout.settings.fontId, p.layout.settings.weight)
      inputs.push({ project: p, layout: computeLayout(p.layout) })
    } catch {
      // 字体不可用的单据无法重算，跳过（极少发生，字体均本地打包）
    }
  }
  return inputs
}

async function runTrial(): Promise<void> {
  if (trialRows.value.length === 0) return
  const inputs = await buildInputs()
  impacts.value = simulateImpacts(basePreset.value, book.value, trialRows.value, trialDate.value, inputs)
  resultMsg.value = ''
}

function deltaClass(cents: number): string {
  return cents > 0 ? 'up' : cents < 0 ? 'down' : ''
}

function commit(): void {
  if (trialRows.value.length === 0) return
  const res = commitRows(book.value, trialRows.value, { supplier: supplier.value, note: note.value })
  book.value = res.book
  savePriceBook(book.value)
  resultMsg.value = `已写入本机存储：${res.batch.entryCount} 条，${res.coveredCount ? `覆盖同日旧价 ${res.coveredCount} 条；` : ''}生效日 ${res.batch.dates.join('、')}`
  impacts.value = null
  selected.value = new Set()
  trialAsOf.value = ''
}

function doRevert(batchId: string): void {
  const res = revertBatch(book.value, batchId)
  if (!res) return
  book.value = res.book
  savePriceBook(book.value)
  confirmRevertId.value = null
  resultMsg.value = `已整批退回 ${res.affectedEntries.length} 条；被该批盖掉的旧价自动恢复。`
}

const appliedBatches = computed(() => book.value.batches.filter((b) => b.status === 'applied'))
const revertedBatches = computed(() => book.value.batches.filter((b) => b.status === 'reverted'))

function entriesOf(batchId: string) {
  return book.value.entries.filter((e) => e.batchId === batchId)
}

const activeCount = computed(() => {
  const keys = new Set<string>()
  for (const e of book.value.entries) {
    if (book.value.batches.find((b) => b.id === e.batchId)?.status !== 'applied') continue
    keys.add(`${e.targetType}:${e.targetId}@${e.effectiveDate}`)
  }
  return keys.size
})
</script>

<template>
  <div class="page">
    <div class="banner ok no-print" v-if="resultMsg">{{ resultMsg }}</div>

    <div class="grid cols-2" style="align-items: start">
      <!-- 左：粘贴与校验 -->
      <section class="card">
        <header>
          <h1>供货商价目表 · 批量录入</h1>
          <span class="hint">把整张表（含表头）直接粘进来，列顺序不限</span>
        </header>

        <div class="row" style="margin-bottom: 8px">
          <button class="ghost" @click="loadSample">载入示例表（含各种错例）</button>
          <button class="ghost" @click="clearAll">清空</button>
        </div>
        <textarea
          v-model="pasted"
          rows="12"
          spellcheck="false"
          class="mono"
          placeholder="材料名称&#9;规格&#9;单位&#9;单价&#9;生效日期&#10;亚克力专用结构胶 300ml&#9;…&#9;支&#9;42.00&#9;2026-10-15&#10;（从 Excel/WPS 整表复制后粘贴，列之间是 Tab；也支持逗号 CSV）"
        ></textarea>

        <div class="field" style="margin-top: 10px">
          <label>同一种材料同一天出现多条时</label>
          <div class="ctl">
            <select v-model="policy">
              <option value="reject">{{ DUP_POLICY_LABEL.reject }}</option>
              <option value="last">{{ DUP_POLICY_LABEL.last }}</option>
              <option value="keep">{{ DUP_POLICY_LABEL.keep }}</option>
            </select>
          </div>
        </div>
        <p class="muted" style="margin: 0 0 8px">
          归一规则：全角/半角统一、多余空格合并、括号统一、×/X/x 统一、单位大小写与中英文统一（PCS/个→只、M→米、M2/平方米→㎡）。
        </p>

        <template v-if="parsed">
          <div v-if="parsed.tableErrors.length" class="banner bad">
            <div v-for="(e, i) in parsed.tableErrors" :key="i">{{ e }}</div>
          </div>

          <template v-else>
            <p class="muted mono" style="margin: 6px 0">{{ headerDesc }}</p>

            <div v-if="errorRows.length" class="banner bad">
              <b>校验拦下 {{ errorRows.length }} 行（修正后再试算/写入）：</b>
              <ul class="notes" style="margin-top: 4px">
                <li v-for="r in errorRows" :key="r.lineNo">
                  <b>第 {{ r.lineNo }} 行</b>（{{ r.name || '（无名称）' }}）：{{ r.errors.join('；') }}
                </li>
              </ul>
            </div>
            <div v-else class="banner ok">逐行校验全部通过（{{ validRows.length }} 条可提交）。</div>
            <div v-if="droppedRows.length" class="banner warn">
              按「留最后一条」取舍，以下 {{ droppedRows.length }} 行被同日后写的价格覆盖、不会提交：
              <span v-for="(r, i) in droppedRows" :key="r.lineNo">第 {{ r.lineNo }} 行<span v-if="i < droppedRows.length - 1">、</span></span>
            </div>

            <table v-if="parsed.rows.length" style="margin-top: 8px">
              <thead>
                <tr>
                  <th style="width: 30px"></th>
                  <th class="num" style="width: 44px">行</th>
                  <th>材料（归一后 → 本店目录）</th>
                  <th style="width: 40px">单位</th>
                  <th class="num" style="width: 70px">单价</th>
                  <th style="width: 92px">生效日</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in parsed.rows" :key="r.lineNo" :class="{ 'row-err': r.errors.length, 'row-drop': r.dupTag === 'dropped' }">
                  <td>
                    <input
                      type="checkbox"
                      :checked="selected.has(r.lineNo)"
                      :disabled="r.errors.length > 0 || r.dupTag === 'dropped'"
                      @change="toggleRow(r.lineNo)"
                    />
                  </td>
                  <td class="num">{{ r.lineNo }}</td>
                  <td>
                    <div>{{ r.name }} <span class="muted" v-if="r.spec && r.spec !== r.name">｜{{ r.spec }}</span></div>
                    <div v-if="r.errors.length" class="cell-err">{{ r.errors.join('；') }}</div>
                    <template v-else-if="r.target">
                      <div class="cell-ok">→ {{ r.target.label }}</div>
                      <div v-for="(w, i) in r.warnings" :key="i" class="cell-warn">{{ w }}</div>
                    </template>
                  </td>
                  <td>{{ r.unitNorm }}</td>
                  <td class="num">{{ r.priceCents !== null ? yuan(r.priceCents) : '—' }}</td>
                  <td class="mono">{{ r.date ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </template>
      </section>

      <!-- 右：试算与提交 -->
      <section class="card">
        <header>
          <h2>试算：换上这批价会影响哪些已算过的单据</h2>
          <span class="hint">同一单据用旧价 / 新价各算一遍，只看金额差</span>
        </header>

        <div class="field">
          <label>供货商 / 批次备注</label>
          <div class="ctl">
            <input type="text" v-model="supplier" placeholder="如：华彩亚克力 10 月价" style="width: 220px" />
          </div>
        </div>
        <div class="field">
          <label>试算取价日（默认本批最晚生效日）</label>
          <div class="ctl">
            <input type="date" v-model="trialAsOf" />
            <span class="muted">现按 {{ trialDate }}</span>
          </div>
        </div>

        <div class="row" style="margin: 6px 0 10px">
          <label class="row" style="gap: 6px">
            <input type="checkbox" v-model="allValidSelected" :disabled="validRows.length === 0" />
            全选可提交的 {{ validRows.length }} 条
          </label>
          <button class="primary" :disabled="trialRows.length === 0 || errorRows.length > 0" @click="runTrial">
            试算影响（勾选 {{ trialRows.length }} 条）
          </button>
        </div>

        <div v-if="errorRows.length > 0" class="muted">有 {{ errorRows.length }} 行未过校验，需先修正左侧错误。</div>

        <template v-if="impacts">
          <div v-if="impacts.length === 0" class="banner info">换上所选价目后，现有全部单据合计金额不变（没有材料被本批覆盖，或差额为 0）。确认无误后仍可在下方写入。</div>
          <template v-else>
            <h3>受影响单据（按影响从大到小，共 {{ impacts.length }} 单）</h3>
            <table>
              <thead>
                <tr>
                  <th>单据</th>
                  <th class="num">旧合计</th>
                  <th class="num">新合计</th>
                  <th class="num">差额</th>
                  <th style="width: 46px"></th>
                </tr>
              </thead>
              <tbody>
                <template v-for="im in impacts" :key="im.projectId">
                  <tr class="row-impact">
                    <td><a href="#" @click.prevent="expandedImpact = expandedImpact === im.projectId ? null : im.projectId">{{ im.projectName }}</a></td>
                    <td class="num">¥{{ yuan(im.oldTotalCents) }}</td>
                    <td class="num">¥{{ yuan(im.newTotalCents) }}</td>
                    <td class="num" :class="deltaClass(im.deltaCents)">
                      {{ im.deltaCents > 0 ? '+' : '' }}¥{{ yuan(im.deltaCents) }}
                    </td>
                    <td><button class="ghost" @click="expandedImpact = expandedImpact === im.projectId ? null : im.projectId">明细</button></td>
                  </tr>
                  <tr v-if="expandedImpact === im.projectId">
                    <td colspan="5" style="background: #fafbfd">
                      <table style="margin: 4px 0">
                        <thead>
                          <tr><th>受影响条目</th><th style="width: 44px">单位</th><th class="num">数量</th><th class="num">旧单价</th><th class="num">新单价</th><th class="num">差额</th></tr>
                        </thead>
                        <tbody>
                          <tr v-for="(ln, i) in im.lines" :key="i">
                            <td>{{ ln.spec }}</td>
                            <td>{{ ln.unit }}</td>
                            <td class="num">{{ ln.qty }}</td>
                            <td class="num">{{ yuan(ln.oldPriceCents) }}</td>
                            <td class="num">{{ yuan(ln.newPriceCents) }}</td>
                            <td class="num" :class="deltaClass(ln.deltaCents)">{{ ln.deltaCents > 0 ? '+' : '' }}¥{{ yuan(ln.deltaCents) }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </template>
        </template>

        <div class="row" style="margin-top: 12px">
          <button class="primary" :disabled="trialRows.length === 0 || errorRows.length > 0" @click="commit">
            确认写入本机存储（{{ trialRows.length }} 条）
          </button>
          <span class="muted">建议先点上方「试算影响」；写入后从各条生效日起取价，本批可随时整批退回、旧价自动恢复。</span>
        </div>

        <div class="banner info" style="margin-top: 14px">
          {{ pricingSummary(book, todayIso()) }}；已应用批次 {{ appliedBatches.length }} 个、价目条目 {{ activeCount }} 项（按“材料+生效日”去重计）。
        </div>
      </section>
    </div>

    <!-- 批次台账与整批退回 -->
    <section class="card" style="margin-top: 14px">
      <header>
        <h2>调价批次台账</h2>
        <span class="hint">记清每次改了哪几条、从哪天起生效；整批退回只对“已应用”批次可用</span>
      </header>
      <p class="muted" v-if="appliedBatches.length === 0 && revertedBatches.length === 0">尚无批次，先在上方粘表、试算并确认写入。</p>
      <table v-else>
        <thead>
          <tr>
            <th>提交时间 / 供货商</th>
            <th>生效日期</th>
            <th class="num">条数</th>
            <th>改动内容</th>
            <th style="width: 150px">状态 / 操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="b in book.batches" :key="b.id">
            <tr :class="{ 'row-reverted': b.status === 'reverted' }">
              <td>
                <div>{{ batchLabel(b) }}</div>
                <div class="muted" v-if="b.note">{{ b.note }}</div>
              </td>
              <td class="mono">{{ b.dates.join('、') }}</td>
              <td class="num">{{ b.entryCount }}</td>
              <td class="muted">
                <span v-for="(e, i) in entriesOf(b.id).slice(0, 4)" :key="e.id">
                  {{ e.label }} {{ yuan(e.priceCents) }}元@{{ e.effectiveDate }}<span v-if="i < Math.min(entriesOf(b.id).length, 4) - 1">；</span>
                </span>
                <span v-if="entriesOf(b.id).length > 4"> 等 {{ entriesOf(b.id).length }} 条</span>
              </td>
              <td>
                <template v-if="b.status === 'applied'">
                  <span class="tag ok">已应用</span>
                  <button v-if="confirmRevertId !== b.id" class="danger" style="margin-left: 6px" @click="confirmRevertId = b.id">整批退回</button>
                  <template v-else>
                    <button class="danger" @click="doRevert(b.id)">确认退回</button>
                    <button class="ghost" @click="confirmRevertId = null">取消</button>
                  </template>
                </template>
                <template v-else>
                  <span class="tag">已退回</span>
                  <span class="muted" style="margin-left: 6px">{{ b.revertedAt ? new Date(b.revertedAt).toLocaleString('zh-CN') : '' }}</span>
                </template>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <details style="margin-top: 10px">
        <summary class="muted">审计记录（提交 / 退回）</summary>
        <ul class="notes" style="margin-top: 6px">
          <li v-for="(a, i) in book.audit" :key="i" class="mono" style="font-size: 12px">
            {{ new Date(a.at).toLocaleString('zh-CN') }} · {{ a.kind === 'commit' ? '提交' : '退回' }} · {{ a.detail }}
          </li>
        </ul>
      </details>
    </section>
  </div>
</template>

<style scoped>
textarea.mono {
  font-family: var(--mono);
  font-size: 12.5px;
}

.row-err {
  background: var(--danger-soft);
}

.row-drop {
  opacity: 0.55;
}

.row-reverted {
  opacity: 0.6;
}

.row-impact {
  cursor: pointer;
}

.cell-err {
  color: var(--danger);
  font-size: 12px;
}

.cell-ok {
  color: var(--ok);
  font-size: 12px;
}

.cell-warn {
  color: var(--warn);
  font-size: 12px;
}

td.up,
span.up {
  color: var(--danger);
  font-weight: 700;
}

td.down,
span.down {
  color: var(--ok);
  font-weight: 700;
}

label.row {
  font-weight: 400;
  color: var(--ink);
}
</style>
