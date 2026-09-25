/**
 * 角色只读文件（角色.md）与群设定（群设定.yaml）的加载（SPEC §3.3/§3.5）。
 * 角色.md 是**用户专属**文件：外观/建模、背景。游戏中没有任何写入路径
 * （仅用户编辑器 src/group/scaffold.ts 可写）。
 * 性格在 性格.md、关系在 人物关系.md、实时状态在 状态.yaml、知情在 记忆.jsonl（见 status.ts）。
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'

export interface CharacterPersona {
  /** 目录名（角色文件夹名）。 */
  dirName: string
  name: string
  /** 外观/建模。 */
  appearance: string
  /** 角色.md 正文（背景等自由补充）。 */
  body: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

/** Windows 编辑器常写 UTF-8 BOM，剥离后再匹配 frontmatter。 */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** 解析单个 角色.md。缺省字段回填默认值；未知字段一律忽略。 */
export function loadCharacter(file: string): CharacterPersona {
  const raw = stripBom(readFileSync(file, 'utf8'))
  const dirName = file.split(/[\\/]/).slice(-2)[0]
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (m === null) throw new Error(`角色.md 缺少 frontmatter: ${file}`)
  const fm = (loadYaml(m[1]) ?? {}) as Record<string, unknown>
  return {
    dirName,
    name: str(fm.name) || dirName,
    appearance: str(fm.appearance),
    body: (m[2] ?? '').trim(),
  }
}

/** 读取群聊目录下全部角色（角色/ 子目录各含一个 角色.md）。 */
export function loadCharacters(groupDir: string): CharacterPersona[] {
  const dir = join(groupDir, '角色')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(dir, d.name, '角色.md'))
    .filter(f => existsSync(f))
    .map(loadCharacter)
}

/** 群设定（SPEC §3.2）：era / world / tone（tone 只给总管，永不下发角色）。 */
export interface GroupSettings {
  era: string
  world: string
  tone: string
}

/**
 * 用户自己的角色设定（SPEC §3.3.1）：一个自由格式的 用户.md，不分栏、随便写。
 * frontmatter 里的 name（可省略）是你在剧情里的称呼；正文整段注入每个角色与总管。
 */
export interface UserPersona {
  name: string
  text: string
}

export const USER_PERSONA_FILENAME = '用户.md'
export const userPersonaPath = (groupDir: string): string => join(groupDir, USER_PERSONA_FILENAME)

/** 读取用户设定；文件不存在时返回默认（称呼"你"、无正文）。 */
export function loadUserPersona(groupDir: string): UserPersona {
  const file = userPersonaPath(groupDir)
  if (!existsSync(file)) return { name: '你', text: '' }
  const raw = stripBom(readFileSync(file, 'utf8'))
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (m === null) return { name: '你', text: raw.trim() } // 纯散文、无 frontmatter 也合法
  const fm = (loadYaml(m[1]) ?? {}) as Record<string, unknown>
  return { name: str(fm.name).trim() || '你', text: (m[2] ?? '').trim() }
}

/** 群设定.yaml（机器字段，散文内容放在 YAML 块标量里）。 */
export function groupSettingsPath(groupDir: string): string {
  return join(groupDir, '群设定.yaml')
}

/** 群是否已建立设定。 */
export function hasGroupSettings(groupDir: string): boolean {
  return existsSync(groupSettingsPath(groupDir))
}

/** 读取群设定（era / world / tone）。 */
export function loadGroupSettings(groupDir: string): GroupSettings {
  const file = groupSettingsPath(groupDir)
  if (!existsSync(file)) return { era: '', world: '', tone: '' }
  const fm = (loadYaml(stripBom(readFileSync(file, 'utf8'))) ?? {}) as Record<string, unknown>
  return { era: str(fm.era), world: str(fm.world), tone: str(fm.tone) }
}
