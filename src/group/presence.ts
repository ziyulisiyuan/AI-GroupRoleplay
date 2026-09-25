/**
 * 场景接入（SPEC §3.11）：谁在这个场景里、谁通过通道接入。
 * 位置：groups/<群聊>/在场.yaml（机器字段 → yaml；事实源是 剧情.jsonl 的 presence 行）。
 *
 * 两层，别混淆：
 *   present —— **现场**：人就在这个场景里。默认能发言、能听、能看。
 *   remote  —— **通道接入**：人不在现场，但当下双向连通（此刻能感知这里、这里也能与他互动）。
 *              perceive=语音 者只感知到声音；perceive=视听 者还能看到画面。
 *              接入者**可以发言**；他能否感知某条消息与其他角色走同一套知情判定，另受自己 since 锚点约束。
 *
 * 判定标准只有"当下双向"：只满足单向或延迟投递的传达不是接入——那是物件或转述，
 * 不构成感知，也不会进入任何人的账本。
 *
 * 缺省（文件不存在）：视为全员现场（向后兼容旧群）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'

export const presencePath = (groupDir: string): string => join(groupDir, '在场.yaml')

/** 远程接入的感知方式：语音=只听得到声音；视听=声音与画面都有。 */
export type RemotePerceive = '语音' | '视听'

export interface RemoteLink {
  character: string
  perceive: RemotePerceive
  /** 这个通道是什么（自由文本，人读用；同时提示总管该通道能传什么）。 */
  note?: string
  /** 接入起点（该接入者已落盘消息数快照）：通道馈送从 id > since 的消息开始。
   *  续接的接入者保留原值——别人进出场景不影响他。 */
  since?: number
}

export interface SceneAccess {
  present: string[]
  remote: RemoteLink[]
  /** 单向感知（偷听/监控/隔墙有耳——能知道这里的事、但无法实时互动，现场角色不知道他在听）。
   *  结构与 remote 相同（含各自独立的 since 起点）。 */
  overhear: RemoteLink[]
}

export function emptyScene(): SceneAccess {
  return { present: [], remote: [], overhear: [] }
}

/**
 * 解析 remote 列表（来自 yaml 或总管工具参数）。
 * **不是数组**（字段缺失）= undefined，调用方按"接入情况不变"处理；
 * 是数组（含空数组）= 完整列表，空数组表示接入全部结束。
 * perceive 只认 语音/视听，其余按 语音（感知更少的一侧，宁可少记不可错记）。
 */
export function parseRemoteList(value: unknown): RemoteLink[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap(item => {
    const o = (item ?? {}) as Record<string, unknown>
    const character = typeof o.character === 'string' ? o.character.trim() : ''
    if (character === '') return []
    const note = typeof o.note === 'string' && o.note.trim() !== '' ? o.note.trim() : undefined
    const since = typeof o.since === 'number' && Number.isInteger(o.since) && o.since >= 0 ? o.since : undefined
    return [{
      character,
      perceive: o.perceive === '视听' ? '视听' as const : '语音' as const,
      ...(note === undefined ? {} : { note }),
      ...(since === undefined ? {} : { since }),
    }]
  })
}

/** 读取场景接入；缺省返回空（调用方按"全员现场"处理）。 */
/** 读取场景接入；缺省返回空（调用方按"全员现场"处理）。 */
export function loadScene(groupDir: string): SceneAccess {
  const file = presencePath(groupDir)
  if (!existsSync(file)) return emptyScene()
  const raw = (loadYaml(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) ?? {}) as Record<string, unknown>
  const present = (Array.isArray(raw.present) ? raw.present : []).map(v => String(v).trim()).filter(v => v !== '')
  return {
    present,
    remote: parseRemoteList(raw.remote) ?? [],
    overhear: parseRemoteList(raw.overhear) ?? [],
  }
}

export function saveScene(groupDir: string, scene: SceneAccess): void {
  const present = [...new Set(scene.present.map(v => v.trim()).filter(v => v !== ''))]
  const encodeLinks = (links: RemoteLink[]): ReturnType<typeof Array.prototype.flatMap> => {
    const seen = new Set<string>()
    return links.flatMap(l => {
      const character = l.character.trim()
      if (character === '' || seen.has(character)) return []
      seen.add(character)
      return [{
        character,
        perceive: l.perceive,
        ...(l.note === undefined || l.note === '' ? {} : { note: l.note }),
        ...(l.since === undefined ? {} : { since: l.since }),
      }]
    })
  }
  writeFileSync(presencePath(groupDir), dumpYaml({ present, remote: encodeLinks(scene.remote), overhear: encodeLinks(scene.overhear) }, { lineWidth: -1 }), 'utf8')
}

/**
 * 感知能力（SPEC §3.11）。
 * 规则：若存在保留字段 `感知`（或 `感官`），**以它为准**（可写 `感知: 正常` 显式覆盖）；
 * 否则扫描全部状态字段的文本找关键词（总管常把"被刺瞎了"写进 身体状况）。
 */
export function perceives(status: Record<string, string>): { hearing: boolean; sight: boolean } {
  const reserved = Object.entries(status).filter(([k]) => k.trim() === '感知' || k.trim() === '感官')
  const raw = (reserved.length > 0 ? reserved : Object.entries(status)).map(([, v]) => v).join(' ')
  const noHearing = /失聪|耳聋|听不见|聋/.test(raw)
  const noSight = /失明|眼瞎|瞎|看不见/.test(raw)
  return { hearing: !noHearing, sight: !noSight }
}

/**
 * 该角色能否作为**自动目击者**（SPEC §3.11）。
 *
 * 保守规则：要求听觉与视觉都正常。理由：剧情消息里语音与动作描写混在一起，
 * 程序无法可靠区分"他是听见的"还是"他看见的"；若放宽到"听或看其一"，失聪者就会
 * 通过"别人说出口的话"被自动记账，造成客观上的错误知情。
 * 有感知障碍的角色改由总管按剧情显式记录他能感知的部分（总管提示里已标注其障碍）。
 */
export function canWitness(status: Record<string, string>): boolean {
  const p = perceives(status)
  return p.hearing && p.sight
}
