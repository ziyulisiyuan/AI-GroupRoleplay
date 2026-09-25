/**
 * 场景（地图）文件层（SPEC §3.5a）：groups/<群>/场景/<场景名>.md
 * frontmatter 存名称，正文是场景描述——空间由此固定下来，在场判定有了具体的空间事实。
 * 场景名称一经创建不可改、不可删（位置引用按名锚定）；描述可由用户随时改。
 * 唯一写者 = 用户编辑器（scaffold.ts / server.ts 场景接口）；引擎与 AI 全链路只读。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { isValidName } from './scaffold.ts'

export interface Scene {
  name: string
  description: string
}

export const scenesDir = (groupDir: string): string => join(groupDir, '场景')
export const scenePath = (groupDir: string, name: string): string => join(scenesDir(groupDir), `${name}.md`)

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** 读取全部场景（按文件名排序；缺 name 字段的文件跳过）。 */
export function listScenes(groupDir: string): Scene[] {
  const dir = scenesDir(groupDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.md'))
    .flatMap(d => {
      const raw = stripBom(readFileSync(join(dir, d.name), 'utf8'))
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
      if (m === null) return []
      const fm = (loadYaml(m[1]) ?? {}) as Record<string, unknown>
      const name = typeof fm.name === 'string' ? fm.name.trim() : ''
      return name === '' ? [] : [{ name, description: m[2].trim() }]
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 读取单个场景；不存在返回 undefined。 */
export function loadSceneByName(groupDir: string, name: string): Scene | undefined {
  if (!isValidName(name)) return undefined
  const file = scenePath(groupDir, name)
  if (!existsSync(file)) return undefined
  const raw = stripBom(readFileSync(file, 'utf8'))
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const description = m !== null ? m[2].trim() : ''
  return { name, description }
}

/** 创建场景；重名/非法名抛错。 */
export function createScene(groupDir: string, name: string, description: string): void {
  if (!isValidName(name)) throw new Error('非法场景名')
  const file = scenePath(groupDir, name)
  if (existsSync(file)) throw new Error(`场景「${name}」已存在`)
  writeSceneFile(file, name, description)
}

/** 改场景描述（名称不可改；场景不存在抛错）。 */
export function saveSceneDescription(groupDir: string, name: string, description: string): void {
  if (!isValidName(name)) throw new Error('非法场景名')
  const file = scenePath(groupDir, name)
  if (!existsSync(file)) throw new Error(`场景不存在: ${name}`)
  writeSceneFile(file, name, description)
}

function writeSceneFile(file: string, name: string, description: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const fm = dumpYaml({ name }, { lineWidth: -1 }).trimEnd()
  writeFileSync(file, `---\n${fm}\n---\n\n${description.trim()}\n`, 'utf8')
}
