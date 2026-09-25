/**
 * GroupSession 引擎（SPEC §4.2-§4.4 的框架无关实现）：
 * CLI（src/group-cli.ts）与 HTTP 服务（src/server.ts）共用。
 *
 * 角色文件分工（SPEC §3.3-§3.6）：
 *   角色.md 只读（用户专属）· 性格.md 初始+演变 · 状态.md 实时字段 · 记忆.md 知情账本
 * 一切变更先写 剧情.jsonl 的 ledger 行（唯一事实源），再刷新对应文件（派生缓存）。
 */
import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'
import { StoryStore, type MsgLine, type RouteLine } from '../store.ts'
import { hasGroupSettings, loadCharacters, loadGroupSettings, loadUserPersona, type CharacterPersona, type UserPersona } from './persona.ts'
import { loadRules } from './rules.ts'
import { canWitness, emptyScene, loadScene, perceives, saveScene, type RemoteLink, type SceneAccess } from './presence.ts'
import { askDirector, askOffStoryDiscovery, askOffStoryPOV, askSceneSummarizer, assembleGroup, askBookkeeper, jevAfterReply, jevExtraRounds, jevRoute, routeNextSpeaker, type JevAfterReplyResult, type RouteResult } from './host.ts'
import { turnFromMessages } from '../host.ts'
import { resolveRouter } from '../settings.ts'
import { LEDGER_KEYS, loadFiles, saveMemory, savePersonality, saveRelationships, saveStatus, type CharacterFiles } from './status.ts'
import { backfillKnowledge, buildMemory, missingRounds, transplantRounds, witnessSummary } from './knowledge.ts'
import { resolveCharacterName, type RoutableCharacter } from './router.ts'

export type SessionEvent =
  | { type: 'speaker'; name: string }
  | { type: 'route'; picked: string; reason: string; fallback: boolean }
  | { type: 'delta'; text: string }
  | { type: 'reply'; name: string; text: string; private: boolean }
  | { type: 'ledger'; text: string }
  | { type: 'info'; text: string }

export class GroupSession {
  readonly store: StoryStore
  readonly characters: CharacterPersona[]
  settings: ReturnType<typeof loadGroupSettings>
  /** 用户自己的设定（称呼 + 自由文本），每个角色与总管都能看到。 */
  userPersona: UserPersona
  /** 全局规则（工作区根 规则.md，用户自写的约束词；每个角色与总管都读）。 */
  rules: string
  /** 场景人员（现场 + 远程实时接入）；未配置 = 全员现场。 */
  private scene: SceneAccess
  private readonly byName: Map<string, CharacterPersona>
  private readonly books = new Map<string, CharacterFiles>()
  /** 后台任务队列（慢路径记账）：串行执行；新一轮发言前先清空队列，避免与新一轮的文件写入交错。 */
  private bg: Promise<void> = Promise.resolve()
  /** 本轮进行中的"入场包"（§5.8 现场所见 + §5.9 事件补全）：接力判到进场者发言时，
   *  speakAs 组装前必须等它完成——进场者必须先带着记忆开口。 */
  private sceneSnapshot?: { targets: Set<string>; done: Promise<void> }
  private readonly roster: RoutableCharacter[]
  private readonly rosterLines: string[]

  private constructor(readonly groupName: string, readonly groupDir: string) {
    this.store = StoryStore.open(groupDir, groupName)
    this.characters = loadCharacters(groupDir)
    this.settings = loadGroupSettings(groupDir)
    this.userPersona = loadUserPersona(groupDir)
    this.rules = loadRules()
    const saved = loadScene(groupDir)
    // 场景来源优先级：日志里最后一次 presence 行（事实源）→ 在场.yaml → 全员现场
    // presence 行里的旧角色名经名字链（rename 行）归一到当前名，改名者不会被静默踢出现场
    const fromLog = this.store.lastScene()
    const rawName = (scene: SceneAccess): SceneAccess => ({
      present: scene.present.map(n => this.store.nameOf(n)),
      remote: scene.remote.map(l => ({ ...l, character: this.store.nameOf(l.character) })),
      overhear: scene.overhear.map(l => ({ ...l, character: this.store.nameOf(l.character) })),
    })
    const nonEmpty = (s: SceneAccess): boolean => s.present.length > 0 || s.remote.length > 0 || s.overhear.length > 0
    const raw = fromLog !== undefined ? rawName(fromLog)
      : (nonEmpty(saved) ? rawName(saved) : { present: this.characters.map(c => c.name), remote: [], overhear: [] })
    this.scene = raw
    this.byName = new Map(this.characters.map(c => [c.name, c]))
    this.roster = this.characters.map(c => ({ name: c.name }))
    this.rosterLines = this.characters.map(c =>
      `${c.name}｜${(c.personalityFallback || c.appearance).split(/[，。.！!？?\n]/)[0] ?? ''}`,
    )
  }

  /** 全角色外观层（名字 → 角色.md 外观）：assembleGroup 注入在场者外观用（§6.2，仅外观层）。 */
  private get appearanceMap(): Record<string, string> {
    return Object.fromEntries(this.characters.map(c => [c.name, c.appearance]))
  }

  /** 现场者（与实际角色取交集，防止角色被删后残留）。 */
  presentNames(): string[] {
    return this.scene.present.filter(n => this.byName.has(n))
  }

  /** 通道接入者（不在现场、当下双向连通；与实际角色取交集）。 */
  remoteLinks(): RemoteLink[] {
    const names = new Set(this.characters.map(c => c.name))
    return this.scene.remote.filter(l => names.has(l.character) && !this.scene.present.includes(l.character))
  }

  /** 单向感知者（偷听/监控——能知道这里的事、不能互动、现场角色不知道他在听；与实际角色取交集）。 */
  overhearLinks(): RemoteLink[] {
    const names = new Set(this.characters.map(c => c.name))
    return this.scene.overhear.filter(l =>
      names.has(l.character) && !this.scene.present.includes(l.character) && !this.scene.remote.some(r => r.character === l.character))
  }

  /**
   * 能发言的人 = 现场者 ∪ 通道接入者（连通即能对讲）。
   * 单向感知者（偷听）**不能发言**——要让他开口，先让他现身或接入。
   */
  speakableNames(): string[] {
    return [...new Set([...this.presentNames(), ...this.remoteLinks().map(l => l.character)])]
  }

  /** 规范化：只留存在的角色，且现场 > 接入 > 偷听（同一人只保留最高一层）。 */
  private normalizeScene(scene: SceneAccess): SceneAccess {
    const present = [...new Set(scene.present.filter(n => this.byName.has(n)))]
    const seen = new Set(present)
    const pick = (links: RemoteLink[]): RemoteLink[] => links.flatMap(l => {
      if (!this.byName.has(l.character) || seen.has(l.character)) return []
      seen.add(l.character)
      return [{ ...l }]
    })
    return { present, remote: pick(scene.remote), overhear: pick(scene.overhear) }
  }

  private sameScene(a: SceneAccess, b: SceneAccess): boolean {
    return JSON.stringify(this.normalizeScene(a)) === JSON.stringify(this.normalizeScene(b))
  }

  /**
   * 更新场景人员（写入 append-only 的 presence 行 → 在场.yaml 是派生缓存、可 rebuild 重建）。
   * 每个接入/偷听者带自己的感知起点（since）：续接的保留原值（别人进出不影响他），
   * 新出现的锚在"最后一句用户呼叫"之前——引起感知的那句呼叫/动作能被听到。
   */
  setScene(scene: SceneAccess, reason = '场景人员变动'): void {
    const next = this.normalizeScene(scene)
    const oldLinks = new Map([...this.scene.remote, ...this.scene.overhear].map(l => [l.character, l]))
    const fallbackSince = this.store.lastSceneMsgCount() ?? 0
    const callBaseline = Math.max(0, (this.store.lastUserMsgId() ?? 1) - 1)
    const withSince = (links: RemoteLink[]): RemoteLink[] => links.map(l => {
      const prev = oldLinks.get(l.character)
      const since = prev !== undefined
        ? (prev.since ?? fallbackSince) // 续接：旧数据（无 since）回退全局锚点
        : callBaseline // 新出现：从引起感知的那句用户发言起听
      return { ...l, since }
    })
    next.remote = withSince(next.remote)
    next.overhear = withSince(next.overhear)
    this.scene = next
    this.store.appendPresence(next.present, reason, next.remote, next.overhear)
    saveScene(this.groupDir, next)
  }

  /** 当前场景快照（供总管提示与前端显示）。 */
  sceneAccess(): SceneAccess {
    return { present: this.presentNames(), remote: this.remoteLinks(), overhear: this.overhearLinks() }
  }

  /**
   * 确定性保底知情名单（Jev 不可用时）：现场 ∩ 感知完整。
   * 正常路径的知情由 Jev 判定（§4.3）：在场感知、经通道感知都算；**知情 = 原文移植进账本**（不做总结）。
   */
  private witnesses(exclude?: string): string[] {
    return this.presentNames().filter(n => {
      if (n === exclude) return false
      const f = this.filesFor(n)
      return f === undefined ? true : canWitness(f.status)
    })
  }

  /**
   * 把 Jev 的知情名单落到实际受众：排除不存在/发言者本人；
   * 通道接入者与单向感知者受**各自 since 锚点**约束（接入/开始感知之前的事不知道）。
   */
  private audienceOf(knows: ReadonlySet<string>, msgId: number, exclude?: string): string[] {
    const links = new Map([...this.scene.remote, ...this.scene.overhear].map(l => [l.character, l]))
    const fallbackSince = this.store.lastSceneMsgCount() ?? 0
    return this.characters
      .map(c => c.name)
      .filter(n => n !== exclude && knows.has(n))
      .filter(n => {
        const link = links.get(n)
        // 旧数据无 since：回退全局锚点（最后一条 presence 行前）——接入/开始感知之前的消息不进名单
        return link === undefined || msgId > (link.since ?? fallbackSince)
      })
  }

  static open(groupName: string): GroupSession {
    if (groupName === undefined || groupName === '' || /[\\/]/.test(groupName)) throw new Error(`非法群聊名: ${String(groupName)}`)
    const groupDir = join(config.groupsDir, groupName)
    if (!hasGroupSettings(groupDir)) throw new Error(`群聊目录不存在或缺少 群设定.yaml: ${groupDir}`)
    const s = new GroupSession(groupName, groupDir)
    // 零角色是合法状态（新建的群），说话时才提示
    s.backfillAll()
    return s
  }

  characterNames(): string[] {
    return this.characters.map(c => c.name)
  }

  charDir(name: string): string | undefined {
    const p = this.byName.get(name)
    return p === undefined ? undefined : join(this.groupDir, '角色', p.dirName)
  }

  /** 前端初始渲染快照：应用 swipe 后的消息 + 路由行。 */
  snapshot(): { name: string; era: string; world: string; tone: string; userName: string; present: string[]; remote: RemoteLink[]; overhear: RemoteLink[]; absent: string[]; characters: Array<{ name: string; dirName: string }>; messages: MsgLine[]; routes: RouteLine[] } {
    const routes = this.store.allLines.filter((l): l is RouteLine => l.type === 'route')
    const present = this.presentNames()
    const remote = this.remoteLinks()
    const overhear = this.overhearLinks()
    return {
      name: this.groupName,
      era: this.settings.era,
      world: this.settings.world,
      tone: this.settings.tone,
      userName: this.userPersona.name,
      present,
      remote,
      overhear,
      absent: this.characters.map(c => c.name).filter(n => !present.includes(n) && !remote.some(l => l.character === n) && !overhear.some(l => l.character === n)),
      characters: this.characters.map(c => ({ name: c.name, dirName: c.dirName })),
      messages: this.store.effectiveMessages(),
      routes,
    }
  }

  statusLines(): string[] {
    return this.characters.map(c => {
      const f = this.filesFor(c.name)
      if (f === undefined) return `- ${c.name}：（不存在）`
      const lines = LEDGER_KEYS.map(k => `${k}:"${f.status[k]?.trim() || '无'}"`).join('\n')
      return `【${c.name}】\n${lines}\n记忆 ${f.memory.length} 条`
    })
  }

  /** 查看某角色的状态账本（固定七字段）。 */
  ledgerOf(name: string): Record<string, string> {
    const f = this.filesFor(name)
    if (f === undefined) throw new Error(`未知角色: ${name}`)
    return LEDGER_KEYS.reduce<Record<string, string>>((acc, k) => { acc[k] = f.status[k]?.trim() || ''; return acc }, {})
  }

  /** 状态账本整体快照更新（用户手动修正；缺省字段保持）。 */
  setLedger(name: string, fields: Record<string, string>): void {
    const f = this.filesFor(name)
    if (f === undefined) throw new Error(`未知角色: ${name}`)
    this.recordRouteChanges([{ character: name, fields }])
  }

  /** 各角色当前状态账本（"名｜生理状态:…"；供慢路径整体快照更新作基准）。 */
  private ledgerLines(): string[] {
    return this.characters.flatMap(c => {
      const f = this.filesFor(c.name)
      if (f === undefined) return []
      const fields = LEDGER_KEYS.map(k => `${k}:${f.status[k]?.trim() || '无'}`).join('；')
      return [`${c.name}｜${fields}`]
    })
  }

  /** 各角色的状态原文（`名｜键=值；…`，无状态者省略）——感知门控与快路径判断的原料，Jev 自行读懂语义。 */
  private statusNotes(): string[] {
    return this.characters.flatMap(c => {
      const f = this.filesFor(c.name)
      if (f === undefined) return []
      const fields = Object.entries(f.status).map(([k, v]) => `${k}=${v}`).join('；')
      return fields === '' ? [] : [`${c.name}｜${fields}`]
    })
  }

  /** 按名字子集过滤人物速览行（rosterLines 与 this.characters 同源同序）。 */
  private rosterLinesFor(names: readonly string[]): string[] {
    const set = new Set(names)
    return this.characters.flatMap((c, i) => (set.has(c.name) ? [this.rosterLines[i]] : []))
  }

  /**
   * 额外记忆移植（§5.7）：转告触发名单里的每个角色，先算他缺失的轮次，二段逐轮判定后
   * 把命中轮的消息逐字移植进账本（source=额外得知，带原 mid/round）。
   * 同步执行——必须在下一跳发言组装前完成（"让他也说一下"后接力到他时，记忆必须已就位）。
   * 二段失败/零命中静默跳过：漏补只是维持现状（可手动补），错补却要手动撤。
   */
  private async *grantExtraMemory(targets: ReadonlySet<string>, retoldText: string, routerLlm: NonNullable<ReturnType<typeof resolveRouter>>): AsyncGenerator<SessionEvent> {
    for (const name of targets) {
      const files = this.filesFor(name)
      if (files === undefined) continue
      const missing = missingRounds(this.store, files.memory)
      if (missing.length === 0) {
        this.judgeLog({ phase: '额外记忆判定', character: name, note: '无缺失轮，跳过' })
        continue // 他没有缺失轮（全都知道）：无东西可转告
      }
      const flagged = await jevExtraRounds({
        llm: routerLlm,
        character: name,
        retoldText,
        missing,
        timeoutMs: config.jevTimeoutMs,
        log: e => this.judgeLog({ phase: '额外记忆判定', ...e }),
      })
      if (flagged === undefined || flagged.size === 0) continue
      const added = transplantRounds(this.store, name, files.memory, flagged)
      for (const e of added) {
        this.store.appendLedgerLine(name, 'knowledge', 'append', JSON.stringify({
          source: e.source,
          ...(e.mid === undefined ? {} : { mid: e.mid }),
          round: e.round,
          text: e.text,
        }))
      }
      if (added.length > 0) {
        this.persistFiles(name)
        const rounds = [...new Set(added.map(e => e.round))].sort((a, b) => a - b)
        yield { type: 'info', text: `（${name} 额外得知 第${rounds.join('、')}轮的内容——已按原文写入他的记忆）` }
      }
    }
  }

  /**
   * 快路径后台记账：工作列表逐条调 DeepSeek（bg 队列串行；每条 = 一段用户发言或一段角色回复）。
   * 失败只记日志，绝不影响已完成的回复。空列表不调用（记账门控：判定无变化就不花这次钱）。
   */
  private enqueueBookkeeper(userText: string, work: Array<{ speaker: string; replyText: string }>): void {
    if (work.length === 0) return
    this.enqueueBg(async () => {
      for (const w of work) {
        try {
          const book = await askBookkeeper({
            rosterLines: this.rosterLines,
            presentNotes: this.presentNotes(),
            ledgers: this.ledgerLines(),
            userText,
            speaker: w.speaker,
            replyText: w.replyText,
            recent: this.store.effectiveMessages().slice(-8).map(m => `${m.name}：${m.text}`).join('\n'),
            tone: this.settings.tone,
            rules: this.rules,
            timeoutMs: Math.max(config.directorTimeoutMs, 60000),
          })
          // 记账员只有状态账本写入权（§6.1b）：presence_updates 权力已摘除，
          // 场景名册由 Jev 每轮判定 / 总管代管 / 用户手动修正维护
          const notes = this.recordRouteChanges(book.ledgerUpdates)
          this.judgeLog({
            phase: '记账',
            subject: w.speaker === '' ? '用户消息' : `${w.speaker} 的回复`,
            ledgerUpdates: notes,
          })
        } catch (e) {
          this.judgeLog({ phase: '记账', subject: w.speaker === '' ? '用户消息' : `${w.speaker} 的回复`, error: String(e instanceof Error ? e.message : e) })
          if (process.env.DSH_DEBUG === '1') console.error('[bookkeeper] 后台记账失败:', e)
        }
      }
    })
  }

  /**
   * 场景人员及其感知/通道备注（供总管判断谁知道什么）：
   * 现场者标感知障碍（如 "角色乙（失聪）"）；接入者标通道与其上限；单向感知者标途径
   * （如 "角色丁（单向感知·只闻声·窗外）"）——偷听者只给总管和玩家看，现场角色看不到。
   */
  private presentNotes(): string[] {
    const marksOf = (n: string): string => {
      const f = this.filesFor(n)
      if (f === undefined) return ''
      const p = perceives(f.status)
      return [p.hearing ? '' : '失聪', p.sight ? '' : '失明'].filter(s => s !== '').join('+')
    }
    return [
      ...this.presentNames().map(n => {
        const marks = marksOf(n)
        return marks === '' ? n : `${n}（${marks}）`
      }),
      ...this.remoteLinks().map(l => {
        const marks = marksOf(l.character)
        const via = `通道接入·${l.perceive === '语音' ? '只有声音' : '声音和画面'}${l.note !== undefined ? `·${l.note}` : ''}`
        return `${l.character}（${marks === '' ? via : `${via}·${marks}`}）`
      }),
      ...this.overhearLinks().map(l => {
        const marks = marksOf(l.character)
        const via = `单向感知·${l.perceive === '语音' ? '只闻声' : '只见画面'}${l.note !== undefined ? `·${l.note}` : ''}`
        return `${l.character}（${marks === '' ? via : `${via}·${marks}`}）`
      }),
    ]
  }

  private enqueueBg(task: () => Promise<void>): void {
    this.bg = this.bg.then(task, () => undefined)
  }

  /**
   * 现场所见（§5.8）：为**本轮新进现场者**生成一份"进门第一眼看到的实况"白描，
   * 同一份注入全部进场者的记忆（source=现场所见，无 mid，第 N 轮）。
   * 失败/为空不注入（维持现状，可手动补）。
   */
  private runSceneSnapshot(targets: Set<string>): Promise<string | undefined> {
    return (async (): Promise<string | undefined> => {
      try {
        const summary = await askSceneSummarizer({
          presentNotes: this.presentNotes(),
          ledgers: this.ledgerLines(),
          recent: this.store.effectiveMessages().slice(-12).map(m => `${m.name}：${m.text}`).join('\n'),
          tone: this.settings.tone,
          timeoutMs: Math.max(config.directorTimeoutMs, 60000),
        })
        for (const name of targets) {
          const f = this.filesFor(name)
          if (f === undefined) continue
          const entry = { source: '现场所见', round: this.store.round, text: summary }
          f.memory.push(entry)
          this.store.appendLedgerLine(name, 'knowledge', 'append', JSON.stringify(entry))
          this.persistFiles(name)
        }
        this.judgeLog({ phase: '现场所见', targets: [...targets], summary })
        return summary
      } catch (e) {
        this.judgeLog({ phase: '现场所见', targets: [...targets], error: String(e instanceof Error ? e.message : e) })
        if (process.env.DSH_DEBUG === '1') console.error('[scene] 现场所见汇总失败（不注入）:', e)
        return undefined
      }
    })()
  }

  /**
   * 事件补全（§5.9）：为回归者（有离场窗口的进场者）补全离场期间的经历。
   * 两段式：发现（一次调用，多事件×各参与者客观骨架）→ 限知视角渲染（每个事件×参与者一次，
   * 事实锚死在骨架上、视角按参与者自身性格走）。同一份事件的不同参与者的记忆事实一致、视角各异。
   * 非 enterant 的参与者（如受命办事后未入场者）同样获得自己的视角记忆。失败不注入。
   */
  private async runOffStory(targets: Set<string>): Promise<void> {
    try {
      const windows = [...targets].flatMap(name => {
        const start = this.store.absenceStartId(name)
        if (start === undefined) return [] // 首次进场：无离场窗口，人生前史不由系统虚构
        const dialogue = this.store.effectiveMessages().filter(m => m.id > start)
          .slice(-40).map(m => `${m.name}：${m.text}`).join('\n')
        return dialogue.trim() === '' ? [] : [{ character: name, dialogue }]
      })
      if (windows.length === 0) return
      const known: string[] = []
      for (const c of this.characters) {
        const f = this.filesFor(c.name)
        for (const e of f?.memory ?? []) if (e.source === '离场经历') known.push(e.text)
      }
      const events = await askOffStoryDiscovery({
        windows,
        known,
        rosterNames: this.characterNames(),
        tone: this.settings.tone,
        timeoutMs: Math.max(config.directorTimeoutMs, 60000),
        log: e => this.judgeLog({ phase: '事件补全发现', ...e }),
      })
      if (events === undefined || events.length === 0) return
      // 渲染：每个（事件 × 参与者）一份限知视角，事实锚死在骨架上；并行
      const renders = await Promise.all(events.flatMap(ev =>
        ev.participants.map(async p => {
          const f = this.filesFor(p)
          if (f === undefined) return undefined
          const ledgerLine = `${p}｜${Object.entries(f.status).map(([k, v]) => `${k}:${v}`).join('；')}`
          const text = await askOffStoryPOV({
            event: ev.summary,
            participant: p,
            personality: f.personality.base,
            ledgerLine,
            timeoutMs: Math.max(config.directorTimeoutMs, 60000),
            log: e => this.judgeLog({ phase: '离场经历渲染', event: ev.summary, ...e }),
          })
          return text === undefined ? undefined : { participant: p, text }
        })))
      const seen = new Set<string>()
      for (const r of renders) {
        if (r === undefined) continue
        const key = `${r.participant}|${r.text}`
        if (seen.has(key)) continue
        seen.add(key)
        const f = this.filesFor(r.participant)
        if (f === undefined) continue
        const entry = { source: '离场经历', round: this.store.round, text: r.text }
        f.memory.push(entry)
        this.store.appendLedgerLine(r.participant, 'knowledge', 'append', JSON.stringify(entry))
        this.persistFiles(r.participant)
        this.judgeLog({ phase: '事件补全', participant: r.participant, memory: r.text })
      }
    } catch (e) {
      this.judgeLog({ phase: '事件补全', error: String(e instanceof Error ? e.message : e) })
      if (process.env.DSH_DEBUG === '1') console.error('[offstory] 事件补全失败（不注入）:', e)
    }
  }

  /**
   * 入场包（§5.8 + §5.9）：现场所见（全体进场者）与事件补全（回归者的离场经历，按参与者限知视角）
   * **并行**执行；注入全部落盘后 done 才结算——接力判到进场者发言时 speakAs 会先等整个包完成。
   */
  private beginEntryKit(entrants: string[]): { targets: Set<string>; done: Promise<void> } {
    const targets = new Set(entrants)
    const done = (async (): Promise<void> => {
      await Promise.all([this.runSceneSnapshot(targets), this.runOffStory(targets)])
    })()
    return { targets, done }
  }

  /**
   * 入场包触发：对比进场前后的现场名单（纯代码差集，不花 Jev），
   * 新进现场者 → 后台入场包（现场所见 + 事件补全）注入其记忆。
   * 说话回合与用户手动修正都走这里；接力判到进场者发言时 speakAs 会先等注入完成。
   */
  maybeSnapshotEntrants(beforePresent: readonly string[], note = '新进现场'): void {
    const entrants = this.sceneAccess().present.filter(n => !beforePresent.includes(n) && this.byName.has(n))
    if (entrants.length === 0) return
    const job = this.beginEntryKit(entrants)
    this.sceneSnapshot = job
    this.enqueueBg(() => job.done.then(() => undefined))
    this.judgeLog({ phase: '现场所见', note: `${note}：${entrants.join('、')}——后台生成入场包（现状快照+离场经历）` })
  }

  /**
   * 判定/后台运行日志（groups/<群>/判定.jsonl，append-only，**只给人看**——前端侧边栏展示）。
   * 记录每轮判定走了哪条路、每道题的原始答案与耗时、记账门控开没开、回退原因——不再盲审。
   * 写日志失败绝不影响剧情。
   */
  private judgeLog(entry: Record<string, unknown>): void {
    try {
      appendFileSync(join(this.groupDir, '判定.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8')
    } catch { /* 日志失败不影响剧情 */ }
  }

  private async drainBg(): Promise<void> {
    await this.bg.catch(() => undefined)
  }

  /**
   * 每轮开始前丢弃内存缓存，下一轮从磁盘重读角色文件、全局规则、用户设定与群设定。
   * 磁盘始终是事实源（不变式 3）：用户手改任何文件，下一轮即刻生效——不依赖界面保存触发会话重建。
   */
  private reloadBooks(): void {
    this.books.clear()
    this.rules = loadRules()
    this.userPersona = loadUserPersona(this.groupDir)
    this.settings = loadGroupSettings(this.groupDir)
  }

  /** 重掷上一条角色发言。 */
  async *roll(): AsyncGenerator<SessionEvent> {
    this.reloadBooks()
    const last = this.store.lastCharacterMessage()
    const persona = last !== undefined ? this.byName.get(last.name) : undefined
    if (last === undefined || persona === undefined) {
      yield { type: 'info', text: '还没有可重掷的角色发言' }
      return
    }
    const files = this.filesFor(last.name)
    const { system, messages } = assembleGroup(
      persona, this.settings,
      this.store.effectiveMessages().filter(m => m.id !== last.id),
      {
        files,
        memoryText: files !== undefined ? buildMemory(this.store, last.name, files.memory) : '',
        userPersona: this.userPersona,
        rules: this.rules,
        presentNames: this.presentNames(),
        remote: this.remoteLinks(),
        overhear: this.overhearLinks(),
        appearances: this.appearanceMap,
      },
    )
    yield { type: 'speaker', name: last.name }
    let full = ''
    for await (const delta of turnFromMessages(system === '' ? messages : [{ role: 'system', content: system }, ...messages], { temperature: 1.0 })) {
      full += delta
      yield { type: 'delta', text: delta }
    }
    full = stripNameEcho(full, last.name)
    if (full.trim() !== '') {
      this.store.rewriteMessage(last.id, full) // 当前上下文快照：日志行就地更新（不再产出 swipe 派生行）
      this.rewriteMemoryFor(last.id) // 活账本：生效文本变了，引用它的记忆条目同步改写
    }
    yield { type: 'reply', name: last.name, text: full, private: last.scope === 'private' }
  }

  /** 用户公开发言：路由 → 角色回复 → 记账。 */
  async *speak(text: string): AsyncGenerator<SessionEvent> {
    await this.drainBg() // 上一轮的后台记账先完成，避免与新一轮写入交错
    this.reloadBooks()
    if (this.characters.length === 0) {
      yield { type: 'info', text: '这个群还没有角色——先在左侧「＋ 新建角色」建一个再说话' }
      return
    }
    // 当前场景先落盘（若尚无记录，以现有配置/全员为准），供总管参考
    const before = this.sceneAccess()
    if (this.store.lastScene() === undefined) this.store.appendPresence(before.present, '初始', before.remote, before.overhear)

    // 可发言者 = 现场者 ∪ 远程接入者（单向偷听者不能插话；仅当可发言者皆空时退回全员，避免剧情卡死）。
    const speakable = new Set(this.speakableNames())
    const speakers = this.roster.filter(c => speakable.has(c.name))
    const routeRoster = speakers.length > 0 ? speakers : this.roster
    // 思考模式下总管判断需数秒~十几秒：先给等待反馈，避免干等黑箱
    yield { type: 'info', text: '总管判断谁接话…' }
    // ── 快路径（SPEC §6.1a）：Jev 一次调用回答"谁接话 + 三层场景名单 + 知情名单 + 转告 + 状态门"。
    // 未配置/调用失败 → undefined；路由不可用（置信不足/名单外）→ picked 置空：路由回退完整总管，
    // 场景/知情/转告/状态门判定照常生效（各自带阈值，不与路由连坐——实测连坐会把准确的进场判定一起扔掉）。
    const recent = this.store.effectiveMessages().slice(-6).map(m => `${m.name}：${m.text}`).join('\n')
    const routerLlm = resolveRouter()
    if (routerLlm === undefined) this.judgeLog({ phase: '主判定', note: '未配置快路径，走完整总管' })
    let quick: import('./host.ts').JevRouteResult | undefined
    if (routerLlm !== undefined) {
      quick = await jevRoute({
        llm: routerLlm,
        roster: routeRoster,
        rosterLines: this.rosterLines.filter((_, i) => routeRoster.some(c => c.name === this.characters[i]?.name)),
        allNames: this.characterNames(),
        present: before.present,
        remote: before.remote,
        overhear: before.overhear,
        presentNotes: this.presentNotes(),
        statusNotes: this.statusNotes(),
        recent,
        userText: text,
        tone: this.settings.tone,
        rules: this.rules,
        timeoutMs: config.jevTimeoutMs,
        log: e => this.judgeLog({ phase: '主判定', ...e }),
      })
    }
    let route: RouteResult | undefined
    let picked: string
    let reason: string
    if (quick !== undefined && quick.picked !== '') {
      picked = quick.picked
      reason = quick.reason
    } else {
      route = await routeNextSpeaker({
        roster: routeRoster,
        rosterLines: this.rosterLines.filter((_, i) => routeRoster.some(c => c.name === this.characters[i]?.name)),
        history: this.store.effectiveMessages(), // 总管 prompt 用删后视图：删除 = 从未发生，对所有人成立
        effectiveHistory: this.store.effectiveMessages(), // 启发式降级看删改后的视图
        pendingUserText: text, // 快路径预检时消息尚未落盘——回退路径靠它补全 prompt 与提及检测
        tone: this.settings.tone,
        rules: this.rules,
        presentNames: before.present,
        presentNotes: this.presentNotes(),
        directorTimeoutMs: config.directorTimeoutMs,
      })
      if (route.picked === '') {
        yield { type: 'info', text: '路由失败：群里没有可用角色' }
        return
      }
      picked = route.picked
      reason = route.reason
      this.judgeLog({
        phase: '总管路由',
        picked: route.picked,
        reason: route.reason,
        fallback: route.fallback,
        ledgerUpdates: route.ledgerUpdates.length,
        presenceUpdates: route.presenceUpdates.length,
      })
    }

    // 用户发言落盘：visible_to = Jev 知情名单（§4.3）——在场感知、经通道感知都算；
    // 通道/单向感知者受各自 since 约束；Jev 不可用时回退"现场 ∩ 感知完整"。
    // 快照在场景修正之前写定：刚进场的人从下一轮起听到，本轮这句仍按旧场景与旧名单。
    const knows = quick?.knows ?? new Set(this.witnesses())
    const audience = this.audienceOf(knows, this.store.nextMsgId)
    const userMsg = this.store.append('user', this.userPersona.name, text, audience, 'public')
    this.backfillAll()

    // 额外记忆（§5.7）：这条发言在向谁转告他原本不知道的事——二段判定后逐字移植。
    // 放在路由与发言之前：接力判到被转告者时，他的记忆必须已就位。
    // userDirty = 状态账本总门（用户发言部分）；缺答案按 true（安全侧）。
    const userDirty = quick?.stateDirty ?? true
    if (quick !== undefined && quick.told.size > 0 && routerLlm !== undefined) {
      yield* this.grantExtraMemory(quick.told, text, routerLlm)
    }

    if (quick !== undefined) {
      // 快路径：三层场景修正此刻落盘（晚于快照——刚进场者听不到刚才那句）
      if (quick.scene !== undefined && !this.sameScene(quick.scene, this.sceneAccess())) {
        const applied = this.normalizeScene(quick.scene)
        this.setScene(applied, 'Jev场景判断')
        yield { type: 'info', text: `场景更新：${sceneSummary(applied)}（Jev）` }
      }
    } else {
      // 回退路径：总管判断的场景人员变动（谁进来/离开/接入/开始偷听）。
      // 名单里的名字经 resolveCharacterName 对号（"甲"↔"角色甲"），写歪的不再被静默丢弃。
      for (const p of route!.presenceUpdates) {
        const resolved = this.resolvePresence(p)
        if (resolved === undefined) continue
        const cur = this.sceneAccess()
        const next: SceneAccess = {
          present: resolved.present,
          remote: resolved.remote ?? cur.remote,
          overhear: resolved.overhear ?? cur.overhear,
        }
        if (this.sameScene(next, this.sceneAccess())) continue
        const applied = this.normalizeScene(next)
        this.setScene(applied, p.reason !== '' ? p.reason : '场景人员变动')
        yield { type: 'info', text: `场景更新：${sceneSummary(applied)}${p.reason !== '' ? `（${p.reason}）` : ''}` }
      }
    }

    // ── 现场所见（§5.8）：本轮有新进现场者（纯代码判定：修正后 present − 轮初 present）→
    // 后台生成现状快照并注入其记忆；接力判到进场者发言时，speakAs 组装前会先等注入完成。
    this.maybeSnapshotEntrants(before.present, '新进现场')

    yield { type: 'route', picked, reason, fallback: route?.fallback ?? false }
    this.store.appendRoute(picked, reason, route?.fallback ?? false)
    // 被选中者必须真的有发言权（现场 ∪ 接入；单向偷听不能插话）：没有就不硬调模型，
    // 提示用户——这一轮只留下用户的消息与路由记录。
    if (!this.speakableNames().includes(picked)) {
      yield { type: 'info', text: `（${picked} 现在无法在此场景发言——用「手动修正」或「对总管说」把他请进场景或建立双向接入，这一轮先没有回应）` }
      // 无回复不代表无变化（如"他倒下了"这类用户发言）：门控通过就照记账（用户消息单独一条）
      if (quick !== undefined && quick.stateDirty) {
        this.enqueueBookkeeper(text, [{ speaker: '', replyText: '' }])
        yield { type: 'info', text: '（本轮记账在后台进行，稍后可在状态账本查看）' }
      }
      return
    }

    // ── 回复与接力（§1.1）：角色发言完毕后，合并判定（jevAfterReply）已顺带回答了接力——
    // 有人接话就继续说，判给用户则发言权交还、本轮结束。
    // 接力判定是 Jev 的能力：未配置/回退路径保持一次回复（fail-open = 旧行为）。
    const replies: Array<{ speaker: string; text: string }> = []
    /** 记账工作列表（快路径）：判定为"可能有状态变化"的用户发言与回复。 */
    const dirtyWork: Array<{ speaker: string; replyText: string }> = []
    let current = picked
    /** 接力累计衰减（§6.1a）：值 = 该角色本轮发言后的累计权重乘数（首次发言记 1）。
     *  每经过一次他未被压 0 的判定乘一次 relayDecay；重新发言不重置——衰减叠加贯穿整轮；
     *  刚发言者的下一次判定硬性压 0，且该次不推进其衰减。 */
    const spokenWeight = new Map<string, number>()
    for (let hops = 0; ; hops++) {
      if (hops > 0) {
        yield { type: 'route', picked: current, reason: '接力', fallback: false }
        this.store.appendRoute(current, '接力', false)
      }
      const r = yield* this.speakAs(current, this.store.effectiveMessages())
      replies.push({ speaker: current, text: r.text })
      if (!spokenWeight.has(current)) spokenWeight.set(current, 1) // 首次发言记 1；再次发言不重置（衰减叠加）
      if (r.text.trim() === '') break // 空回复不再接力、不记账
      // 转告触发：这条回复若在向谁转告他不知道的事，先移植记忆再考虑接力
      if (r.judge !== undefined && r.judge.told.size > 0 && routerLlm !== undefined) {
        yield* this.grantExtraMemory(r.judge.told, r.text, routerLlm)
      }
      if (r.judge === undefined || r.judge.stateDirty) dirtyWork.push({ speaker: current, replyText: r.text })
      if (routerLlm === undefined || route !== undefined) break // 无快路径/回退路径：一次回复（旧行为）
      if (r.judge?.next === undefined || r.judge.next.userTurn) break
      // 接力累计衰减：本次判定先让所有已发言者（除刚发言者）的累计权重乘 relayDecay，再加权取最大者
      // ——刚发言者本次硬性压 0（不可能连续发言）且衰减不推进（"现在是 0.64，又发言了，下一次乘 0，
      // 再下一次是 0.64×0.8"）；未发言者与用户保持原始概率。判定一轮轮过去，已发言者的累计权重
      // 持续衰减、用户永不衰减，最终 argmax 落到用户，发言权交还——接力无硬上限，衰减即退出机制。
      for (const [name, acc] of spokenWeight) {
        if (name !== current) spokenWeight.set(name, acc * config.relayDecay)
      }
      const raw = r.judge.next
      const dist = { ...(raw.probabilities ?? {}) }
      let pickedNext = raw.picked
      if (Object.keys(dist).length > 0) {
        for (const [name, acc] of spokenWeight) {
          if (dist[name] !== undefined) dist[name] *= name === current ? 0 : acc
        }
        const top = Object.entries(dist).sort((a, b) => b[1] - a[1])[0]
        if (top !== undefined && top[1] > 0) pickedNext = top[0] // 全部压成 0 时分布失去区分度，不改判
      }
      // 刚发言者拿不到发言权：分布缺失/全零时 Jev 若仍点名他，同样交还用户
      // （"不可能连续发言"是引擎规则，不由概率决定）。
      if (pickedNext === current) {
        this.judgeLog({
          phase: '接力加权', from: raw.picked, to: '交还用户', dist,
          note: `${pickedNext} 刚发言（权重压 0），不可能连续发言`,
        })
        break
      }
      if (pickedNext !== raw.picked) this.judgeLog({ phase: '接力加权', from: raw.picked, to: pickedNext, dist })
      if (pickedNext === this.userPersona.name || !this.speakableNames().includes(pickedNext)) break
      current = pickedNext
    }

    // ── 记账：回退路径随总管结果即时应用；快路径按记账门控入队后台执行（不拖慢接力、不锁定输入）。
    // 记忆不由总管生成（知情 = Jev 名单 + 原文移植 + 转告移植），后台只记状态账本/场景。
    if (route !== undefined) {
      for (const note of this.recordRouteChanges(route.ledgerUpdates)) {
        yield { type: 'ledger', text: note }
      }
    } else {
      const work = [...(userDirty ? [{ speaker: '', replyText: '' }] : []), ...dirtyWork]
      if (work.length > 0) {
        this.enqueueBookkeeper(text, work)
        yield { type: 'info', text: '（本轮记账在后台进行，稍后可在状态账本查看）' }
      } else {
        this.judgeLog({ phase: '记账', note: '门控判定本轮无持久影响，跳过 DeepSeek 记账' })
      }
    }
    const lastText = replies.at(-1)?.text ?? ''
    if (lastText.trim() === '') yield { type: 'info', text: '（空回复）' }
    this.backfillAll()
  }

  /** 总管/用户给的场景名单 → 对号到本群角色（对不上的名字丢弃）；present 非数组返回 undefined。 */
  private resolvePresence(p: { present: string[]; remote?: RemoteLink[]; overhear?: RemoteLink[]; reason?: string }): { present: string[]; remote?: RemoteLink[]; overhear?: RemoteLink[] } | undefined {
    if (!Array.isArray(p.present)) return undefined
    const present = [...new Set(p.present
      .map(n => resolveCharacterName(this.roster, n))
      .filter((n): n is string => n !== undefined))]
    const pick = (links: RemoteLink[] | undefined): RemoteLink[] | undefined => links === undefined ? undefined : links.flatMap(l => {
      const c = resolveCharacterName(this.roster, l.character)
      return c === undefined ? [] : [{ ...l, character: c }]
    })
    return { present, remote: pick(p.remote), overhear: pick(p.overhear) }
  }

  private async *speakAs(name: string, history: MsgLine[]): AsyncGenerator<SessionEvent, { text: string; msgId?: number; judge?: JevAfterReplyResult }> {
    // 现场所见（§5.8）：新进场者要开口了——先等"现场所见"注入完成，再组装发言（先看见，再发言）。
    const snap = this.sceneSnapshot
    if (snap !== undefined && snap.targets.has(name)) {
      yield { type: 'info', text: `（${name} 环顾四周……）` }
      await snap.done
    }
    const persona = this.byName.get(name)
    const files = this.filesFor(name)
    if (persona === undefined || files === undefined) {
      yield { type: 'info', text: `未知角色: ${name}` }
      return { text: '' }
    }
    const { system, messages } = assembleGroup(persona, this.settings, history, {
      files,
      memoryText: buildMemory(this.store, name, files.memory),
      userPersona: this.userPersona,
      rules: this.rules,
      presentNames: this.presentNames(),
      remote: this.remoteLinks(),
      overhear: this.overhearLinks(),
      appearances: this.appearanceMap,
    })
    if (messages.length === 0) {
      // 视野内没有任何可说的话（如失聪者被兜底选中）：不调模型，按空回复处理
      yield { type: 'info', text: '（空回复）' }
      return { text: '' }
    }
    yield { type: 'speaker', name }
    let full = ''
    for await (const delta of turnFromMessages(system === '' ? messages : [{ role: 'system', content: system }, ...messages])) {
      full += delta
      yield { type: 'delta', text: delta }
    }
    full = stripNameEcho(full, name)
    let msgId: number | undefined
    let judge: JevAfterReplyResult | undefined
    if (full.trim() !== '') {
      // 回复后的合并判定（一次 Jev 调用）：知情名单（决定本条 visible_to，出生即定）+
      // 记账总门 + 转告触发 + 接力。发言者永远看得到自己的话；判定失败回退确定性保底
      // （现场 ∩ 感知完整），其余部分由调用方按 undefined 各自走安全侧。
      const candidates = this.characters.map(c => c.name).filter(n => n !== name)
      const routerLlm = resolveRouter()
      const speakable = this.speakableNames()
      judge = routerLlm !== undefined
        ? await jevAfterReply({
            llm: routerLlm,
            speaker: name,
            replyText: full,
            candidates,
            roster: speakable.map(n => ({ name: n })),
            rosterLines: this.rosterLinesFor(speakable),
            userName: this.userPersona.name,
            statusNotes: this.statusNotes(),
            presentNotes: this.presentNotes(),
            recent: this.store.effectiveMessages().slice(-8).map(m => `${m.name}：${m.text}`).join('\n'),
            tone: this.settings.tone,
            rules: this.rules,
            timeoutMs: config.jevTimeoutMs,
            log: e => this.judgeLog({ phase: '回复判定', ...e }),
          })
        : undefined
      const base = judge?.audience ?? new Set(this.witnesses(name))
      const msgIdForReply = this.store.nextMsgId
      const listeners = [name, ...this.audienceOf(base, msgIdForReply, name)]
      msgId = this.store.append('character', name, full, listeners, 'public').id
    }
    yield { type: 'reply', name, text: full, private: false }
    return { text: full, ...(msgId === undefined ? {} : { msgId }), ...(judge === undefined ? {} : { judge }) }
  }

  /**
   * 记账落盘（SPEC §5.4）：状态账本（整体快照）+ 知情补记（仅纠正窗口）。
   * 快照语义：给定字段覆盖账本对应字段（缺省字段保持），落一行 status 快照 ledger 行（含合并后的完整账本），
   * 再持久化状态.yaml——先事实源后派生缓存。
   */
  private recordRouteChanges(
    ledgerUpdates: Array<{ character: string; fields: import('./status.ts').LedgerFields }>,
    appends: Array<{ character: string; source: string; entry: string }> = [],
  ): string[] {
    const notes: string[] = []
    for (const u of ledgerUpdates) {
      const f = this.filesFor(u.character)
      if (f === undefined) continue
      const changed: string[] = []
      for (const [k, v] of Object.entries(u.fields)) {
        const nv = (v as string).trim()
        if (f.status[k] === nv) continue
        f.status[k] = nv
        changed.push(k)
      }
      if (changed.length === 0) continue
      this.store.appendLedgerLine(u.character, 'status', 'set', JSON.stringify(f.status))
      this.persistFiles(u.character)
      notes.push(`${u.character} 状态账本已更新（${changed.join('、')}）`)
    }
    for (const a of appends) {
      const f = this.filesFor(a.character)
      if (f === undefined) continue
      const entry = { source: a.source, round: this.store.round, text: a.entry }
      f.memory.push(entry)
      this.store.appendLedgerLine(a.character, 'knowledge', 'append', JSON.stringify(entry))
      this.persistFiles(a.character)
      notes.push(`${a.character} 知情 +1（用户指定）`)
    }
    return notes
  }

  private filesFor(name: string): CharacterFiles | undefined {
    const persona = this.byName.get(name)
    if (persona === undefined) return undefined
    let files = this.books.get(name)
    if (files === undefined) {
      files = loadFiles(join(this.groupDir, '角色', persona.dirName))
      // 旧格式迁移：性格/关系原写在 角色.md，种入各自的文件，随首次落盘完成搬家。
      if (files.personality.base === '' && persona.personalityFallback !== '') files.personality.base = persona.personalityFallback
      if (files.relationships.base === '' && files.relationships.entries.length === 0 && persona.relationshipsFallback !== '') {
        files.relationships.base = persona.relationshipsFallback
      }
      this.books.set(name, files)
    }
    return files
  }

  /** 刷新该角色的四个可变文件（角色.md 永不写入）。 */
  private persistFiles(name: string): void {
    const f = this.books.get(name)
    const dir = this.charDir(name)
    if (f === undefined || dir === undefined) return
    saveStatus(dir, f.status)
    savePersonality(dir, f.personality)
    saveRelationships(dir, f.relationships)
    saveMemory(dir, f.memory)
  }

  /** 该角色被用户手动撤回过的消息 mid（撤回后不得被自动登记复现）。 */
  private suppressedMids(name: string): Set<number> {    const out = new Set<number>()
    for (const l of this.store.allLines) {
      if (l.type !== 'ledger' || this.store.nameOf(l.character) !== name || l.section !== 'knowledge' || l.op !== 'retract') continue
      try {
        const q = JSON.parse(l.content) as { mid?: number }
        if (typeof q.mid === 'number') out.add(q.mid)
      } catch { /* 坏行忽略 */ }
    }
    return out
  }

  // ---------- 手动改上下文（当前上下文快照语义） ----------

  /** 手改某条消息的文本（物理改写：日志行就地更新，原文不留痕）；
   *  所有能看到它的角色下一轮即按新文本理解，引用它的记忆条目同步改写（活账本）。 */
  editMessage(id: number, text: string): void {
    if (!this.store.messages.some(m => m.id === id)) throw new Error(`消息不存在: #${id}`)
    if (text.trim() === '') throw new Error('文本不能为空（要删除请用删除操作）')
    this.store.rewriteMessage(id, text)
    this.rewriteMemoryFor(id) // 活账本：记忆是跟着修改更新的活视图，不冻结旧文本
  }

  /** 手删某条消息（物理移除：消息行与其账本移植行一并从日志消失，删除 = 这条消息从没发生过）；
   *  所有角色的记忆同步清除（文件直改），mid 因 header.lastMsgId 保证永不复用。 */
  deleteMessage(id: number): void {
    if (!this.store.messages.some(m => m.id === id)) throw new Error(`消息不存在: #${id}`)
    this.store.removeMessage(id)
    this.retractMemoryFor(id)
  }

  /** 账本行 content 里的 mid（坏行/无 mid 返回 undefined）。 */
  private midOf(content: string): number | undefined {
    try {
      const q = JSON.parse(content) as { mid?: number }
      return typeof q.mid === 'number' ? q.mid : undefined
    } catch { return undefined }
  }

  /** 撤回所有角色账本中引用消息 mid 的条目（删除消息时同步清理记忆与账本行）。 */
  private retractMemoryFor(id: number): void {
    // 账本行物理移除：删除 = 从没发生过，账本行里的原文也不留痕（当前上下文快照语义）。
    // 不追加 retract 行——消息行已不存在且 id 永不复用，回填无从复活。
    this.store.removeLedgerRows(l => l.section === 'knowledge' && l.op === 'append' && this.midOf(l.content) === id)
    for (const c of this.characters) {
      const f = this.filesFor(c.name)
      if (f === undefined) continue
      if (!f.memory.some(e => e.mid === id)) continue
      f.memory = f.memory.filter(e => e.mid !== id)
      this.persistFiles(c.name)
    }
  }

  /** 查看某角色的记忆条目（索引用于撤回）。 */
  memoryOf(name: string): Array<{ index: number; source: string; round: number; mid?: number; text: string }> {
    const f = this.filesFor(name)
    if (f === undefined) throw new Error(`未知角色: ${name}`)
    return f.memory.map((e, index) => ({ index, source: e.source, round: e.round, ...(e.mid === undefined ? {} : { mid: e.mid }), text: e.text }))
  }

  /** 手动给某角色补一条记忆（只影响该角色）。 */
  addMemory(name: string, text: string): void {
    const f = this.filesFor(name)
    if (f === undefined) throw new Error(`未知角色: ${name}`)
    if (text.trim() === '') throw new Error('记忆内容不能为空')
    const entry = { source: '用户指定', round: this.store.round, text: text.trim() }
    f.memory.push(entry)
    this.store.appendLedgerLine(name, 'knowledge', 'append', JSON.stringify(entry))
    this.persistFiles(name)
  }

  /** 手动撤回某角色的某条记忆（只影响该角色；若该条来自某消息，该消息不再自动登记）。 */
  retractMemory(name: string, index: number): void {
    const f = this.filesFor(name)
    if (f === undefined) throw new Error(`未知角色: ${name}`)
    const entry = f.memory[index]
    if (entry === undefined) throw new Error(`记忆条目不存在: #${index}`)
    const query = entry.mid === undefined ? { text: entry.text } : { mid: entry.mid, text: entry.text }
    this.store.appendLedgerLine(name, 'knowledge', 'retract', JSON.stringify(query))
    const removed = entry
    f.memory.splice(index, 1)
    if (removed.mid === undefined) {
      // 顺手把同文本的其它重复条目也撤掉（避免只删一条、下次回填又冒出来）
      f.memory = f.memory.filter(e => e.text !== removed.text)
    }
    this.persistFiles(name)
  }

  /**
   * 活账本：某条消息的生效文本变了（手改/重掷），把引用它的记忆条目同步改写成新原文。
   * 账本行**物理改写**（当前上下文快照语义：旧原文从日志消失），记忆文件同步更新；
   * 被用户撤回过的 mid 不趁机复活。
   */
  private rewriteMemoryFor(id: number): void {
    // 用可见视图取生效文本（物理改写后 msg 行即生效文本；旧版派生行同样被 rewriteMessage 清掉）
    const msg = this.store.effectiveMessages().find(m => m.id === id)
    if (msg === undefined) return
    for (const c of this.characters) {
      const f = this.filesFor(c.name)
      if (f === undefined || this.suppressedMids(c.name).has(id)) continue
      const hit = f.memory.find(e => e.mid === id)
      if (hit === undefined) continue
      const text = witnessSummary(msg, c.name)
      const name = c.name
      this.store.rewriteLedgerRows(
        l => this.store.nameOf(l.character) === name && l.section === 'knowledge' && l.op === 'append' && this.midOf(l.content) === id,
        content => {
          const o = JSON.parse(content) as { text?: string }
          o.text = text
          return JSON.stringify(o)
        },
      )
      hit.text = text
      this.persistFiles(c.name)
    }
  }

  /**
   * 纠正窗口（§3.12）：用户在戏外直接跟总管说话。
   * 总管可回应用户并落实修正（在场/状态/知情增删/性格/关系）；
   * 这段对话以 director 行落盘，**不进任何角色的可见视图**（effectiveMessages 只含 msg 行）。
   */
  async correct(text: string): Promise<{ reply: string; applied: string[] }> {
    await this.drainBg()
    this.reloadBooks()
    if (text.trim() === '') throw new Error('内容不能为空')
    const recent = this.store.effectiveMessages().slice(-8).map(m => `${m.name}：${m.text}`).join('\n')
    const result = await askDirector({
      rosterLines: this.rosterLines,
      presentNotes: this.presentNotes(),
      ledgers: this.ledgerLines(),
      settings: this.settings,
      recent,
      rules: this.rules,
      text: text.trim(),
      timeoutMs: Math.max(config.directorTimeoutMs, 60000),
    })

    const applied: string[] = []
    for (const p of result.presence) {
      const resolved = this.resolvePresence(p)
      if (resolved === undefined) continue
      const cur = this.sceneAccess()
      const next = this.normalizeScene({
        present: resolved.present,
        remote: resolved.remote ?? cur.remote,
        overhear: resolved.overhear ?? cur.overhear,
      })
      this.setScene(next, p.reason)
      applied.push(`场景 → ${sceneSummary(next)}`)
    }
    for (const r of result.retracts) {
      const n = this.retractKnowledge(r.character, r)
      if (n > 0) applied.push(`${r.character} 记忆 -${n} 条`)
    }
    // 记账摘要直接取 recordRouteChanges 的返回（只列真正落账的项：状态账本快照 + 用户要求的补记）
    applied.push(...this.recordRouteChanges(result.ledgerUpdates, result.appends))

    this.store.appendDirector(text.trim(), result.reply, applied)
    this.judgeLog({ phase: '纠正', reply: result.reply, applied })
    return { reply: result.reply, applied }
  }

  /** 戏外对话历史（回看用）。 */
  directorHistory(): Array<{ text: string; reply: string; applied: string[]; ts: string }> {
    return this.store.directorHistory().map(l => ({ text: l.text, reply: l.reply, applied: l.applied, ts: l.ts }))
  }

  /**
   * 按 mid 或文本撤回某角色的记忆，返回撤回条数。
   * 匹配用包含（模型常转述、写不全等文本）；但**每个命中条目单独落一行 ledger**
   * （有 mid 记 mid、无 mid 记全等文本）——重放与增量完全一致，且所有 mid 都进 suppressed
   * 集合，被撤回的亲历条目不会因回填而复活。
   */
  retractKnowledge(name: string, query: { mid?: number; text?: string }): number {
    const f = this.filesFor(name)
    if (f === undefined) throw new Error(`未知角色: ${name}`)
    const hits = f.memory.filter(e =>
      (query.mid !== undefined && e.mid === query.mid) || (query.text !== undefined && query.text !== '' && e.text.includes(query.text)),
    )
    if (hits.length === 0) return 0
    for (const hit of hits) {
      this.store.appendLedgerLine(name, 'knowledge', 'retract',
        JSON.stringify(hit.mid === undefined ? { text: hit.text } : { mid: hit.mid }))
    }
    f.memory = f.memory.filter(e => !hits.includes(e))
    this.persistFiles(name)
    return hits.length
  }

  private backfillAll(): void {
    // 存量治愈：引用"已不存在的消息"的记忆条目统一清掉——旧版 delete 行的 target，
    // 以及物理删除（当前上下文快照语义）后从日志消失的 mid。
    // （ledger retract + suppressed 双保险：残留条目消失，且永远不会因回填复活）
    const deletedIds = this.store.deletedMsgIds()
    const existingIds = new Set(this.store.messages.map(m => m.id))
    const isGone = (mid: number): boolean => deletedIds.has(mid) || !existingIds.has(mid)
    for (const c of this.characters) {
      const f = this.filesFor(c.name)
      if (f === undefined) continue
      const stale = f.memory.filter(e => e.mid !== undefined && isGone(e.mid))
      if (stale.length === 0) continue
      for (const e of stale) {
        this.store.appendLedgerLine(c.name, 'knowledge', 'retract', JSON.stringify({ mid: e.mid }))
      }
      f.memory = f.memory.filter(e => !(e.mid !== undefined && isGone(e.mid)))
      this.persistFiles(c.name)
    }
    for (const c of this.characters) {
      const f = this.filesFor(c.name)
      if (f === undefined) continue
      const added = backfillKnowledge(this.store, c.name, f.memory, this.suppressedMids(c.name))
      for (const e of added) {
        this.store.appendLedgerLine(c.name, 'knowledge', 'append', JSON.stringify({
          source: e.source,
          ...(e.mid === undefined ? {} : { mid: e.mid }),
          round: e.round,
          text: e.text,
        }))
      }
      if (added.length > 0) this.persistFiles(c.name)
    }
  }
}

function stripNameEcho(text: string, name: string): string {
  let out = text.trimStart()
  // 模型偶发复读自己的名字——剥掉，防 UI 双前缀
  for (const colon of ['：', ':']) {
    if (out.startsWith(name + colon)) out = out.slice(name.length + 1).trimStart()
  }
  return out
}

/** 一句话描述场景人员（现场 + 接入 + 单向感知），用于事件与日志摘要。 */
export function sceneSummary(scene: SceneAccess): string {
  const present = scene.present.length > 0 ? scene.present.join('、') : '（无）'
  const remote = scene.remote.map(l => `${l.character}（${l.note ?? '远程'}）`).join('、')
  const overhear = scene.overhear.map(l => `${l.character}（${l.note ?? '单向感知'}）`).join('、')
  return [
    `现场 ${present}`,
    remote === '' ? '' : `接入 ${remote}`,
    overhear === '' ? '' : `感知 ${overhear}`,
  ].filter(s => s !== '').join('｜')
}

/** 列出 groups/ 下可用群聊。 */
export function listGroups(): string[] {
  if (!existsSync(config.groupsDir)) return []
  return readdirSync(config.groupsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && hasGroupSettings(join(config.groupsDir, d.name)))
    .map(d => d.name)
}
