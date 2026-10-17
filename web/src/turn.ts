/**
 * 进行中的对话轮次状态（按群隔离，模块级保存）。
 * 为什么放在组件外：用户在角色生成途中离开聊天页（进聊天信息/返回主页）时，
 * ChatView 会被卸载重建，本地 useState 随之丢失——后端流仍在继续推进，
 * 等说完时界面已经"看不到"这轮。这里把"这一轮走到哪了"挂到模块级，
 * 重新进入时通过 useSyncExternalStore 无缝接上：流式气泡续播、busy 态续住。
 * 状态对象每次变更生成新引用（React 依赖快照比对），订阅者按群通知。
 */
import type { Msg, Snapshot } from './api.ts'

export interface TurnMsg { key: number; name: string; text: string; done: boolean }

export interface TurnState {
  busy: boolean
  status: string
  msgs: TurnMsg[]
  pending: Msg | null
  /** 乐观回显挂出时快照里的最大消息 id：快照出现更新的真实用户消息即撤下回显（防中途重进重复） */
  pendingBase: number
  rerollId: number | null
  nextKey: number
}

const states = new Map<string, TurnState>()
const subs = new Map<string, Set<() => void>>()
const statusTimers = new Map<string, number>()
/** 每群最近一次快照（重新进入聊天页先展示，避免"加载中"闪屏；清空/删除群时失效） */
const snapshots = new Map<string, Snapshot>()

export function cachedSnapshot(group: string): Snapshot | undefined {
  return snapshots.get(group)
}

export function cacheSnapshot(group: string, s: Snapshot): void {
  snapshots.set(group, s)
}

export function forgetSnapshot(group: string): void {
  snapshots.delete(group)
}

function base(): TurnState {
  return { busy: false, status: '', msgs: [], pending: null, pendingBase: 0, rerollId: null, nextKey: 0 }
}

export function getTurn(group: string): TurnState {
  let s = states.get(group)
  if (s === undefined) { s = base(); states.set(group, s) }
  return s
}

export function subscribeTurn(group: string, cb: () => void): () => void {
  let set = subs.get(group)
  if (set === undefined) { set = new Set(); subs.set(group, set) }
  set.add(cb)
  return () => { set.delete(cb) }
}

function emit(group: string): void {
  subs.get(group)?.forEach(cb => cb())
}

/** 通用补丁（pending/rerollId 等整字段替换） */
export function turnPatch(group: string, p: Partial<TurnState>): void {
  states.set(group, { ...getTurn(group), ...p })
  emit(group)
}

/** 新一轮开始：忙 + 清本轮暂存（保留 pending/rerollId，它们由调用方先置） */
export function turnBegin(group: string): void {
  const s = getTurn(group)
  states.set(group, { ...s, busy: true, msgs: [] })
  emit(group)
}

/** speaker 事件：追加一条流式占位并清状态行 */
export function turnSpeaker(group: string, name: string): void {
  const s = getTurn(group)
  const key = s.nextKey + 1
  states.set(group, { ...s, nextKey: key, status: '', msgs: [...s.msgs, { key, name, text: '', done: false }] })
  emit(group)
}

export function turnDelta(group: string, text: string): void {
  const s = getTurn(group)
  const last = s.msgs[s.msgs.length - 1]
  if (last === undefined) return
  states.set(group, { ...s, msgs: [...s.msgs.slice(0, -1), { ...last, text: last.text + text }] })
  emit(group)
}

export function turnReplyDone(group: string): void {
  const s = getTurn(group)
  const last = s.msgs[s.msgs.length - 1]
  if (last === undefined) return
  states.set(group, { ...s, msgs: [...s.msgs.slice(0, -1), { ...last, done: true }] })
  emit(group)
}

/** 轮次收尾：解锁 + 撤乐观气泡与暂存（状态行保留片刻后自动淡出） */
export function turnEnd(group: string): void {
  const s = getTurn(group)
  states.set(group, { ...s, busy: false, msgs: [], pending: null, pendingBase: 0, rerollId: null })
  emit(group)
  if (s.status !== '') scheduleStatusClear(group, s.status)
}

/**
 * 状态行：写入并调度自动清空。轮次进行中可能长时间无事件，
 * 只在"非 busy 且内容未更新"时淡出，避免生成期间闪烁。
 */
export function turnSetStatus(group: string, text: string): void {
  const s = getTurn(group)
  states.set(group, { ...s, status: text })
  emit(group)
  scheduleStatusClear(group, text)
}

function scheduleStatusClear(group: string, text: string): void {
  const prev = statusTimers.get(group)
  if (prev !== undefined) window.clearTimeout(prev)
  if (text === '') return
  statusTimers.set(group, window.setTimeout(() => {
    const cur = states.get(group)
    if (cur !== undefined && !cur.busy && cur.status === text) {
      states.set(group, { ...cur, status: '' })
      emit(group)
    }
  }, 4000))
}
