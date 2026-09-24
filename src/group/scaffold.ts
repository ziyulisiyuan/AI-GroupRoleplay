/**
 * 用户编辑器写入层（SPEC §6 M5）：
 * **只有本模块可以写 角色.md** —— 它是用户资产，引擎/总管/rebuild 一律只读。
 * 同时负责建群、建角色、更新群设定。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump as dumpYaml } from 'js-yaml'
import { groupSettingsPath, loadCharacter, loadCharacters, userPersonaPath, type GroupSettings, type UserPersona } from './persona.ts'
import { emptyFiles, loadFiles, saveMemory, savePersonality, saveRelationships, saveStatus } from './status.ts'
import { StoryStore } from '../store.ts'

/** 角色资料草稿（前端编辑器的字段集合）。 */
export interface CharacterDraft {
  name: string
  /** 外观/建模 → 角色.md（用户专属） */
  appearance: string
  /** 背景等自由补充 → 角色.md 正文（用户专属） */
  background: string
  /** 初始性格 → 性格.md 原文 */
  personality: string
  /** 初始人物关系 → 人物关系.md 备注 */
  relationships: string
}

/** 群聊名/角色名合法性（同时防路径穿越）。 */
export function isValidName(name: string): boolean {
  const n = name.trim()
  return n !== '' && n.length <= 60 && !/[\\/:*?"<>|\u0000-\u001f]/.test(n) && n !== '.' && n !== '..'
}

export function saveGroupSettings(groupDir: string, s: GroupSettings): void {
  writeFileSync(groupSettingsPath(groupDir), dumpYaml({ era: s.era, world: s.world, tone: s.tone }, { lineWidth: -1 }), 'utf8')
}

/** 建群：目录 + 群设定.yaml + 空的 用户.md 模板。已存在则抛错。 */
export function createGroup(groupDir: string, s: GroupSettings): void {
  if (existsSync(groupDir)) throw new Error('同名群聊已存在')
  mkdirSync(join(groupDir, '角色'), { recursive: true })
  saveGroupSettings(groupDir, s)
  saveUserPersona(groupDir, { name: '你', text: '' })
}

/** 用户设定（自由格式）：frontmatter 只有可省略的 name，正文随便写。 */
export function saveUserPersona(groupDir: string, p: UserPersona): void {
  const fm = dumpYaml({ name: p.name.trim() || '你' }, { lineWidth: -1 }).trimEnd()
  writeFileSync(userPersonaPath(groupDir), `---\n${fm}\n---\n\n${p.text.trim()}\n`, 'utf8')
}

function roleMarkdown(draft: CharacterDraft): string {
  const fm = dumpYaml(
    {
      name: draft.name.trim(),
      appearance: draft.appearance,
    },
    { lineWidth: -1 },
  ).trimEnd()
  return `---\n${fm}\n---\n\n${draft.background.trim()}\n`
}

/** 建角色：五个文件（状态/记忆初始为空，由总管与 Host 逐步填充）。 */
export function createCharacter(groupDir: string, draft: CharacterDraft): string {
  const name = draft.name.trim()
  if (!isValidName(name)) throw new Error('非法角色名')
  const dir = join(groupDir, '角色', name)
  if (existsSync(dir)) throw new Error(`角色「${name}」已存在`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '角色.md'), roleMarkdown({ ...draft, name }), 'utf8')
  const files = emptyFiles()
  files.personality.base = draft.personality.trim()
  files.relationships.base = draft.relationships.trim()
  savePersonality(dir, files.personality)
  saveRelationships(dir, files.relationships)
  saveStatus(dir, files.status)
  saveMemory(dir, files.memory)
  return name
}

/** 读取角色资料草稿（供编辑器回填）。 */
export function readCharacterDraft(groupDir: string, dirName: string): CharacterDraft {
  const dir = join(groupDir, '角色', dirName)
  const roleFile = join(dir, '角色.md')
  if (!existsSync(roleFile)) throw new Error(`角色不存在: ${dirName}`)
  const persona = loadCharacter(roleFile)
  const files = loadFiles(dir)
  return {
    name: persona.name,
    appearance: persona.appearance,
    background: persona.body,
    personality: files.personality.base,
    relationships: files.relationships.base,
  }
}

/**
 * 更新角色资料：重写 角色.md 与 性格.md/人物关系.md 的**用户原文**；演变与条目保持不动。
 * 改名时：拒绝与本群其它角色重名（重名会让账目与路由混淆），并在 剧情.jsonl 追加 rename 行——
 * 旧账目（ledger/presence 行）经名字链归到新名下重放，改名不丢历史、不被踢出现场。
 */
export function updateCharacter(groupDir: string, dirName: string, draft: CharacterDraft): void {
  const dir = join(groupDir, '角色', dirName)
  if (!existsSync(dir)) throw new Error(`角色不存在: ${dirName}`)
  const name = draft.name.trim()
  if (!isValidName(name)) throw new Error('非法角色名')
  const oldName = loadCharacter(join(dir, '角色.md')).name
  if (oldName !== name) {
    const clash = loadCharacters(groupDir).find(c => c.dirName !== dirName && c.name === name)
    if (clash !== undefined) throw new Error(`角色名「${name}」已被 ${clash.dirName} 使用`)
    StoryStore.open(groupDir, groupDir.split(/[\\/]/).pop() ?? '').appendRename(oldName, name)
  }
  writeFileSync(join(dir, '角色.md'), roleMarkdown({ ...draft, name }), 'utf8')
  const files = loadFiles(dir)
  files.personality.base = draft.personality.trim()
  files.relationships.base = draft.relationships.trim()
  savePersonality(dir, files.personality)
  saveRelationships(dir, files.relationships)
}

/** 列出某群的角色目录名（编辑器用）。 */
export function listCharacterDirs(groupDir: string): string[] {
  const dir = join(groupDir, '角色')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
}
