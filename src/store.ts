/**
 * 剧情日志存储（SPEC §3.5）：一个群聊一个目录，剧情.jsonl 是唯一事实源。
 * 行类型与规格一致：header / msg / route / swipe / ledger（M0 只产生 header+msg）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteLink, SceneAccess } from './group/presence.ts'

export interface HeaderLine {
  type: 'header'
  group: string
  created: string
  v: 1
  /** 已发出过的最大消息 id：消息行可被物理删除（当前上下文快照语义），靠它保证 id 永不复用。
   *  旧文件缺省 = 打开时按现存行现算，首次重写时补上。 */
  lastMsgId?: number
}

export interface MsgLine {
  type: 'msg'
  id: number
  role: 'user' | 'character' | 'system'
  name: string
  text: string
  round: number
  /** 'all' 或 可见角色名数组（当面发生之事 = 在场且能感知者的快照；私聊 = 仅目标）。 */
  visible_to: 'all' | string[]
  /** 语义标记：公开（当面）/ 私聊。旧数据可能缺失。 */
  scope?: 'public' | 'private'
  ts: string
}

export interface RouteLine {
  type: 'route'
  round: number
  picked: string
  reason: string
  fallback: boolean
}

export interface LedgerLine {
  type: 'ledger'
  character: string
  section: 'status' | 'knowledge' | 'personality' | 'relationship'
  /** retract：撤回记忆条目（用户手动改上下文，SPEC §3.10） */
  op: 'set' | 'append' | 'unset' | 'retract'
  content: string
}

/** 旧版 swipe 重roll 行（现版本重掷 = rewriteMessage 物理改写；本类型仅为旧日志视图兼容保留）。 */
export interface SwipeLine {
  type: 'swipe'
  target_id: number
  /** 含最初文本在内的全部候选（顺序保留）。 */
  variants: string[]
  chosen: number
}

/** 旧版手改行（现版本手改 = rewriteMessage 物理改写；仅为旧日志视图兼容保留）。 */
export interface EditLine {
  type: 'edit'
  target_id: number
  text: string
  ts: string
}

/** 旧版手删行（现版本手删 = removeMessage 物理移除；仅为旧日志视图兼容保留）。 */
export interface DeleteLine {
  type: 'delete'
  target_id: number
  ts: string
}

/** 场景人员变更（总管从剧情判断：谁进入/离开现场、谁接入或单向感知，SPEC §3.11）。 */
export interface PresenceLine {
  type: 'presence'
  present: string[]
  /** 通道接入（不在现场、当下双向连通）；缺省 = 无接入。 */
  remote?: RemoteLink[]
  /** 单向感知（偷听/监控等——能感知但无法互动，现场角色不知道）；缺省 = 无。 */
  overhear?: RemoteLink[]
  reason: string
  ts: string
}

/** 用户与总管的戏外对话（纠正窗口）——**永不下发给角色**，只用于审计与回看。 */
export interface DirectorLine {
  type: 'director'
  text: string
  reply: string
  applied: string[]
  ts: string
}

/** 角色改名（append-only）：旧账目（ledger/presence 行）经名字链归到新名下重放。 */
export interface RenameLine {
  type: 'rename'
  from: string
  to: string
  ts: string
}

export type StoryLine = HeaderLine | MsgLine | RouteLine | LedgerLine | SwipeLine | EditLine | DeleteLine | PresenceLine | DirectorLine | RenameLine

export class StoryStore {
  readonly path: string
  private lines: StoryLine[] = []
  /** 已发出过的最大消息 id（含已被物理删除的）——nextMsgId 的取号基准，保证 id 永不复用。 */
  private maxIdEver = 0

  private constructor(readonly groupDir: string, readonly group: string, path: string) {
    this.path = path
  }

  private aliases?: Map<string, string>

  /** 打开群聊；不存在则初始化（写 header 行）。坏行（JSON.parse 失败）忽略，不让整份日志打不开。 */
  static open(groupDir: string, group: string): StoryStore {
    const path = join(groupDir, '剧情.jsonl')
    const store = new StoryStore(groupDir, group, path)
    if (existsSync(path)) {
      store.lines = readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.trim() !== '')
        .flatMap(l => {
          try { return [JSON.parse(l) as StoryLine] } catch { return [] } // 与 记忆.jsonl 尾部半行同策略
        })
      if (store.lines[0]?.type !== 'header') throw new Error(`剧情.jsonl 缺少 header 行: ${path}`)
    } else {
      store.lines = [{ type: 'header', group, created: new Date().toISOString(), v: 1 }]
      store.rewrite()
    }
    // 取号基准：header 快照 ∪ 现存消息 id ∪ 旧版派生行的 target（旧日志兼容）
    const header = store.lines[0]
    store.maxIdEver = Math.max(
      header?.type === 'header' ? header.lastMsgId ?? 0 : 0,
      0,
      ...store.lines.flatMap(l =>
        l.type === 'msg' ? [l.id]
          : l.type === 'swipe' || l.type === 'edit' || l.type === 'delete' ? [l.target_id]
            : []),
    )
    return store
  }

  get messages(): MsgLine[] {
    return this.lines.filter((l): l is MsgLine => l.type === 'msg')
  }

  /** 用户消息轮数（round 从 1 起）。 */
  get round(): number {
    return this.messages.filter(m => m.role === 'user').length
  }

  /** 下一条消息将使用的 id（含已物理删除的 id：永不复用，防止撞撤回抑制集合）。 */
  get nextMsgId(): number {
    return this.maxIdEver + 1
  }

  /**
   * 物理改写某条消息的文本（当前上下文快照语义）：msg 行就地更新，该消息的旧版 swipe/edit
   * 派生行一并清掉（否则视图会用旧文本覆盖物理文本）。
   */
  rewriteMessage(id: number, text: string): MsgLine {
    const target = this.messages.find(m => m.id === id)
    if (target === undefined) throw new Error(`消息不存在: #${id}`)
    target.text = text
    this.lines = this.lines.filter(l => !((l.type === 'swipe' || l.type === 'edit') && l.target_id === id))
    this.rewrite()
    return target
  }

  /** 物理删除某条消息（当前上下文快照语义）：msg 行与该 id 的旧版派生行从日志移除，原文不留痕。 */
  removeMessage(id: number): void {
    if (!this.messages.some(m => m.id === id)) throw new Error(`消息不存在: #${id}`)
    this.lines = this.lines.filter(l =>
      !(l.type === 'msg' && l.id === id)
      && !((l.type === 'swipe' || l.type === 'edit' || l.type === 'delete') && l.target_id === id))
    this.rewrite()
  }

  /** 物理改写命中的账本行（当前上下文快照语义：账本行跟着消息文本走，旧原文不留痕）。返回改写行数。 */
  rewriteLedgerRows(match: (l: LedgerLine) => boolean, transform: (content: string) => string): number {
    let n = 0
    for (const l of this.lines) {
      if (l.type !== 'ledger' || !match(l)) continue
      const next = transform(l.content)
      if (next !== l.content) { l.content = next; n++ }
    }
    if (n > 0) this.rewrite()
    return n
  }

  /** 物理移除命中的账本行（当前上下文快照语义：消息删除后其账本行一并消失）。返回移除行数。 */
  removeLedgerRows(match: (l: LedgerLine) => boolean): number {
    const before = this.lines.length
    this.lines = this.lines.filter(l => !(l.type === 'ledger' && match(l)))
    const removed = before - this.lines.length
    if (removed > 0) this.rewrite()
    return removed
  }

  append(
    role: MsgLine['role'],
    name: string,
    text: string,
    visibleTo: 'all' | string[] = 'all',
    scope: 'public' | 'private' = 'public',
  ): MsgLine {
    const msg: MsgLine = {
      type: 'msg',
      id: this.nextMsgId,
      role,
      name,
      text,
      round: this.round + (role === 'user' ? 1 : 0),
      visible_to: visibleTo,
      scope,
      ts: new Date().toISOString(),
    }
    this.maxIdEver = msg.id
    this.lines.push(msg)
    appendFileSync(this.path, JSON.stringify(msg) + '\n', 'utf8')
    return msg
  }

  /** 该消息对某角色是否可见（SPEC §4.3 可见性规则）。 */
  static isVisibleTo(m: MsgLine, characterName: string): boolean {
    return m.visible_to === 'all' || m.visible_to.includes(characterName)
  }

  /** 戏外对话落盘（纠正窗口；不进任何角色的可见视图）。 */
  appendDirector(text: string, reply: string, applied: string[]): void {
    const line: DirectorLine = { type: 'director', text, reply, applied: [...applied], ts: new Date().toISOString() }
    this.lines.push(line)
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  /** 戏外对话历史（供前端回看）。 */
  directorHistory(): DirectorLine[] {
    return this.lines.filter((l): l is DirectorLine => l.type === 'director')
  }

  /** 场景人员变更落盘（append-only；在场.yaml 由其重放重建）。 */
  appendPresence(present: string[], reason: string, remote: RemoteLink[] = [], overhear: RemoteLink[] = []): void {
    const line: PresenceLine = {
      type: 'presence',
      present: [...present],
      ...(remote.length > 0 ? { remote: remote.map(l => ({ ...l })) } : {}),
      ...(overhear.length > 0 ? { overhear: overhear.map(l => ({ ...l })) } : {}),
      reason,
      ts: new Date().toISOString(),
    }
    this.lines.push(line)
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  /** 最后一次场景快照（无记录 = 未判断过）。 */
  lastScene(): SceneAccess | undefined {
    const line = [...this.lines].reverse().find((l): l is PresenceLine => l.type === 'presence')
    if (line === undefined) return undefined
    return {
      present: [...line.present],
      remote: (line.remote ?? []).map(l => ({ ...l })),
      overhear: (line.overhear ?? []).map(l => ({ ...l })),
    }
  }

  /** 最后一条 presence 行之前已落盘的消息数（消息 id 从 1 连续递增，即"最近一次场景变更时的最新消息 id"）。 */
  lastSceneMsgCount(): number | undefined {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].type !== 'presence') continue
      return this.lines.slice(0, i).filter((l): l is MsgLine => l.type === 'msg').length
    }
    return undefined
  }

  /**
   * 某角色最后一次"离场"时的消息 id 快照（事件补全 §5.9 的离场窗口起点，纯代码）：
   * 在他最后一次在场的 presence 行之后、第一条不含他的 presence 行处离场——
   * 离场窗口 = 生效视图中 id 大于该值的消息。从未在场（首次进场）或从未离场 → undefined。
   */
  absenceStartId(name: string): number | undefined {
    let inScene = false
    let departedId: number | undefined
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i]
      if (l.type !== 'presence') continue
      const now = l.present.includes(name)
      if (inScene && !now) {
        let maxId = 0
        for (let j = 0; j < i; j++) {
          const x = this.lines[j]
          if (x.type === 'msg' && x.id > maxId) maxId = x.id
        }
        departedId = maxId
      }
      inScene = now
    }
    return departedId
  }

  /** 最后一条用户消息的 id（新接入者的馈送起点锚在其前一行——引起接入的那句呼叫能被听到）。 */
  lastUserMsgId(): number | undefined {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i]
      if (l.type === 'msg' && l.role === 'user') return l.id
    }
    return undefined
  }

  /** 被用户删除过的消息 id 集合（delete 行的 target_id；删除 = 这条消息对一切意图都不存在）。 */
  deletedMsgIds(): Set<number> {
    const out = new Set<number>()
    for (const l of this.lines) if (l.type === 'delete') out.add(l.target_id)
    return out
  }

  /** 角色改名落盘（旧名 → 新名；账目按名字链归一重放）。 */
  appendRename(from: string, to: string): void {
    const line: RenameLine = { type: 'rename', from, to, ts: new Date().toISOString() }
    this.lines.push(line)
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
    this.aliases = undefined
  }

  /** 名字链归一：把日志里的历史名映射到当前名（A→B→C 时 A、B 都归到 C）。 */
  nameOf(raw: string): string {
    if (this.aliases === undefined) {
      this.aliases = new Map<string, string>()
      for (const l of this.lines) {
        if (l.type !== 'rename') continue
        for (const [k, v] of this.aliases) if (v === l.from) this.aliases.set(k, l.to)
        this.aliases.set(l.from, l.to)
      }
    }
    return this.aliases.get(raw) ?? raw
  }

  /** 路由决策落盘（SPEC §3.5 route 行）。 */
  appendRoute(picked: string, reason: string, fallback: boolean): void {
    const line: RouteLine = { type: 'route', round: this.round, picked, reason, fallback }
    this.lines.push(line)
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  /** 记账事件落盘（SPEC §3.8 ledger 行；状态/性格/关系/记忆四文件由其重放重建）。 */
  appendLedgerLine(character: string, section: LedgerLine['section'], op: LedgerLine['op'], content: string): void {
    const line: LedgerLine = { type: 'ledger', character, section, op, content }
    this.lines.push(line)
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  /** swipe 重掷（旧版语义，仅为旧日志与测试保留——现版本重掷由 rewriteMessage 物理改写，不再产出 swipe 行）：
   *  variants 累积全部候选，chosen 指向当前生效文本。 */
  appendSwipe(targetId: number, newVariant: string): void {
    const target = this.messages.find(m => m.id === targetId)
    if (target === undefined) throw new Error(`swipe 目标不存在: #${targetId}`)
    const prev = [...this.lines].reverse().find((l): l is SwipeLine => l.type === 'swipe' && l.target_id === targetId)
    const variants = [...(prev?.variants ?? [target.text])]
    if (!variants.includes(newVariant)) variants.push(newVariant)
    const line: SwipeLine = { type: 'swipe', target_id: targetId, variants, chosen: variants.length - 1 }
    this.lines.push(line)
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  /** 用户手动改某条消息的文本（旧版语义，仅为旧日志与测试保留——现版本由 rewriteMessage 物理改写）。 */
  appendEdit(targetId: number, text: string): void {
    const target = this.messages.find(m => m.id === targetId)
    if (target === undefined) throw new Error(`消息不存在: #${targetId}`)
    const line: EditLine = { type: 'edit', target_id: targetId, text, ts: new Date().toISOString() }
    this.lines.push(line)
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  /** 用户手动删除某条消息（旧版语义，仅为旧日志与测试保留——现版本由 removeMessage 物理移除）。 */
  appendDelete(targetId: number): void {
    const target = this.messages.find(m => m.id === targetId)
    if (target === undefined) throw new Error(`消息不存在: #${targetId}`)
    const line: DeleteLine = { type: 'delete', target_id: targetId, ts: new Date().toISOString() }
    this.lines.push(line)
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8')
  }

  /**
   * 组装/展示用消息视图：按时间顺序应用 swipe（重掷）→ edit（手改）→ delete（手删）。
   * append-only 日志上的派生视图——原行永不改动，故 rebuild 与审计不受影响。
   */
  effectiveMessages(): MsgLine[] {
    const textById = new Map<number, string>()
    const deleted = new Set<number>()
    for (const l of this.lines) {
      if (l.type === 'swipe') textById.set(l.target_id, l.variants[l.chosen])
      else if (l.type === 'edit') textById.set(l.target_id, l.text)
      else if (l.type === 'delete') deleted.add(l.target_id)
    }
    return this.messages
      .filter(m => !deleted.has(m.id))
      .map(m => (textById.has(m.id) ? { ...m, text: textById.get(m.id)! } : m))
  }

  /** 最后一条角色消息（swipe/编辑的目标定位；用可见视图）。 */
  lastCharacterMessage(): MsgLine | undefined {
    return [...this.effectiveMessages()].reverse().find(m => m.role === 'character')
  }

  /** 全量行访问（rebuild 重放用）。 */
  get allLines(): readonly StoryLine[] {
    return this.lines
  }

  /** /new：归档当前日志并重新初始化。 */
  reset(): void {
    if (existsSync(this.path)) {
      renameSync(this.path, this.path.replace(/\.jsonl$/, `.${Date.now()}.bak.jsonl`))
    }
    this.lines = [{ type: 'header', group: this.group, created: new Date().toISOString(), v: 1 }]
    this.maxIdEver = 0
    this.rewrite()
  }

  /** 全量重写（rebuild/重置/消息物理改删用）；header.lastMsgId 随写随新，删除后的 id 永不复用。 */
  private rewrite(): void {
    mkdirSync(this.groupDir, { recursive: true })
    const header = this.lines[0]
    if (header?.type === 'header') header.lastMsgId = this.maxIdEver
    writeFileSync(this.path, this.lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  }
}
