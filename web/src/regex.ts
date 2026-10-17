/**
 * 正则替换（显示层）：**只改变你看到的文字，绝不进入任何模型输入**。
 *
 * 例：把 `tt` 替换成 `你好` —— 界面上显示"你好"，而角色的上下文、记忆、判定里始终是原始的 `tt`。
 * 实现要点：只在渲染时做一次字符串变换（浏览器原生 RegExp，无需任何依赖），
 * 因此对后端、判定、记忆账本零影响；规则存 localStorage（跟着这台设备走）。
 *
 * 作用域：全局规则作用于所有群；群内「独立正则」只作用于该群（两条链按全局→本群的顺序叠加）。
 */
export interface RegexRule {
  id: string
  /** 匹配模式（正则源码，无斜杠包裹） */
  pattern: string
  /** 替换文本，支持 $1 等反向引用 */
  replacement: string
  /** 命名，列表里显示用 */
  name: string
  /** 启停拨片：关闭的规则不参与替换（缺省 = 开启，兼容旧存档）。 */
  enabled: boolean
}

const KEY = 'groupchat.regex'

/** 作用域 → 存储键：缺省 = 全局规则；传群名 = 该群独立规则（两者互不影响）。 */
const keyOf = (scope?: string): string => (scope === undefined || scope === '' ? KEY : `${KEY}:${scope}`)

/** 规则缓存（按作用域）：saveRules 后失效，避免每条消息都读一遍 localStorage */
const caches = new Map<string, RegexRule[]>()

export function loadRules(scope?: string): RegexRule[] {
  const key = keyOf(scope)
  const hit = caches.get(key)
  if (hit !== undefined) return hit
  let out: RegexRule[]
  try {
    const raw = localStorage.getItem(key)
    const arr = raw === null ? [] : JSON.parse(raw) as RegexRule[]
    out = Array.isArray(arr)
      ? arr.filter(r => typeof r?.pattern === 'string' && r.pattern !== '').map(r => ({ ...r, enabled: r.enabled !== false }))
      : []
  } catch {
    out = []
  }
  caches.set(key, out)
  return out
}

export function saveRules(rules: RegexRule[], scope?: string): void {
  const key = keyOf(scope)
  caches.set(key, rules)
  try { localStorage.setItem(key, JSON.stringify(rules)) } catch { /* 私密模式等：内存里仍然生效 */ }
}

/** 校验正则是否可用（保存前调用） */
export function isValidPattern(pattern: string): boolean {
  try { new RegExp(pattern, 'g'); return true } catch { return false }
}

/**
 * 按全部规则依次替换（坏规则跳过，不影响其它规则）。无规则时零成本直接返回原文。
 * scope = 群名时，先跑全局规则、再跑该群的独立规则（聊天页按群传入）。
 */
export function applyRules(text: string, scope?: string): string {
  const rules = scope === undefined || scope === ''
    ? loadRules()
    : [...loadRules(), ...loadRules(scope)]
  if (rules.length === 0) return text
  let out = text
  for (const r of rules) {
    if (!r.enabled) continue
    try { out = out.replace(new RegExp(r.pattern, 'g'), r.replacement) } catch { /* 忽略坏规则 */ }
  }
  return out
}

export function newRuleId(): string {
  return `r${Date.now().toString(36)}`
}
