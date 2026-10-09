/**
 * 任务书（SPEC-offstory-pipeline §2/§3/§4）：离场管线的事实底稿。
 * 文件 groups/<群>/任务书.jsonl，一行一本；"在用"= 桌上、还没被离场补全收走；
 * "已收" = 收进后台，任何 AI 不再读到它（只有人查文件时才看得到）。
 * 本模块只做确定性读写与纯计算（编号、窗口、上下文截取），不调 LLM、不碰角色文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MsgLine, StoryLine } from '../store.ts'

export type BriefStatus = '在用' | '已收'

/** 事实先后顺序：第 i 条事实之后发生第 then 条事实（引用 facts 下标）。 */
export interface BriefSequenceStep {
  i: number
  then: number
}

/** 每个参与者当时能感知到的部分（限知视角的材料）。 */
export interface BriefPerceive {
  character: string
  saw: string[]
}

export interface Brief {
  id: string
  nodeId: string
  judgeMid: number
  createdTs: string
  status: BriefStatus
  /** 这本任务书服务的离开窗口（只取它 participants 里、本次分离离开的那几个人的窗口）。 */
  windowKeys: string[]
  title: string
  place: string
  participants: string[]
  facts: string[]
  sequence: BriefSequenceStep[]
  perceives: BriefPerceive[]
  usedTs?: string
  usedBy?: string
}

/** 一本任务书的草稿（LLM 产出 + 引擎补编号/节点/时间/状态/窗口）。 */
export type BriefDraft = Pick<Brief, 'title' | 'place' | 'participants' | 'facts' | 'sequence' | 'perceives'>

export const briefsPath = (groupDir: string): string => join(groupDir, '任务书.jsonl')

/** 离开窗口的稳定标识：角色 + 离开起点消息号（同一角色的再次离开起点不同，不会撞）。 */
export function windowKey(character: string, absenceStartId: number): string {
  return `${character}|${absenceStartId}`
}

export function strArray(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).flatMap(x => (typeof x === 'string' && x.trim() !== '' ? [x.trim()] : []))
}

export function parseSequence(v: unknown): BriefSequenceStep[] {
  return (Array.isArray(v) ? v : []).flatMap(x => {
    const o = (x ?? {}) as Record<string, unknown>
    return typeof o.i === 'number' && typeof o.then === 'number' ? [{ i: o.i, then: o.then }] : []
  })
}

export function parsePerceives(v: unknown): BriefPerceive[] {
  return (Array.isArray(v) ? v : []).flatMap(x => {
    const o = (x ?? {}) as Record<string, unknown>
    const character = typeof o.character === 'string' ? o.character.trim() : ''
    if (character === '') return []
    return [{ character, saw: strArray(o.saw) }]
  })
}

/** 解析一份任务书文件（坏行忽略，与 剧情.jsonl / 记忆.jsonl 同策略）。 */
export function parseBriefs(raw: string): Brief[] {
  return raw
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        const j = JSON.parse(l) as Record<string, unknown>
        const id = typeof j.id === 'string' ? j.id.trim() : ''
        const nodeId = typeof j.nodeId === 'string' ? j.nodeId.trim() : ''
        if (id === '' || nodeId === '') return []
        const status: BriefStatus = j.status === '已收' ? '已收' : '在用'
        const usedTs = typeof j.usedTs === 'string' ? j.usedTs : undefined
        const usedBy = typeof j.usedBy === 'string' ? j.usedBy : undefined
        return [{
          id,
          nodeId,
          judgeMid: typeof j.judgeMid === 'number' ? j.judgeMid : 0,
          createdTs: typeof j.createdTs === 'string' ? j.createdTs : '',
          status,
          windowKeys: strArray(j.windowKeys),
          title: typeof j.title === 'string' ? j.title : '',
          place: typeof j.place === 'string' ? j.place : '',
          participants: strArray(j.participants),
          facts: strArray(j.facts),
          sequence: parseSequence(j.sequence),
          perceives: parsePerceives(j.perceives),
          ...(status === '已收' && usedTs !== undefined ? { usedTs } : {}),
          ...(status === '已收' && usedBy !== undefined ? { usedBy } : {}),
        }]
      } catch { return [] }
    })
}

/** 确定性序列化（键序固定，rebuild 幂等精神）。 */
export function serializeBrief(b: Brief): string {
  return JSON.stringify({
    id: b.id,
    nodeId: b.nodeId,
    judgeMid: b.judgeMid,
    createdTs: b.createdTs,
    status: b.status,
    windowKeys: b.windowKeys,
    title: b.title,
    place: b.place,
    participants: b.participants,
    facts: b.facts,
    sequence: b.sequence,
    perceives: b.perceives,
    ...(b.usedTs === undefined ? {} : { usedTs: b.usedTs }),
    ...(b.usedBy === undefined ? {} : { usedBy: b.usedBy }),
  })
}

export function loadBriefs(groupDir: string): Brief[] {
  const p = briefsPath(groupDir)
  if (!existsSync(p)) return []
  return parseBriefs(readFileSync(p, 'utf8'))
}

export function saveBriefs(groupDir: string, briefs: Brief[]): void {
  mkdirSync(groupDir, { recursive: true })
  writeFileSync(briefsPath(groupDir), briefs.length === 0 ? '' : briefs.map(serializeBrief).join('\n') + '\n', 'utf8')
}

/** 同一毫秒内产出多本时顺延毫秒，保证 id 唯一（id = "b" + base36 时间戳）。 */
export function nextBriefId(taken: ReadonlySet<string>, startMs = Date.now()): string {
  let ms = startMs
  for (;;) {
    const id = `b${ms.toString(36)}`
    if (!taken.has(id)) return id
    ms++
  }
}

/** 节点编号：同一次判定的几本共用（"同一节点只给一次上下文"靠它）。 */
export function nextNodeId(taken: ReadonlySet<string>, startMs = Date.now()): string {
  let ms = startMs
  for (;;) {
    const id = `n${ms.toString(36)}`
    if (!taken.has(id)) return id
    ms++
  }
}

export function inUseBriefs(briefs: readonly Brief[]): Brief[] {
  return briefs.filter(b => b.status === '在用')
}

/** 所有已被任务书"占住"的窗口（备忘录：同一段离开不再被后续判定重复处理）。 */
export function claimedWindowKeys(briefs: readonly Brief[]): Set<string> {
  return new Set(briefs.flatMap(b => b.windowKeys))
}

/** 把点名的任务书收进后台（status=已收 + 收走时间/哪次补全收的）；返回真正改动的本数。 */
export function consumeBriefs(groupDir: string, ids: ReadonlySet<string>, usedTs: string, usedBy: string): number {
  if (ids.size === 0) return 0
  const all = loadBriefs(groupDir)
  let n = 0
  for (const b of all) {
    if (b.status !== '在用' || !ids.has(b.id)) continue
    b.status = '已收'
    b.usedTs = usedTs
    b.usedBy = usedBy
    n++
  }
  if (n > 0) saveBriefs(groupDir, all)
  return n
}

/** 清空记录时把"在用"任务书整体退休：旧剧情已被清掉，不能让它们再写记忆（留档仍可查）。 */
export function retireInUseBriefs(groupDir: string, usedTs: string, usedBy: string): number {
  const all = loadBriefs(groupDir)
  let n = 0
  for (const b of all) {
    if (b.status !== '在用') continue
    b.status = '已收'
    b.usedTs = usedTs
    b.usedBy = usedBy
    n++
  }
  if (n > 0) saveBriefs(groupDir, all)
  return n
}

/**
 * §3.2.1 enterMid：顺着剧情记录里"场景"这一串看，当前场景最近一段连续运行的第一行之前，
 * 最近一条消息的编号；找不到该场景的 presence 行（一开始就在当前场景/平面群）→ 0。
 */
export function sceneEnterMid(lines: readonly StoryLine[], scene: string): number {
  let runFirstIdx = -1
  let runScene: string | undefined
  let targetFirstIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.type !== 'presence') continue
    const s = l.scene
    if (runFirstIdx < 0 || s !== runScene) {
      runFirstIdx = i
      runScene = s
    }
    if (s === scene) targetFirstIdx = runFirstIdx
  }
  if (targetFirstIdx < 0) return 0
  let maxId = 0
  for (let i = 0; i < targetFirstIdx; i++) {
    const l = lines[i]
    if (l.type === 'msg' && l.id > maxId) maxId = l.id
  }
  return maxId
}

/** 每条消息落盘时"最近一次场景记录"（说话人当时的场景与名册；平面群行无 scene）。 */
export function messageSceneIndex(lines: readonly StoryLine[]): Map<number, Extract<StoryLine, { type: 'presence' }> | undefined> {
  const out = new Map<number, Extract<StoryLine, { type: 'presence' }> | undefined>()
  let last: Extract<StoryLine, { type: 'presence' }> | undefined
  for (const l of lines) {
    if (l.type === 'presence') last = l
    else if (l.type === 'msg') out.set(l.id, last)
  }
  return out
}

/**
 * §3.2/§3.2.3：任务书描绘的剧情原文——[rangeStart, rangeEnd] 内；
 * 总量 > 100 时只取该范围内最新的 50 条，否则全给。
 */
export function briefDialogue(messages: readonly MsgLine[], rangeStart: number, rangeEnd: number, total: number): MsgLine[] {
  const inRange = messages.filter(m => m.id >= rangeStart && m.id <= rangeEnd)
  return total > 100 ? inRange.slice(-50) : inRange
}

/**
 * §5.3：离场补全的剧情原文——回来范围（总量 ≤100 全给；>100 给最新 50 条）
 * ＋ 每本在用任务书各自的一段（判定那一刻往前数 20 条，含判定那一刻本身；同节点只给一次）。
 */
export function completionDialogue(
  messages: readonly MsgLine[],
  returnerStartIds: readonly number[],
  briefsInUse: readonly Brief[],
  total: number = messages.length,
): { returnedRange: MsgLine[]; segments: Array<{ nodeId: string; judgeMid: number; messages: MsgLine[] }> } {
  let returnedRange: MsgLine[] = []
  if (total > 100) returnedRange = messages.slice(-50)
  else if (returnerStartIds.length > 0) {
    const start = Math.min(...returnerStartIds)
    returnedRange = messages.filter(m => m.id >= start)
  }
  const seenNodes = new Set<string>()
  const segments: Array<{ nodeId: string; judgeMid: number; messages: MsgLine[] }> = []
  for (const b of briefsInUse) {
    if (b.judgeMid <= 0 || seenNodes.has(b.nodeId)) continue
    seenNodes.add(b.nodeId)
    const upTo = messages.filter(m => m.id <= b.judgeMid)
    if (upTo.length === 0) continue
    segments.push({ nodeId: b.nodeId, judgeMid: b.judgeMid, messages: upTo.slice(-21) })
  }
  return { returnedRange, segments }
}