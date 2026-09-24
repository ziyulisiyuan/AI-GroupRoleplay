/**
 * 正则替换（显示层）：**只改变你看到的文字，绝不进入任何模型输入**。
 *
 * 例：把 `tt` 替换成 `你好` —— 界面上显示"你好"，而角色的上下文、记忆、判定里始终是原始的 `tt`。
 * 实现要点：只在渲染时做一次字符串变换（浏览器原生 RegExp，无需任何依赖），
 * 因此对后端、Engagement/判定、记忆账本零影响；规则存 localStorage（跟着这台设备走）。
 */
export interface RegexRule {
  id: string
  /** 匹配模式（正则源码，无斜杠包裹） */
  pattern: string
  /** 替换文本，支持 $1 等反向引用 */
  replacement: string
  /** 命名，列表里显示用 */
  name: string
}

const KEY = 'groupchat.regex'

/** 规则缓存：saveRules 后失效，避免每条消息都读一遍 localStorage */
let cache: RegexRule[] | null = null

export function loadRules(): RegexRule[] {
  if (cache !== null) return cache
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw === null ? [] : JSON.parse(raw) as RegexRule[]
    cache = Array.isArray(arr) ? arr.filter(r => typeof r?.pattern === 'string' && r.pattern !== '') : []
  } catch {
    cache = []
  }
  return cache
}

export function saveRules(rules: RegexRule[]): void {
  cache = rules
  try { localStorage.setItem(KEY, JSON.stringify(rules)) } catch { /* 私密模式等：内存里仍然生效 */ }
}

/** 校验正则是否可用（保存前调用） */
export function isValidPattern(pattern: string): boolean {
  try { new RegExp(pattern, 'g'); return true } catch { return false }
}

/** 按全部规则依次替换（坏规则跳过，不影响其它规则）。无规则时零成本直接返回原文。 */
export function applyRules(text: string): string {
  const rules = loadRules()
  if (rules.length === 0) return text
  let out = text
  for (const r of rules) {
    try { out = out.replace(new RegExp(r.pattern, 'g'), r.replacement) } catch { /* 忽略坏规则 */ }
  }
  return out
}

export function newRuleId(): string {
  return `r${Date.now().toString(36)}`
}
