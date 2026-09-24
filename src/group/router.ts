/**
 * 发言路由（SPEC §4.1）。
 * 主路径 = 总管 LLM tool-call（它能从上下文认出用户在跟谁说话，不靠手维护的别名表）。
 * 本模块 = 总管失败/超时时的零成本降级：按名字提及，其次等概率（禁连说）。
 */
export interface RoutableCharacter {
  name: string
}

/**
 * 把总管给出的名字归一到角色名：精确 → 包含关系（"甲" ↔ "角色甲"，取最长匹配）。
 * 无匹配返回 undefined（调用方走降级）。
 */
export function resolveCharacterName(chars: RoutableCharacter[], raw: string): string | undefined {
  const q = raw.trim()
  if (q === '') return undefined
  const exact = chars.find(c => c.name === q)
  if (exact !== undefined) return exact.name
  const partial = chars
    .filter(c => c.name.includes(q) || q.includes(c.name))
    .sort((a, b) => b.name.length - a.name.length)
  return partial[0]?.name
}

/** 提及检测：用户文本里直接出现角色名（最长匹配优先）。 */
export function detectMention(chars: RoutableCharacter[], text: string): string | undefined {
  const hits = chars.filter(c => text.includes(c.name)).sort((a, b) => b.name.length - a.name.length)
  return hits[0]?.name
}

/** 等概率抽取，排除上一发言者（禁连说）。 */
export function dicePick(
  chars: RoutableCharacter[],
  lastSpeaker: string | undefined,
  rng: () => number = Math.random,
): string | undefined {
  const pool = chars.filter(c => c.name !== lastSpeaker)
  if (pool.length === 0) return chars[0]?.name
  return pool[Math.floor(rng() * pool.length)].name
}

/** 完整降级路由：提及优先，其次抽取。 */
export function heuristicPick(
  chars: RoutableCharacter[],
  userText: string,
  lastSpeaker: string | undefined,
  rng: () => number = Math.random,
): string | undefined {
  if (chars.length === 0) return undefined
  return detectMention(chars, userText) ?? dicePick(chars, lastSpeaker, rng)
}
