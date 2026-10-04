/**
 * 页面会话：项目读写 + 字体就绪 + 排版/材料/报价的响应式派生。
 * 只做本地计算与本地存储，不发网络请求。
 */

import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import { ensureFont, findFont, fontState } from './fontLoader'
import { computeLayout, type LayoutResult } from './layout'
import { buildBom, type BomResult, type BomOptions, type Preset } from './materials'
import { effectivePreset, todayIso } from './pricebook'
import { loadPreset, loadPriceBook, savePreset, saveProject } from './store'
import type { Project } from './types'

export interface Session {
  project: Ref<Project | null>
  /** 基础预设（不含供货商价目覆盖，编辑预设用） */
  basePreset: Ref<Preset>
  /** 报价实际使用：基础预设 + 截至「今天」已生效的价目批次 */
  preset: ComputedRef<Preset>
  autoFit: Ref<boolean>
  fontTick: Ref<number>
  fontText: ComputedRef<string>
  fontOk: ComputedRef<boolean>
  layout: ComputedRef<LayoutResult | null>
  layoutAt: (autoSize: boolean) => LayoutResult | null
  bom: (opts?: BomOptions) => BomResult | null
  save: () => void
  savePresetNow: () => void
  /** 价目簿变动后调用，重新计算生效价 */
  refreshPricing: () => void
  perfMs: Ref<number>
}

export function useSession(projectRef: Ref<Project | null>): Session {
  const basePreset = ref<Preset>(loadPreset())
  const autoFit = ref(true)
  const fontTick = ref(0)
  const perfMs = ref(0)
  const priceTick = ref(0)

  const preset = computed<Preset>(() => {
    void priceTick.value
    return effectivePreset(basePreset.value, loadPriceBook(), todayIso())
  })

  /** 价目簿可能在其它页面（批量录入页提交后）变化，窗口重新可见/获得焦点时刷新一次 */
  const refreshPricing = (): void => {
    priceTick.value++
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', refreshPricing)
    onUnmounted(() => window.removeEventListener('focus', refreshPricing))
  }

  const fontText = computed(() => {
    void fontTick.value
    const p = projectRef.value
    if (!p) return ''
    const st = fontState(p.layout.settings.fontId, p.layout.settings.weight)
    const f = findFont(p.layout.settings.fontId)
    const label = f ? `${f.label}（${f.family}）` : '未知字体'
    if (st.state === 'error') return `${label}：${st.message}`
    if (st.state === 'loading') return `${label}：${st.message}`
    return `${label} 字重 ${p.layout.settings.weight} · ${st.message || '未加载'}`
  })

  const fontOk = computed(() => {
    void fontTick.value
    const p = projectRef.value
    if (!p) return false
    return fontState(p.layout.settings.fontId, p.layout.settings.weight).state === 'ready'
  })

  watch(
    () => [projectRef.value?.layout.settings.fontId, projectRef.value?.layout.settings.weight] as const,
    async ([fontId, weight]) => {
      if (!fontId || !weight) return
      try {
        await ensureFont(fontId, weight)
      } catch {
        // 解析失败已在 fontState 中给出「该字体不可用」提示
      }
      fontTick.value++
    },
    { immediate: true }
  )

  const layoutAt = (autosize: boolean): LayoutResult | null => {
    const p = projectRef.value
    if (!p || !fontOk.value) return null
    const t = performance.now()
    const r = computeLayout(p.layout, { autoSize: autosize })
    perfMs.value = performance.now() - t
    return r
  }

  const layout = computed(() => {
    void fontTick.value
    return layoutAt(autoFit.value)
  })

  const bom = (opts: BomOptions = {}): BomResult | null => {
    const p = projectRef.value
    const lay = layout.value
    if (!p || !lay) return null
    return buildBom(p, lay, preset.value, opts)
  }

  const save = (): void => {
    if (projectRef.value) saveProject(projectRef.value)
  }

  const savePresetNow = (): void => {
    savePreset(basePreset.value)
  }

  // 项目参数变化即自动保存
  watch(
    () => (projectRef.value ? JSON.stringify(projectRef.value) : ''),
    () => save(),
    { flush: 'post' }
  )

  // 只持久化基础预设（生效价目来自价目簿，不能回写进基础预设）
  watch(
    () => basePreset.value,
    () => savePresetNow(),
    { deep: true }
  )

  return { project: projectRef, basePreset, preset, autoFit, fontTick, fontText, fontOk, layout, layoutAt, bom, save, savePresetNow, refreshPricing, perfMs }
}