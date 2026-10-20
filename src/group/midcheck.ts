/**
 * Jev 中间判定规则（SPEC §3.7a）：全局一份，工作区根 中间判定.jsonl，一行一条。
 * 每条规则 = 两段固定格式：
 *   check —— 第一段（填空），拼在固定句「本段输出是否违反了」之后，作为这一次 Jev 的 noul 题面；
 *   fix   —— 第二段，判定命中（noul ≥ 0.42）时原样发回角色，作为改稿要求。
 * name/enabled 是纯前端标签（与 全局规则 同一套语义）：只有启用的规则参与判定，未启用/缺字段的跳过。
 * 与 规则.jsonl 的分工：全局规则注入角色的长期提示词；这里的规则只在**草稿生成之后**逐条判定。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'

export const MIDCHECK_FILENAME = '中间判定.jsonl'

/** 规则条目（存储形态；name/enabled 不进 Jev）。 */
export interface MidCheckItem {
  id: string
  name: string
  enabled: boolean
  /** 第一段：填空内容（题面 = 「本段输出是否违反了」+ check）。 */
  check: string
  /** 第二段：命中后发回角色的改稿要求。 */
  fix: string
}

/** 参与判定的规则（只保留启用且两段都不空的）。 */
export interface MidCheckRule {
  name: string
  check: string
  fix: string
}

export const midCheckPath = (root: string = config.root): string => join(root, MIDCHECK_FILENAME)

/** 读取规则列表（纯读，永不写盘；坏行忽略——与 剧情.jsonl / 记忆.jsonl 同策略）。 */
export function loadMidCheckList(root: string = config.root): MidCheckItem[] {
  const file = midCheckPath(root)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        const j = JSON.parse(l) as { id?: unknown; name?: unknown; enabled?: unknown; check?: unknown; fix?: unknown }
        if (typeof j.id !== 'string' || j.id === '') return []
        return [{
          id: j.id,
          name: typeof j.name === 'string' && j.name.trim() !== '' ? j.name.trim() : '未命名判定',
          enabled: j.enabled === true,
          check: typeof j.check === 'string' ? j.check.trim() : '',
          fix: typeof j.fix === 'string' ? j.fix : '',
        }]
      } catch { return [] }
    })
}

/** 保存规则列表（整表覆盖；服务端侧逐条清洗，id 为空的条目丢弃）。 */
export function saveMidCheckList(list: ReadonlyArray<unknown>, root: string = config.root): void {
  const clean: MidCheckItem[] = list.flatMap(r => {
    const o = (r ?? {}) as Record<string, unknown>
    if (typeof o.id !== 'string' || o.id.trim() === '') return []
    return [{
      id: o.id.trim(),
      name: typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim() : '未命名判定',
      enabled: o.enabled === true,
      check: typeof o.check === 'string' ? o.check.trim() : '',
      fix: typeof o.fix === 'string' ? o.fix : '',
    }]
  })
  writeFileSync(
    midCheckPath(root),
    clean.length === 0 ? '' : clean.map(r => JSON.stringify({ id: r.id, name: r.name, enabled: r.enabled, check: r.check, fix: r.fix })).join('\n') + '\n',
    'utf8',
  )
}

/** 参与判定的规则：启用、且两段都不空（缺第二段 = 命中也没东西发回角色，等同未启用）。 */
export function loadMidChecks(root: string = config.root): MidCheckRule[] {
  return loadMidCheckList(root)
    .filter(r => r.enabled && r.check !== '' && r.fix.trim() !== '')
    .map(r => ({ name: r.name, check: r.check, fix: r.fix }))
}

/**
 * 某群实际生效的中间判定规则 = 全局（作用于所有群）+ 本群独立规则（只作用于本群）。
 * 两类都是"启用才生效"，顺序 = 全局在前、本群在后（改稿指令里也按这个顺序排列）。
 */
export function loadMidChecksFor(groupDir: string): MidCheckRule[] {
  return [...loadMidChecks(), ...loadMidChecks(groupDir)]
}
