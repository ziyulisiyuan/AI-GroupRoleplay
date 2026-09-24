/**
 * 应用设置（SPEC §3.1.3）：模型提供方列表，前端可增删改与启用。
 * 位置：工作区根目录 settings.yaml（机器字段 → yaml）。
 * 解析优先级：settings.yaml 的启用项 → .env / 环境变量（DEEPSEEK_*）→ 报错。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { config } from './config.ts'

export interface Provider {
  id: string
  /** 显示名（如 DeepSeek / zai / 自建网关） */
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** off | low | high | max */
  reasoningEffort: string
}

export interface AppSettings {
  providers: Provider[]
  /** 当前启用的提供方 id；空 = 回退到 .env 配置 */
  activeId: string
  /** 快路径（路由判断，SPEC §6.1a）专用提供方 id；空 = 不启用快路径，总管走单次完整调用 */
  routerId: string
}

export const SETTINGS_FILENAME = 'settings.yaml'
export const settingsPath = (root: string = config.root): string => join(root, SETTINGS_FILENAME)

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

export function loadSettings(root: string = config.root): AppSettings {
  const file = settingsPath(root)
  const empty: AppSettings = { providers: [], activeId: '', routerId: '' }
  if (!existsSync(file)) return empty
  const raw = (loadYaml(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) ?? {}) as Record<string, unknown>
  const list = Array.isArray(raw.providers) ? raw.providers : []
  const providers = list.flatMap((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>
    const baseUrl = str(o.baseUrl)
    const apiKey = str(o.apiKey)
    const model = str(o.model)
    if (baseUrl === '' || apiKey === '' || model === '') return [] // 缺关键字段的条目忽略
    return [{
      id: str(o.id) || `p${i + 1}`,
      name: str(o.name) || str(o.id) || `提供方${i + 1}`,
      baseUrl,
      apiKey,
      model,
      reasoningEffort: str(o.reasoningEffort) || 'high',
    }]
  })
  return { providers, activeId: str(raw.activeId), routerId: str(raw.routerId) }
}

export function saveSettings(s: AppSettings, root: string = config.root): void {
  writeFileSync(settingsPath(root), dumpYaml({ activeId: s.activeId, routerId: s.routerId, providers: s.providers }, { lineWidth: -1 }), 'utf8')
}

const SETTINGS_BACKUP_SUFFIX = '.selfcheck-bak'

/**
 * 恢复孤儿备份：离线自检（selfcheck:router）会把 settings.yaml 短暂换成 mock 配置，正常结束时
 * 由 finally 还原；但进程被硬崩溃打死时 finally 不会执行，mock 配置就会留在真实配置上（实测事故）。
 * 自检把原始配置同时落盘到 settings.yaml.selfcheck-bak；启动时（server / cli）发现孤儿备份就
 * 原样恢复并告警——备份内容为空串表示"原本不存在 settings.yaml"，恢复即删除。
 */
export function healOrphanSettingsBackup(root: string = config.root): void {
  const bak = settingsPath(root) + SETTINGS_BACKUP_SUFFIX
  if (!existsSync(bak)) return
  const original = readFileSync(bak, 'utf8')
  if (original === '') rmSync(settingsPath(root))
  else writeFileSync(settingsPath(root), original, 'utf8')
  rmSync(bak)
  console.warn('[settings] 检测到未恢复的自检备份——settings.yaml 已自动还原（上一次自检被异常中断，若在自检期间请忽略本次提示）')
}

export interface ResolvedLlm {
  baseUrl: string
  apiKey: string
  model: string
  reasoningEffort: string
  /** 配置来源，便于自检与报错说明 */
  source: 'settings' | 'env'
}

/** 解析当前应使用的 LLM 连接信息；未配置任何提供方时回退 .env。 */
export function resolveLlm(root: string = config.root): ResolvedLlm {
  const s = loadSettings(root)
  const active = s.providers.find(p => p.id === s.activeId) ?? s.providers[0]
  if (active !== undefined) {
    return {
      baseUrl: active.baseUrl,
      apiKey: active.apiKey,
      model: active.model,
      reasoningEffort: active.reasoningEffort,
      source: 'settings',
    }
  }
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    source: 'env',
  }
}

/**
 * 快路径（路由判断）专用连接信息（SPEC §6.1a）：settings.routerId 指向的提供方。
 * 未配置或指向不存在的条目 → undefined：快路径关闭，总管走单次完整调用（行为与旧版一致）。
 * 每次调用现读 settings.yaml，前端改配置即刻生效。
 */
export function resolveRouter(root: string = config.root): ResolvedLlm | undefined {
  const s = loadSettings(root)
  const router = s.providers.find(p => p.id === s.routerId)
  if (router === undefined) return undefined
  return {
    baseUrl: router.baseUrl,
    apiKey: router.apiKey,
    model: router.model,
    reasoningEffort: router.reasoningEffort,
    source: 'settings',
  }
}
