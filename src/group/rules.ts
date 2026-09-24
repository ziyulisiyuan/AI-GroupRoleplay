/**
 * 全局规则（SPEC §3.1.2）：用户自己写的约束词/写作规则，**不内置任何内容**。
 * 位置：工作区根目录 规则.md（跨所有群生效）；文件缺失或为空 = 不注入任何规则。
 * 注入对象：总管 + 每一个角色（在末尾指令之前）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'

export const RULES_FILENAME = '规则.md'

export function rulesPath(root: string = config.root): string {
  return join(root, RULES_FILENAME)
}

/** 读取规则正文（去掉可选的 frontmatter）；不存在返回空串。 */
export function loadRules(root: string = config.root): string {
  const file = rulesPath(root)
  if (!existsSync(file)) return ''
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)
  return (m === null ? raw : m[1]).trim()
}

/** 写入规则正文（编辑器用）。 */
export function saveRules(text: string, root: string = config.root): void {
  writeFileSync(rulesPath(root), `${text.trim()}\n`, 'utf8')
}
