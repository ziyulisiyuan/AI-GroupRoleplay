/**
 * 群聊 Host（SPEC §4.2 / §4.1）：
 * - assembleGroup：角色每轮输入组装（只读角色.md + 性格.md(含演变) + 状态.md + 记忆注入 + 群设定 + 最近12条）
 * - routeNextSpeaker：总管一次 tool-call（≤2k 增量输入），超时/失败→启发式降级
 */
import { chatToolCall, type ToolSpec } from '../llm/deepseek.ts'
import { jevDecide } from '../llm/jev.ts'
import { resolveLlm } from '../settings.ts'
import { config } from '../config.ts'
import type { CharacterPersona, GroupSettings, UserPersona } from './persona.ts'
import { detectMention, dicePick, resolveCharacterName, type RoutableCharacter } from './router.ts'
import type { MsgLine } from '../store.ts'
import { roleplayInstruction } from '../host.ts'
import { ledgerPrompt, personalityPrompt, relationshipsPrompt, pickLedgerFields, type CharacterFiles } from './status.ts'
import { parseRemoteList, type RemoteLink } from './presence.ts'

/** assembleGroup 的可选输入（避免位置参数越堆越长）。 */
export interface AssembleInput {
  /** 在场其他角色的外观层（名字 → 角色.md 外观）。只开放外观；身份/背景/性格/状态账本不可见。 */
  appearances?: Record<string, string>
  files?: CharacterFiles
  /** §4.2 #4：由 buildMemory 产出的记忆注入片段 */
  memoryText?: string
  /** §3.1.1：用户自己的设定 */
  userPersona?: UserPersona
  /** §3.1.2：工作区根目录 规则.md 的正文（用户自写的约束词；空 = 不注入） */
  rules?: string
  /** §3.11：当前现场者（含角色自己），让角色知道屋里有谁 */
  presentNames?: string[]
  /** §3.11：不在现场、但当下双向连通的角色 */
  remote?: RemoteLink[]
  /** §3.11：单向感知者（**只用于识别"自己是否在单向感知"**——现场角色的场景段不显示他们，
   *  被感知者不该知道有人在听；不给别人看是本模块的职责边界）。 */
  overhear?: RemoteLink[]
  /** 地图（全部场景，名+描述全文）：地图群每轮全量注入。 */
  scenes?: Array<{ name: string; description: string }>
  /** 当前场景名（地图群）。 */
  activeScene?: string
}

/** 组装角色输入（§4.2 #1-#4+#6；#2.5 用户设定；#5.5 全局规则）。 */
export function assembleGroup(
  persona: CharacterPersona,
  settings: GroupSettings,
  history: MsgLine[],
  input: AssembleInput = {},
): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const { files, memoryText = '', userPersona, rules = '', presentNames, remote = [], overhear = [], appearances, scenes, activeScene } = input
  const personality = files !== undefined ? personalityPrompt(files.personality) : ''
  const relationships = files !== undefined ? relationshipsPrompt(files.relationships) : ''

  const fields = [
    persona.appearance !== '' ? `外貌：${persona.appearance}` : '',
    persona.body !== '' ? persona.body : '',
    personality !== '' ? personality : '',
    relationships !== '' ? `【人物关系】\n${relationships}` : '',
  ].filter(s => s !== '')
  const status = files !== undefined ? ledgerPrompt(files.status) : ''
  // 用户设定：每个角色都该知道你是谁（称呼 + 你写的自述）
  const user = userPersona !== undefined && (userPersona.text !== '' || userPersona.name !== '你')
    ? `【和你对话的人】\n称呼：${userPersona.name}${userPersona.text !== '' ? `\n${userPersona.text}` : ''}`
    : ''
  const world = [
    settings.era !== '' ? `【时代背景】${settings.era}` : '',
    settings.world !== '' ? `【世界观】${settings.world}` : '',
  ].filter(s => s !== '')
  // 地图（§4）：世界由这些场景构成，全部内容每轮注入——空间对角色不再是脑补
  const mapSection = scenes !== undefined && scenes.length > 0
    ? [
        '【场景（这个世界的地点，你就在其中之一）】',
        `当前场景：${activeScene ?? '（未定）'}`,
        ...scenes.map(s => `- ${s.name}：${s.description}`),
      ].join('\n')
    : ''
  const rulesSection = rules.trim() !== '' ? `【规则（用户设定）】\n${rules.trim()}` : ''
  // 当前场景人员：让角色知道屋里有谁（避免出现"某某还在外面"这种与自己视野矛盾的台词），
  // 以及谁不在现场、只通过通道接入（通道传到什么他才知道什么，不能越通道行动或感知）。
  // 单向感知层只用于识别"自己是不是在单向感知"——现场角色的场景段**不显示**偷听者（被感知者不该知道）。
  const selfLink = remote.find(l => l.character === persona.name) ?? overhear.find(l => l.character === persona.name)
  const others = (presentNames ?? []).filter(n => n !== persona.name && n !== selfLink?.character)
  const remoteOthers = remote.filter(l => l.character !== persona.name)
  // 外观层（§6.2）：只开放 角色.md 外观；对话一直在进行却不知道对方长什么样不符合现实。
  // 身份/背景/性格/状态账本（生理变化）不可见——生理变化靠上下文自行推断。
  const appearanceLine = appearances !== undefined && others.length > 0
    ? `在场者外观：${others.map(n => `${n}：${appearances[n]?.trim() || '（未描述）'}`).join('；')}`
    : ''
  const sceneLines = [
    '【当前场景】',
    activeScene !== undefined ? `地点：${activeScene}` : '',
    `现场：${persona.name}（你）${others.length > 0 ? `、${others.join('、')}` : ''}`,
    appearanceLine,
    remoteOthers.length > 0
      ? `通道接入：${remoteOthers.map(l => `${l.character}（${l.note ?? '远程'}·${l.perceive === '语音' ? '只有声音' : '声音和画面'}）`).join('、')}`
      : '',
    selfLink !== undefined
      ? `你不在现场：你通过「${selfLink.note ?? '远程'}」感知那里，${selfLink.perceive === '语音' ? '只能听到那里的声音，看不到画面' : '能听到那里的声音、看到那里传来的画面'}。你无法直接触碰那里的东西。你能感知到的内容按发生顺序在对话里；你长期记得什么以你的记忆为准。${remote.some(l => l.character === persona.name) ? '' : '你只能感知、无法与那里的人实时互动。'}`
      : '',
    '只有现场的人能直接看到这里发生的一切；通道接入者只感知其通道传到的部分；这些人之外的角色不知道这里发生了什么。',
  ].filter(s => s !== '')
  const presenceSection = presentNames === undefined ? '' : sceneLines.join('\n')
  const system = [
    `你扮演「${persona.name}」。`,
    ...fields,
    status !== '' ? status : '',
    presenceSection,
    user !== '' ? user : '',
    memoryText !== '' ? memoryText : '',
    ...world,
    mapSection !== '' ? mapSection : '',
    rulesSection,
    roleplayInstruction(persona.name),
  ].filter(s => s !== '').join('\n')

  // 可见性过滤（§4.3）：私聊消息对其他角色不可见——物理上看不到，而非"假装没看到"。
  // 只注入最近 12 条可见消息（§6.2 消息窗口）：更早的内容由记忆注入承担，上下文不随剧情无限膨胀。
  const visibleHistory = history.filter(m =>
    m.name === persona.name && m.role === 'character' ? true : (m.visible_to === 'all' || m.visible_to.includes(persona.name)),
  ).slice(-config.contextWindow)
  const mapped = visibleHistory.map(m => ({
    role: (m.name === persona.name && m.role === 'character' ? 'assistant' : 'user') as 'user' | 'assistant',
    content: m.name === persona.name && m.role === 'character' ? m.text : `${m.name}：${m.text}`,
  }))
  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of mapped) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.role === m.role) last.content += `\n${m.content}`
    else merged.push({ ...m })
  }
  return { system, messages: merged }
}

/** route_and_remember 工具 schema（SPEC §6.1c）。 */
const PRESENCE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    scene: { type: 'string', description: '当前所在场景名（地图群）：用户这段剧情移动到了哪个场景；没有移动就不要填' },
    present: { type: 'array', items: { type: 'string' }, description: '当前**在现场**的完整角色名列表' },
    remote: {
      type: 'array',
      description: '当前**不在现场、但能感知并能实时互动**的角色（双向接入：电话/视频/传音等任何手段）。省略此字段 = 接入情况不变；传空数组 = 接入全部结束。',
      items: {
        type: 'object',
        properties: {
          character: { type: 'string' },
          perceive: { type: 'string', enum: ['语音', '视听'], description: '他能感知到什么：语音=只有声音；视听=声音和画面' },
          note: { type: 'string', description: '这个通道是什么，≤10字' },
        },
        required: ['character', 'perceive'],
      },
    },
    overhear: {
      type: 'array',
      description: '当前**单向感知**本场景的角色（能知道这里发生的事、但场景里的人无法与他实时互动、也不知道他在听：偷听/监控/隔墙有耳等）。省略 = 不变；空数组 = 全部结束。',
      items: {
        type: 'object',
        properties: {
          character: { type: 'string' },
          perceive: { type: 'string', enum: ['语音', '视听'], description: '他能感知到什么：语音=只有声音；视听=声音和画面' },
          note: { type: 'string', description: '感知途径，≤10字' },
        },
        required: ['character', 'perceive'],
      },
    },
    reason: { type: 'string', description: '≤20字，说明变化' },
  },
  required: ['present'],
} as Record<string, unknown>

/** 状态账本的 items schema（ROUTE/BOOKKEEP/CORRECTION 三工具共用；整体快照语义：没变化的字段原样带回）。 */
const LEDGER_ITEM_SCHEMA = {
  type: 'object',
    description: '状态账本是**客观骨架**，不是描写：只写事实要点，短语式。禁止形容词渲染、文学性描写、比喻、心理独白——账本写得过于丰满，角色会在台词里反复复读这些句子。所有字段一律只写可观察的事实要点与强度词。',
  properties: {
    character: { type: 'string' },
    生理状态: { type: 'string', description: '身体/伤势/体力/感官等客观要点（短语式，无形容词渲染）' },
    心理状态: { type: 'string', description: '情绪/欲望/恐惧/对他人态度等客观要点（短语式）' },
    外观状态: { type: 'string', description: '衣着/仪容/身上可见的变化（血迹、湿透、整齐…客观要点）' },
    位置状态: { type: 'string', description: '此刻所在的具体位置与姿态（客观）' },
    性格演变: { type: 'string', description: '性格相对初始设定的当前偏差（持久转变，不写一时情绪）' },
    姓名变化: { type: 'string', description: '"无"，或变化后的称谓（化名/尊称——只影响台词里的自称与被称，档案名不变）' },
    人物关系变化: { type: 'string', description: '当前对各人的关系概览（对某人：…），客观要点' },
  },
  required: ['character'],
} as Record<string, unknown>

export const ROUTE_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'route_and_remember',
    description: '决定下一位发言的角色，并记录本轮剧情造成的状态/知情/性格变化',
    parameters: {
      type: 'object',
      properties: {
        next_speaker: { type: 'string', description: '角色名，必须来自可选名单' },
        reason: { type: 'string', description: '≤20字' },
        状态账本: {
          type: 'array',
          description: '对发生状态变化的角色，输出其**完整最新状态账本**（整体快照，不是增量）：输入里给了各角色当前账本，没变化的字段原样带回，变化的字段写新值；没有角色发生变化就不要填。',
          items: { ...LEDGER_ITEM_SCHEMA },
        },
        presence_updates: {
          type: 'array',
          description: '代管维护"当前场景人员"（硬约束：决定谁能在这里发言、谁会被自动登记这里发生的事）。**极其严苛，两条铁律**：名单里不在场的角色，只有对话**明确描写他进场/出现/被叫到现场**才能加入；名单里在场的角色，只有对话**明确描写他失去意识或离开**才能移出。"他住在这里""他可能在附近""他是这里的人"这类推测一律不算。有明确描写才给出修正后的完整名单；没有就不要填此字段。',
          items: { ...PRESENCE_ITEM_SCHEMA },
        },
      },
      required: ['next_speaker', 'reason'],
    },
  },
}

export interface RouteResult {
  picked: string
  reason: string
  fallback: boolean
  /** 状态账本整体快照更新（每元素 = 一个角色的最新账本；缺省字段 = 保持原值）。 */
  ledgerUpdates: Array<{ character: string; fields: import('./status.ts').LedgerFields }>
  /** 知情追加（仅纠正窗口使用；路由/记账路径恒为空）。 */
  appends: Array<{ character: string; source: string; entry: string }>
  /** 场景人员变化（总管从剧情判断；空 = 无人进出/接入）。remote 省略 = 接入情况不变。 */
  presenceUpdates: Array<{ present: string[]; remote?: RemoteLink[]; reason: string }>
}

/**
 * 总管工具返回里的记账 + 场景修正（逐项类型过滤；快/慢路径共用同一解析）。
 * **记忆不由总管生成**：知情 = Jev 判定名单 + 代码原文移植（SPEC §5），工具与解析均无记忆字段。
 * 状态为单一"状态账本"整体快照（§3.4）。
 */
function parseBookkeeping(args: {
  [k: string]: unknown
}): Pick<RouteResult, 'ledgerUpdates' | 'presenceUpdates'> {
  return {
    ledgerUpdates: asArray<Record<string, unknown>>(args['状态账本'])
      .flatMap(u => {
        const character = typeof u.character === 'string' ? u.character.trim() : ''
        if (character === '') return []
        const fields = pickLedgerFields(u)
        return Object.keys(fields).length === 0 ? [] : [{ character, fields }]
      }),
    presenceUpdates: asArray<{ present?: unknown; remote?: unknown; overhear?: unknown; reason?: string }>(args.presence_updates)
      .flatMap(p => {
        if (!Array.isArray(p.present)) return []
        const names = p.present.map(String).map(s => s.trim()).filter(s => s !== '')
        const remote = parseRemoteList(p.remote)
        const overhear = parseRemoteList(p.overhear)
        return [{ present: names, ...(remote === undefined ? {} : { remote }), ...(overhear === undefined ? {} : { overhear }), reason: String(p.reason ?? '') }]
      }),
  }
}

export interface RouteInput {
  roster: RoutableCharacter[]
  /** 每个角色一行的人物速览（供总管判断，不计入其上下文）。 */
  rosterLines: string[]
  history: MsgLine[]
  /** 删改后的可见视图：启发式降级（禁连说/提及检测）基于它判断（§3.2）；缺省回落 history。 */
  effectiveHistory?: MsgLine[]
  /** 本轮用户发言原文（快路径预检时消息尚未落盘——回退路径的 prompt 与提及检测靠它补全）。 */
  pendingUserText?: string
  tone: string
  /** §3.1.2：全局规则（用户自写约束词；空 = 不注入） */
  rules?: string
  /** §3.11：明确在场者（不在场的角色不知道本场景发生的事） */
  presentNames?: string[]
  /** §3.11：在场者及其感知情况（如"角色乙（失聪）"），供总管判断谁能知道 */
  presentNotes?: string[]
  directorTimeoutMs?: number
}

/**
 * 总管路由：LLM tool-call；失败/超时/非法人名 → 启发式降级（SPEC §4.1）。
 * 总管是唯一可读全量日志的 AI：prompt 的"最近对话"用原始 history（掌控全局）；
 * 启发式降级是纯代码判断，用删改后的可见视图（拿被删消息做判断只会出错）。
 */
export async function routeNextSpeaker(input: RouteInput): Promise<RouteResult> {
  const effHistory = input.effectiveHistory ?? input.history
  const lastSpeaker = [...effHistory].reverse().find(m => m.role === 'character')?.name
  const lastUser = input.pendingUserText ?? [...effHistory].reverse().find(m => m.role === 'user')?.text ?? ''
  const fallback = (reason: string): RouteResult => {
    const picked = heuristicRosterPick(input.roster, lastUser, lastSpeaker)
    return { picked, reason: `${reason}（降级）`, fallback: true, ledgerUpdates: [], appends: [], presenceUpdates: [] }
  }
  const empty: RouteResult = { picked: '', reason: '无角色', fallback: true, ledgerUpdates: [], appends: [], presenceUpdates: [] }
  if (input.roster.length === 0) return empty

  const recent = [
    ...(input.pendingUserText !== undefined ? [`你：${input.pendingUserText}`] : []),
    ...input.history.slice(-6).map(m => `${m.name}：${m.text}`),
  ].slice(-6).map(l => l).join('\n')
  const prompt = [
    '你是群聊总管。判断用户这段话之后，下一位该由谁发言，并记录本轮造成的持久变化。',
    '可发言角色（只有他们能在本场景说话：现场者，以及通道接入者；两者之外的人不能发言）：',
    ...input.rosterLines.map(l => `- ${l}`),
    input.presentNames !== undefined
      ? `[当前场景人员（你的代管记录——判定模型不可用，由你代为维护）]\n${(input.presentNotes ?? input.presentNames).join('、') || '（无）'}\n`
        + '**代管规则（极其严苛，两条铁律）**：名单里不在场的角色，只有对话**明确描写他进场/出现/被叫到现场**才能加入；名单里在场的角色，只有对话**明确描写他失去意识或离开**才能移出。"他住这里""可能在附近""他是这里的人"这类推测一律不算——有明确描写才用 presence_updates 给出修正后的完整名单，没有就不动这份名单。它决定谁能在这里发言、谁会被自动登记这里发生的事。\n'
        + '用户这段剧情移动到了某个场景（场景名给出时），用 scene 字段给出该场景名，present 为移动后在场的人。'
      : '',
    input.tone !== '' ? `[群聊基调]\n${input.tone}` : '',
    input.rules !== undefined && input.rules.trim() !== '' ? `[规则（用户设定）]\n${input.rules.trim()}` : '',
    '[最近对话]',
    recent,
    '若是用户直接点名/对某人说话，优先派该角色（在场者优先）；私下发生的事不要在公开场合续接。',
    '调用 route_and_remember 工具给出 next_speaker 与 reason（不要只输出文字）。',
  ].filter(s => s !== '').join('\n')

  try {
    const call = await chatToolCall(resolveLlm(), {
      messages: [
        { role: 'system', content: '你是群聊叙事总管。' },
        { role: 'user', content: prompt },
      ],
      tools: [ROUTE_TOOL],
      expectedFunction: 'route_and_remember',
      signal: AbortSignal.timeout(input.directorTimeoutMs ?? 30000),
    })
    const args = JSON.parse(call.arguments) as {
      next_speaker?: string
      reason?: string
      状态账本?: unknown
      presence_updates?: unknown
    }
    const picked = resolveCharacterName(input.roster, args.next_speaker ?? '')
    if (picked === undefined) return fallback(`总管给了名单外的人(${args.next_speaker ?? '空'})`)
    return {
      picked,
      reason: args.reason ?? '',
      fallback: false,
      appends: [], // 记忆不由总管生成（知情 = Jev 名单 + 原文移植）
      ...parseBookkeeping(args),
    }
  } catch (e) {
    // 路由失败降级（不打断剧情）；排查时设 DSH_DEBUG=1 看真实原因
    if (process.env.DSH_DEBUG === '1') console.error('[route] 总管调用失败:', e)
    return fallback('总管超时或出错')
  }
}

function heuristicRosterPick(
  roster: RoutableCharacter[],
  lastUserText: string,
  lastSpeaker: string | undefined,
): string {
  const mentioned = detectMention(roster, lastUserText)
  if (mentioned !== undefined) return mentioned
  return dicePick(roster, lastSpeaker) ?? roster[0].name
}

/**
 * 工具参数里的"数组字段"模型偶尔只写一个对象（schema 是数组也照写对象）——统一收成数组。
 * 不这么收的话整轮会抛异常并静默降级成启发式路由。
 */
function asArray<T>(value: unknown): T[] {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]) as T[]
}

// ---------- 快路径：Jev 结构化判断（SPEC §6.1a） ----------

/**
 * 快路径判定阈值——全部语义抽象化（不列举手段、不做关键词匹配）：
 * 边界保守：拿不准就不给权限/不改名单/保持现状。宁可少记（总管可补），不可错记（撤回麻烦）。
 * toldMin：额外记忆一段触发线（低门槛——二段逐轮判定才是真正闸门，这里只决定要不要多查一次）；
 * extraRoundMin：额外记忆二段逐轮移植线（高门槛——宁缺勿滥，补错了要手动撤）。
 */
export const JEV_THRESHOLDS = { confidenceMin: 0.45, perceiveMin: 0.7, interactMin: 0.7, interactMax: 0.3, gateKeep: 0.5, toldMin: 0.5, extraRoundMin: 0.75 }

export interface JevRouteInput {
  llm: { baseUrl: string; apiKey: string; model: string }
  /** 可发言者（现场 ∪ 接入）——next_speaker 的选项集。 */
  roster: RoutableCharacter[]
  rosterLines: string[]
  /** 全部角色名（在场/接入/感知判断覆盖全群）。 */
  allNames: string[]
  /** 当前场景（记录基准，模糊判断保持现状）。 */
  present: string[]
  remote: RemoteLink[]
  overhear: RemoteLink[]
  presentNotes: string[]
  /** 每个角色的状态原文摘要（门控判断的原料；Jev 自己读懂"世界一片漆黑"，不做关键词匹配）。 */
  statusNotes: string[]
  /** 最近对话（不含本轮用户发言）。 */
  recent: string
  /** 本轮用户发言原文（门控与路由的判断对象；此刻尚未落盘）。 */
  userText?: string
  tone: string
  rules?: string
  timeoutMs?: number
  /** 地图：全部场景（名+描述全文）。非空 = 地图群，追加换场景与位置判定。 */
  scenes?: Array<{ name: string; description: string }>
  /** 当前场景名（地图群）。 */
  activeScene?: string
  /** 各角色所在场景（地图群；缺键 = 其他）。 */
  locations?: Record<string, string>
  /** 用户手选的目标场景（⊘ 按钮）：设置时不再问换场景判定，直接按"是"处理。 */
  manualScene?: string
  /** 判定日志回调（判定.jsonl 用，只给人看）：成功带全部原始答案与耗时，失败带原因。 */
  log?: (entry: Record<string, unknown>) => void
}

export interface JevRouteResult {
  /** 选中的发言者；**空串 = Jev 路由不可用**（置信不足/名单外）——调用方把路由回退完整总管，
   *  但同一结果里的位置/知情/转告/状态门判定照常生效（各自带阈值，单独站得住）。 */
  picked: string
  reason: string
  /** 链接修正（接入/单向感知层，与位置正交；未变时 undefined）。各层 since 由 setScene 继承。 */
  links?: { remote: RemoteLink[]; overhear: RemoteLink[] }
  /** 地图群：本轮用户换到的场景（'' = 未移动/置信不足/无效）。⊘ 手选时直接为手选值。 */
  sceneChange?: string
  /** 地图群：各角色的最新位置（有效场景名；undefined = 其他/未提及）——唯一的在场机制。 */
  locationChoice?: Record<string, string | undefined>
  /** 各角色的知情判断值（缺答案的语义由调用方按在场事实补齐）。 */
  knowsNoul?: Record<string, number>
  /** 知情名单：Jev 判定**能感知到**本轮用户发言的角色（= 该消息的 visible_to；知情 = 原文移植）。 */
  knows: Set<string>
  /** 额外记忆触发名单：这条发言在向谁**转告**他原本不知道的事（懒人转述）。二段逐轮判定另行触发。 */
  told: Set<string>
  /** 状态账本总门：true = 可能造成状态变化、需要后台记账；缺答案按 true（安全侧，宁可白跑不可丢账）。 */
  stateDirty: boolean
}

/**
 * 快路径：一次 Jev 调用同时回答"谁接话""三层场景名单是否要修""谁听不到这句发言"
 * "谁被转告了（额外记忆一段触发）""要不要记账（状态总门）"。
 * 判定全部抽象化——问"有没有办法知道/互动"，绝不列举手段，不做关键词匹配。
 * 任何失败（网络/超时/低置信/名单外）返回 undefined——调用方回退 deepseek 完整总管，
 * 绝不让快路径本身成为新的等待或错判来源；缺答案的字段按"保持现状"处理（fail-open）。
 */
export async function jevRoute(input: JevRouteInput): Promise<JevRouteResult | undefined> {
  if (input.roster.length === 0) return undefined
  const overviews = new Map(input.rosterLines.map(l => [l.split('｜')[0]?.trim() ?? '', l.split('｜').slice(1).join('｜').trim()]))
  const criteria: Record<string, string> = {}
  for (const c of input.roster) criteria[c.name] = overviews.get(c.name) ?? ''
  const absentNow = input.allNames.filter(n => !input.present.includes(n))
  const statusOf = new Map(input.statusNotes.map(l => [l.split('｜')[0]?.trim() ?? '', l.split('｜').slice(1).join('｜').trim()]))
  // 地图（§4）：非空 = 地图群，追加换场景与位置判定
  const scenes = input.scenes ?? []
  const isMap = scenes.length > 0
  const activeScene = input.activeScene ?? ''
  const sceneCriteria = Object.fromEntries(scenes.map(s => [s.name, s.description]))
  const state = [
    '判断抽象情景（能否感知/能否互动，与手段无关）。',
    `候选：${input.roster.map(c => c.name).join('、')}（可发言）`,
    `场景：${input.presentNotes.join('、') || '（无）'}`,
    isMap ? [
      `[场景地图]`,
      `当前场景：${activeScene || '（未定）'}`,
      ...scenes.map(s => `- ${s.name}：${s.description}`),
      `[人员位置] ${input.allNames.map(n => `${n}=${input.locations?.[n] ?? '其他'}`).join('、')}`,
    ].join('\n') : '',
    input.statusNotes.length > 0 ? `状态：${input.statusNotes.join('；')}（原文）` : '',
    input.userText !== undefined ? `用户刚说：${input.userText}` : '',
  ].filter(s => s !== '').join('\n')

  const questions: Record<string, import('../llm/jev.ts').JevQuestion> = {
    next_speaker: {
      type: 'choice',
      // 主判定不提供"选用户"出口：用户发言必有角色接话；把发言权交还用户是接力判定的职责。
      instructions: '用户这段话之后，下一位发言者应该是谁？先判断用户在跟谁说话：括号里的动作描写通常标明真正的对话对象；说话内容里出现的名字可能是被谈论的第三者而非对话对象——括号指向与台词中的名字冲突时，以括号指向的人为准；括号没有指向任何人、且台词直接点名时，选被点名的角色。只能从选项中选。',
      criteria,
    },
  }
  // 换场景判定（地图群）：极严苛二元——只有明确描写到达/进入某个已建场景才算
  if (isMap && input.manualScene === undefined) {
    questions['scene_change'] = {
      type: 'choice',
      instructions: '判断：用户这段话是否在**明确描写他移动到了某个场景**（走进/来到/回到/被带进选项中的某个场景）。极其严苛：只有明确写出到达或进入该场景的动作才算；只是提到地名、打算去、让别人去、比喻或回忆都不算。没有移动 = 选"未移动"。',
      criteria: { ...sceneCriteria, 未移动: '用户本轮没有移动场景' },
    }
  }
  // 位置判定（地图群，全角色）——唯一的在场机制：每个角色此刻在哪个场景。
  // 极严苛：对话明确描写他移动/到达/离开才改变；没提就选他记录中的位置（模糊 = 维持现状）。
  // 同场景者由代码直接派生为现场（present），此题只负责把位置表更新到剧情最新事实。
  if (isMap) {
    for (const n of input.allNames) {
      questions[`location_${n}`] = {
        type: 'choice',
        instructions: `结合对话判断：${n} 此刻所在的场景（他记录的位置：${input.locations?.[n] ?? '其他'}；当前场景：${activeScene || '未定'}）。判定标准：对话**明确描写**他移动/到达/被带到某场景，才选该场景；对话没有提及他的移动，就选他记录中的位置；去了场景列表之外的地方、或完全没说去哪 = 选"其他"。"他可能在""他应该会去"这类推测一律不算。`,
        criteria: { ...sceneCriteria, 其他: '图外，或对话没有提及他的去向' },
      }
    }
  }
  // 不在场者：两个抽象是非题——"有没有办法知道"与"能不能实时互动"，由答案推导层级
  for (const n of absentNow) {
    questions[`perceive_${n}`] = {
      type: 'noul',
      instructions: `根据对话判断：${n} 此刻有没有办法知道这个场景里正在发生的事？任何途径都算（人就在隔壁、通过器物、异能……），只判断"能不能"，不关心用什么手段。完全没办法 = 0。`,
    }
    questions[`interact_${n}`] = {
      type: 'noul',
      instructions: `根据对话判断：场景里的人此刻能否与 ${n} 实时互动（说话他能立刻听到、他能立刻回应）？完全无法实时互动 = 0。`,
    }
    questions[`mode_${n}`] = {
      type: 'choice',
      instructions: `若 ${n} 此刻能感知这个场景，他能感知到什么？`,
      criteria: { 语音: '只有声音', 视听: '声音和画面都有' },
    }
  }
  // 知情判定（全角色）：本条消息的内容，谁该知道？"在场直接感知/经通道感知"都算——
  // 判定抽象情景（能不能感知到这条消息的内容），不列举手段、不做关键词匹配。
  // 结果即该消息的 visible_to（知情 = 原文移植进账本，不做任何总结）。
  for (const n of input.allNames) {
    questions[`knows_${n}`] = {
      type: 'noul',
      instructions: `结合剧情、场景记录与 ${n} 的状态判断：用户刚说的这段话，${n} 能不能感知到其内容（在场直接感知、或经通道感知都算）？说话人刻意压低声音、背对、距离过远、感知障碍、通道传不到（如语音通道传不了无声画面）等情况都算不能。确定能 = 1，确定不能 = 0。`,
    }
  }
  // 额外记忆一段触发（全角色）：这条发言是否在向谁**转告**他原本不知道的事（懒人转述——
  // "把……告诉了……""打电话通知了……"这类一句话带过的告知）。命中者由二段判定逐轮打分后再移植，
  // 这里只决定要不要多查一次，门槛从低（漏了只是维持现状，错触发只是多一次廉价判定）。
  for (const n of input.allNames) {
    questions[`told_${n}`] = {
      type: 'noul',
      instructions: `判断：用户刚说的这段话，是不是在把某段 ${n} 本来不知道的对话或事情**转告**给他（一句话带过的告知、转述、打电话通知都算）？事情就当着他的面发生、或他本来就知道、或这段话没有向他转告任何事，都不算。确定是转告 = 1，确定不是 = 0。`,
    }
  }
  // 状态账本总门（一道题）：有没有可能对某些角色产生**持久影响**（用户的"影响"口径——
  // 不限于物理环境：挨打、情绪剧变、被看到、关系变化都算）。这是后台 DeepSeek 记账的触发闸——
  // 缺答案按"需要"（安全侧）：宁可白跑一次记账，不可让状态悄悄变陈旧。
  questions['state_dirty'] = {
    type: 'noul',
    instructions: '判断：这段话及其语境，是否可能对某些角色产生持久影响（受伤/死亡/情绪剧变/移动位置/换装/关系变化/知晓了重要的事都算；纯闲聊不算）。可能 = 1，确定不会 = 0。',
  }

  try {
    const t0 = Date.now()
    const answers = await jevDecide({
      llm: input.llm,
      state,
      questions,
      timeoutMs: input.timeoutMs,
    })
    // 路由：选项必须在可发言名单内且置信度达标；不达标 → 仅路由回退完整总管（picked 置空标记），
    // 同一批答案里的场景/知情/转告/状态门判定**照常生效**——它们各自带阈值，单独站得住。
    const route = answers['next_speaker']
    const routeUsable = route?.type === 'choice'
      && input.roster.some(c => c.name === route.choice)
      && route.confidence >= JEV_THRESHOLDS.confidenceMin

    // 地图群：换场景与位置判定（⊘ 手选时 scene_change 未问，直接按手选值）。
    // locationChoice 是唯一的在场机制：每个角色的最新位置（undefined = 其他/未提及）。
    let sceneChange: string | undefined
    let locationChoice: Record<string, string | undefined> | undefined
    if (isMap) {
      const sceneNames = scenes.map(s => s.name)
      if (input.manualScene !== undefined) sceneChange = input.manualScene
      else {
        const sc = answers['scene_change']
        sceneChange = sc?.type === 'choice' && sceneNames.includes(sc.choice) && sc.confidence >= JEV_THRESHOLDS.confidenceMin ? sc.choice : ''
      }
      locationChoice = {}
      for (const n of input.allNames) {
        const a = answers[`location_${n}`]
        locationChoice[n] = a?.type === 'choice' && sceneNames.includes(a.choice) ? a.choice : undefined
      }
    }

    // 链接修正的推导（接入/单向感知，全部 fail-open：缺答案=保持现状）。
    // 现场不在此推导——地图群下现场 = 位置等于当前场景的角色（代码事实，由 location 答案驱动）。
    const oldRemote = new Map(input.remote.map(l => [l.character, l]))
    const oldOverhear = new Map(input.overhear.map(l => [l.character, l]))
    const remote: RemoteLink[] = []
    const overhear: RemoteLink[] = []
    for (const n of absentNow) {
      if (locationChoice?.[n] === (input.activeScene ?? '')) continue // 位置判定已把他放进当前场景 → 现场成员，不设链接
      const wasRemote = oldRemote.has(n)
      const wasOverhear = oldOverhear.has(n)
      const pa = answers[`perceive_${n}`]
      const pPerceive = pa?.type === 'noul' ? pa.noul : (wasRemote || wasOverhear ? 1 : 0)
      if (pPerceive < JEV_THRESHOLDS.perceiveMin) continue // 不满足"能知道"：不进任何感知层
      const ia = answers[`interact_${n}`]
      const pInteract = ia?.type === 'noul' ? ia.noul : (wasRemote ? 1 : wasOverhear ? 0 : 0.5)
      const mode = answers[`mode_${n}`]
      const perceive = mode?.type === 'choice' && mode.choice === '视听' ? '视听' as const
        : oldRemote.get(n)?.perceive ?? oldOverhear.get(n)?.perceive ?? '语音' as const
      const note = oldRemote.get(n)?.note ?? oldOverhear.get(n)?.note
      if (pInteract >= JEV_THRESHOLDS.interactMin) remote.push({ character: n, perceive, ...(note !== undefined ? { note } : {}) })
      else if (pInteract > JEV_THRESHOLDS.interactMax) {
        // 模糊：已在本层的保持原层（不因抖动降级/升级）；新出现者保守放单向（权限更少）
        if (wasRemote) remote.push({ character: n, perceive, ...(note !== undefined ? { note } : {}) })
        else overhear.push({ character: n, perceive, ...(note !== undefined ? { note } : {}) })
      } else overhear.push({ character: n, perceive, ...(note !== undefined ? { note } : {}) })
    }
    const sameLinks = (a: RemoteLink[], b: RemoteLink[]): boolean =>
      a.length === b.length && a.every(l => { const o = b.find(x => x.character === l.character); return o !== undefined && o.perceive === l.perceive })
    const linksUnchanged = sameLinks(remote, input.remote) && sameLinks(overhear, input.overhear)

    // 知情名单：确定感知不到（< 阈值）的不给；缺答案时现场者保持（代码保底）、其他人不给。
    // 通道/单向感知者受各自的 since 锚点约束（接入之前的事不知道）——由调用方按 id 过滤。
    const knows = new Set<string>()
    const knowsNoul: Record<string, number> = {}
    for (const n of input.allNames) {
      const g = answers[`knows_${n}`]
      const wasPresent = input.present.includes(n)
      const p = g?.type === 'noul' ? g.noul : wasPresent ? 1 : 0
      knowsNoul[n] = p
      if (p >= JEV_THRESHOLDS.gateKeep) knows.add(n)
    }

    // 额外记忆触发名单：缺答案 = 未触发（二段判定本来就不该乱跑；漏触发只是维持现状）。
    const told = new Set<string>()
    for (const n of input.allNames) {
      const t = answers[`told_${n}`]
      if (t?.type === 'noul' && t.noul >= JEV_THRESHOLDS.toldMin) told.add(n)
    }
    const dirtyAns = answers['state_dirty']
    const stateDirty = dirtyAns?.type === 'noul' ? dirtyAns.noul >= JEV_THRESHOLDS.gateKeep : true

    if (!routeUsable) {
      input.log?.({
        note: '路由不可用——路由回退完整总管，位置/知情/转告/状态门判定照常生效',
        route: route?.type === 'choice' ? route.choice : String(route?.type ?? '无答案'),
        confidence: route?.type === 'choice' ? route.confidence : undefined,
        ...(linksUnchanged ? { links: '未变' } : { links: { remote: remote.map(l => `${l.character}(${l.perceive})`), overhear: overhear.map(l => `${l.character}(${l.perceive})`) } }),
        ...(sceneChange !== undefined ? { sceneChange } : {}),
        knows: [...knows],
        told: [...told],
        stateDirty,
        elapsedMs: Date.now() - t0,
        answers,
      })
      return {
        picked: '',
        reason: 'Jev路由置信不足或名单外——路由回退完整总管，位置/知情判定照常生效',
        ...(linksUnchanged ? {} : { links: { remote, overhear } }),
        ...(sceneChange !== undefined ? { sceneChange, locationChoice, knowsNoul } : {}),
        knows,
        told,
        stateDirty,
      }
    }

    input.log?.({
      picked: route.choice,
      confidence: route.confidence,
      ...(linksUnchanged ? { links: '未变' } : { links: { remote: remote.map(l => `${l.character}(${l.perceive})`), overhear: overhear.map(l => `${l.character}(${l.perceive})`) } }),
      ...(sceneChange !== undefined ? { sceneChange } : {}),
      knows: [...knows],
      told: [...told],
      stateDirty,
      elapsedMs: Date.now() - t0,
      answers,
    })

    return {
      picked: route.choice,
      reason: `Jev·置信${route.confidence.toFixed(2)}`,
      ...(linksUnchanged ? {} : { links: { remote, overhear } }),
      ...(sceneChange !== undefined ? { sceneChange, locationChoice, knowsNoul } : {}),
      knows,
      told,
      stateDirty,
    }
  } catch (e) {
    input.log?.({ error: String(e instanceof Error ? e.message : e) })
    if (process.env.DSH_DEBUG === '1') console.error('[jevRoute] 快路径失败（回退 deepseek 总管）:', e)
    return undefined
  }
}

/**
 * 回复后的合并判定（一次 Jev 调用回答整段"回复后"问题，替代旧的一次知情 + 一次接力两连调）：
 * - knows_<候选>：这段回复的知情名单（visible_to 用，发言者本人不在候选内）；
 * - state_dirty：状态账本总门（缺答案 = true，安全侧）；
 * - told_<候选>：这段回复是否在向谁转告他原本不知道的事（额外记忆一段触发）；
 * - next_speaker：接力判定（用户也在候选）。
 * 任何整体失败返回 undefined——调用方按部分各自的保底走：知情=现场∩感知完整、记账=照跑、
 * 转告=无、接力=发言权交还用户（与旧的接力失败行为一致）。
 */
export interface JevAfterReplyResult {
  /** 能感知到这段回复的角色（缺答案者不算入）。 */
  audience: Set<string>
  /** 状态账本总门：true = 需要后台记账。 */
  stateDirty: boolean
  /** 这段回复在向谁转告他原本不知道的事。 */
  told: Set<string>
  /** 接力判定；undefined = 交还用户 / 失败 / 低置信（调用方结束接力）。
   *  probabilities = 该选择的完整概率分布（含用户），供引擎做纯代码的接力衰减加权。 */
  next?: { picked: string; userTurn: boolean; reason: string; probabilities?: Record<string, number> }
}

export async function jevAfterReply(input: {
  llm: { baseUrl: string; apiKey: string; model: string }
  /** 刚说完话的角色。 */
  speaker: string
  replyText: string
  /** 知情/转告候选（全部角色，除发言者本人）。 */
  candidates: string[]
  /** 可发言角色（接力候选；现场 ∪ 接入）——不含用户。 */
  roster: RoutableCharacter[]
  rosterLines: string[]
  /** 用户称呼（接力候选之一；选中即接力结束）。 */
  userName: string
  statusNotes: string[]
  presentNotes: string[]
  /** 地图群当前在场者：知情缺答案时按在场事实默认在列（人就在屋里）。 */
  present?: string[]
  /** 最近对话（不含本段回复——回复原文单独给）。 */
  recent: string
  tone: string
  rules?: string
  timeoutMs?: number
  /** 判定日志回调（判定.jsonl 用，只给人看）：成功带全部原始答案与耗时，失败带原因。 */
  log?: (entry: Record<string, unknown>) => void
}): Promise<JevAfterReplyResult | undefined> {
  const questions: Record<string, import('../llm/jev.ts').JevQuestion> = {}
  for (const n of input.candidates) {
    questions[`knows_${n}`] = {
      type: 'noul',
      instructions: `结合剧情、场景记录与 ${n} 的状态判断：${input.speaker} 刚说的这段话，${n} 能不能感知到其内容（在场直接感知、或经通道感知都算）？刻意压低声音、背对、距离过远、感知障碍、通道传不到等情况都算不能。确定能 = 1，确定不能 = 0。`,
    }
    questions[`told_${n}`] = {
      type: 'noul',
      instructions: `判断：${input.speaker} 刚说的这段话，是不是在把某段 ${n} 本来不知道的对话或事情**转告**给他（一句话带过的告知、转述、打电话通知都算）？事情就当着他的面发生、或他本来就知道、或这段话没有向他转告任何事，都不算。确定是转告 = 1，确定不是 = 0。`,
    }
  }
  questions['state_dirty'] = {
    type: 'noul',
    instructions: '判断：这段话及其语境，是否可能对某些角色产生持久影响（受伤/死亡/情绪剧变/移动位置/换装/关系变化/知晓了重要的事都算；纯闲聊不算）。可能 = 1，确定不会 = 0。',
  }
  const overviews = new Map(input.rosterLines.map(l => [l.split('｜')[0]?.trim() ?? '', l.split('｜').slice(1).join('｜').trim()]))
  const criteria: Record<string, string> = {}
  for (const c of input.roster) criteria[c.name] = overviews.get(c.name) ?? ''
  criteria[input.userName] = '群聊用户本人：接下来应轮到用户说话或做出决定'
  questions['next_speaker'] = {
    type: 'choice',
    instructions: '选出下一位**输出内容**的角色或用户：角色的输出可以是说话，也可以是动作、神态，或沉默（沉默本身就是一种回应）。刚输出过内容的角色通常不立即连续输出；但刚被哀求、被点名、被质问、被逼迫回应的角色必须获得输出权——哪怕他会保持沉默，他的沉默就是对哀求的回应。判断刚输出内容的一方在跟谁说话：括号里的动作描写通常标明真正的对象，台词中出现的名字可能只是被谈论的第三者，冲突时以括号指向为准。只有当剧情的下一步明显该由用户决定、或对话已自然告一段落时才选用户。不确定时选用户。',
    criteria,
  }
  try {
    const t0 = Date.now()
    const answers = await jevDecide({
      llm: input.llm,
      state: [
        '你是群聊的快速判断层。一位角色刚说完话，根据对话与角色状态回答结构化问题（判定抽象情景，与手段无关），并判断接下来的发言权归谁。',
        `[当前场景人员]\n${input.presentNotes.join('、') || '（无）'}`,
        input.statusNotes.length > 0 ? `[角色状态原文]\n${input.statusNotes.join('\n')}` : '',
        `[${input.speaker} 刚说的这段话]\n${input.replyText}`,
        input.tone !== '' ? `[群聊基调]\n${input.tone}` : '',
        input.rules !== undefined && input.rules.trim() !== '' ? `[规则（用户设定）]\n${input.rules.trim()}` : '',
        '[最近对话]',
        input.recent,
      ].filter(s => s !== '').join('\n'),
      questions,
      timeoutMs: input.timeoutMs,
    })
    const audience = new Set<string>()
    for (const n of input.candidates) {
      const g = answers[`knows_${n}`]
      if (g?.type === 'noul' && g.noul >= JEV_THRESHOLDS.gateKeep) audience.add(n)
      else if (g === undefined && input.present?.includes(n)) audience.add(n) // 在场者缺答案按在场事实在列
    }
    const told = new Set<string>()
    for (const n of input.candidates) {
      const t = answers[`told_${n}`]
      if (t?.type === 'noul' && t.noul >= JEV_THRESHOLDS.toldMin) told.add(n)
    }
    const dirtyAns = answers['state_dirty']
    const stateDirty = dirtyAns?.type === 'noul' ? dirtyAns.noul >= JEV_THRESHOLDS.gateKeep : true
    const route = answers['next_speaker']
    let next: JevAfterReplyResult['next'] = undefined
    let relayConfidence = 0
    if (route?.type === 'choice' && route.confidence >= JEV_THRESHOLDS.confidenceMin) {
      const isCharacter = input.roster.some(c => c.name === route.choice)
      if (isCharacter) next = { picked: route.choice, userTurn: false, reason: `Jev·置信${route.confidence.toFixed(2)}` }
      else if (route.choice === input.userName) next = { picked: route.choice, userTurn: true, reason: `Jev·置信${route.confidence.toFixed(2)}` }
      if (next !== undefined) {
        relayConfidence = route.confidence
        // 透出完整分布：引擎要做纯代码的接力衰减加权（同角色连续输出概率打折），Jev 不可见
        next.probabilities = { ...route.probabilities }
      }
    }
    input.log?.({
      speaker: input.speaker,
      audience: [...audience],
      told: [...told],
      stateDirty,
      ...(next === undefined ? { relay: '交还用户' } : { relay: next.picked, relayUserTurn: next.userTurn, relayConfidence }),
      elapsedMs: Date.now() - t0,
      answers,
    })
    return { audience, stateDirty, told, ...(next === undefined ? {} : { next }) }
  } catch (e) {
    input.log?.({ speaker: input.speaker, error: String(e instanceof Error ? e.message : e) })
    if (process.env.DSH_DEBUG === '1') console.error('[jevAfterReply] 合并判定失败（知情回退确定性保底、记账照跑、接力交还用户）:', e)
    return undefined
  }
}

/**
 * 额外记忆二段判定：对一段触发转告的角色，逐轮打分"该轮内容是否属于这次转告要告知的"。
 * 候选轮 = 该角色账本里还没有的消息所在轮（他错过的），由调用方算好传入（带每轮一句话摘要）。
 * ≥ extraRoundMin 的轮由调用方逐字移植（source=额外得知）。整体失败返回 undefined（不移植——
 * 漏补只是维持现状，错补要手动撤，宁缺勿滥）。
 */
export async function jevExtraRounds(input: {
  llm: { baseUrl: string; apiKey: string; model: string }
  character: string
  /** 转告原话（触发判定的那条消息文本）。 */
  retoldText: string
  /** 候选轮（该角色缺失的轮次，升序，已按窗口预算截断）。 */
  missing: Array<{ round: number; summary: string }>
  timeoutMs?: number
  /** 判定日志回调（判定.jsonl 用，只给人看）。 */
  log?: (entry: Record<string, unknown>) => void
}): Promise<Set<number> | undefined> {
  if (input.missing.length === 0) return new Set()
  const questions: Record<string, import('../llm/jev.ts').JevQuestion> = {}
  for (const m of input.missing) {
    questions[`round_${m.round}`] = {
      type: 'noul',
      instructions: `第${m.round}轮的内容，是否属于这次转告要告知 ${input.character} 的？确定是 = 1，确定不是 = 0，拿不准给接近 0.5 的概率。`,
    }
  }
  try {
    const t0 = Date.now()
    const answers = await jevDecide({
      llm: input.llm,
      state: [
        '你在判断一次"转告"：某人用一句话把之前发生的某段事情告知了一个当时不在场的人。逐轮判断哪些轮的内容属于这次转告的范围。',
        `[转告原话]\n${input.retoldText}`,
        `[${input.character} 缺少的轮次（他不在场/未被知会期间的对话，附首句摘要）]`,
        ...input.missing.map(m => `第${m.round}轮：${m.summary}`),
      ].join('\n'),
      questions,
      timeoutMs: input.timeoutMs,
    })
    const out = new Set<number>()
    for (const m of input.missing) {
      const a = answers[`round_${m.round}`]
      if (a?.type === 'noul' && a.noul >= JEV_THRESHOLDS.extraRoundMin) out.add(m.round)
    }
    input.log?.({
      character: input.character,
      candidateRounds: input.missing.map(m => m.round),
      granted: [...out],
      elapsedMs: Date.now() - t0,
      answers,
    })
    return out
  } catch (e) {
    input.log?.({ character: input.character, error: String(e instanceof Error ? e.message : e) })
    if (process.env.DSH_DEBUG === '1') console.error('[jevExtraRounds] 逐轮判定失败（不移植）:', e)
    return undefined
  }
}

// ---------- 慢路径：总管记账（SPEC §6.1b，回复完成后后台执行，不阻塞显示） ----------

export const BOOKKEEP_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'record_round',
    description: '剧情刚走完一条消息（一段用户发言，或某角色对它的回复）。记录这段剧情造成的持久**状态**变化；只记确实发生的，没有变化就不填',
    parameters: {
      type: 'object',
      properties: {
        状态账本: {
          type: 'array',
          description: '对发生状态变化的角色，输出其**完整最新状态账本**（整体快照，不是增量）：输入里给了各角色当前账本，没变化的字段原样带回，变化的字段写新值；没有角色发生变化就不要填。',
          items: { ...LEDGER_ITEM_SCHEMA },
        },
      },
      required: [],
    },
  },
}

export interface BookkeeperInput {
  rosterLines: string[]
  presentNotes: string[]
  /** 地图群：各角色当前所在场景（判定层记录；缺键 = 其他）。 */
  locations?: Record<string, string>
  /** 各角色当前状态账本（整体快照更新的基准，形如 "角色甲｜生理状态:..." 行）。 */
  ledgers: string[]
  /** 本轮用户发言。 */
  userText: string
  /** 被选中角色的名字与其回复全文（记账的判断对象）；空串 = 只有用户发言、尚无角色回复。 */
  speaker: string
  replyText: string
  recent: string
  tone: string
  rules?: string
  timeoutMs?: number
}

/** 慢路径记账：deepseek 单次 tool-call；失败抛错由调用方降级提示（不影响已完成的回复）。 */
export async function askBookkeeper(input: BookkeeperInput): Promise<Pick<RouteResult, 'ledgerUpdates' | 'appends' | 'presenceUpdates'>> {
  const prompt = [
    '你是群聊总管。剧情刚走完一条消息，请记账。',
    '[可选角色]',
    ...input.rosterLines.map(l => `- ${l}`),
    `[当前场景人员]\n${input.presentNotes.join('、') || '（无）'}`,
    input.locations !== undefined && Object.keys(input.locations).length > 0
      ? `[人员位置（判定层记录，以此为准）]\n${Object.entries(input.locations).map(([k, v]) => `${k}=${v}`).join('、')}`
      : '',
    input.ledgers.length > 0 ? `[各角色当前状态账本（更新时整体快照：没变化的字段原样带回，变化的字段写新值）]\n${input.ledgers.join('\n')}` : '',
    input.tone !== '' ? `[群聊基调]\n${input.tone}` : '',
    input.rules !== undefined && input.rules.trim() !== '' ? `[规则（用户设定）]\n${input.rules.trim()}` : '',
    `[本轮用户发言]\n${input.userText}`,
    ...(input.replyText.trim() === '' ? [] : [`[${input.speaker} 的回复]\n${input.replyText}`]),
    '[最近对话]',
    input.recent,
    '调用 record_round 工具记录这段剧情造成的持久**状态**变化（状态账本整体快照）；没发生的变化不要填。特别留意位置状态：对话描写了某人移动/到场/离开时，必须同步更新其位置状态，不能停留在旧记录上。状态账本只写客观要点（短语式，无形容词渲染、无文学描写、无比喻）——它是骨架不是描写，写丰满会让角色反复复读。',
  ].filter(s => s !== '').join('\n')

  const call = await chatToolCall(resolveLlm(), {
    messages: [
      { role: 'system', content: '你是这个群聊的总管，负责维护角色的状态账本，并保证各角色只知道他该知道的。' },
      { role: 'user', content: prompt },
    ],
    tools: [BOOKKEEP_TOOL],
    expectedFunction: 'record_round',
    signal: AbortSignal.timeout(input.timeoutMs ?? 60000),
  })
  const args = JSON.parse(call.arguments) as Parameters<typeof parseBookkeeping>[0]
  // 记账员只有状态账本写入权（§6.1b）：场景名册唯一写者 = Jev 每轮判定 / 总管代管 / 用户手动修正
  return { ledgerUpdates: parseBookkeeping(args).ledgerUpdates, appends: [], presenceUpdates: [] }
}

// ---------- 纠正窗口：用户直接与总管对话（戏外） ----------

/** apply_corrections：总管在戏外被用户纠正时，一次性回应并落定各项修正。 */
export const CORRECTION_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'apply_corrections',
    description: '回应用户的纠正，并把需要修正的内容落实（只填真正要改的项）',
    parameters: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: '说给用户听的话：确认你改了什么，或说明你为什么那样判断' },
        presence_updates: {
          type: 'array',
          description: '修正当前场景人员（给出修正后的完整名单）',
          items: { ...PRESENCE_ITEM_SCHEMA },
        },
        状态账本: {
          type: 'array',
          description: '按用户要求修正某角色的状态账本（**完整最新快照**：输入里给了当前账本，没变的字段原样带回，用户要求改的字段写新值）',
          items: { ...LEDGER_ITEM_SCHEMA },
        },
        knowledge_appends: {
          type: 'array',
          description: '补记某角色应当知道的信息',
          items: {
            type: 'object',
            properties: { character: { type: 'string' }, source: { type: 'string', enum: ['亲历', '推断', '他人告知', '用户指定'] }, entry: { type: 'string' } },
            required: ['character', 'source', 'entry'],
          },
        },
        knowledge_retracts: {
          type: 'array',
          description: '撤回某角色不该有的记忆：给 mid（该记忆来自第几条消息）或 text（按内容匹配）',
          items: {
            type: 'object',
            properties: { character: { type: 'string' }, mid: { type: 'number' }, text: { type: 'string' } },
            required: ['character'],
          },
        },
      },
      required: ['reply'],
    },
  },
}

export interface CorrectionResult {
  reply: string
  presence: Array<{ present: string[]; remote?: RemoteLink[]; overhear?: RemoteLink[]; reason: string }>
  ledgerUpdates: RouteResult['ledgerUpdates']
  appends: RouteResult['appends']
  retracts: Array<{ character: string; mid?: number; text?: string }>
}

export interface CorrectionInput {
  rosterLines: string[]
  presentNotes: string[]
  /** 地图群：各角色当前所在场景（判定层记录；缺键 = 其他）。 */
  locations?: Record<string, string>
  /** 各角色当前状态账本（整体快照修正的基准）。 */
  ledgers: string[]
  settings: GroupSettings
  recent: string
  rules?: string
  text: string
  timeoutMs?: number
}

/** 让总管在戏外回应用户的纠正，并给出要落实的修正项。 */
export async function askDirector(input: CorrectionInput): Promise<CorrectionResult> {
  const prompt = [
    '用户在戏外直接跟你（总管）说话：可能是纠正你的判断、提出要求，或询问剧情安排。',
    '[可选角色]',
    ...input.rosterLines.map(l => `- ${l}`),
    `[当前场景人员]\n${input.presentNotes.join('、') || '（无）'}`,
    input.locations !== undefined && Object.keys(input.locations).length > 0
      ? `[人员位置（判定层记录，以此为准）]\n${Object.entries(input.locations).map(([k, v]) => `${k}=${v}`).join('、')}`
      : '',
    input.ledgers.length > 0 ? `[各角色当前状态账本（修正时整体快照：没变化的字段原样带回，用户要求改的字段写新值）]\n${input.ledgers.join('\n')}` : '',
    input.settings.tone !== '' ? `[群聊基调]\n${input.settings.tone}` : '',
    input.rules !== undefined && input.rules.trim() !== '' ? `[规则（用户设定）]\n${input.rules.trim()}` : '',
    '[最近的剧情]',
    input.recent,
    '[用户对你说的话]',
    input.text,
    '调用 apply_corrections：先给出 reply（说给用户听），再把你确实要改的项填上。用户没要求改的不要动，拿不准就只回复不改动。',
  ].filter(s => s !== '').join('\n')

  const call = await chatToolCall(resolveLlm(), {
    messages: [
      { role: 'system', content: '你是这个群聊的总管，负责派谁发言、维护角色状态与知情，并保证各角色只知道他该知道的。现在用户直接找你（戏外对话）。' },
      { role: 'user', content: prompt },
    ],
    tools: [CORRECTION_TOOL],
    expectedFunction: 'apply_corrections',
    signal: AbortSignal.timeout(input.timeoutMs ?? 60000),
  })
  const args = JSON.parse(call.arguments) as {
    reply?: string
    presence_updates?: unknown
    状态账本?: unknown
    knowledge_appends?: unknown
    knowledge_retracts?: unknown
  }
  return {
    reply: typeof args.reply === 'string' && args.reply.trim() !== '' ? args.reply.trim() : '（总管没有回应）',
    presence: asArray<{ present?: unknown; remote?: unknown; overhear?: unknown; reason?: string }>(args.presence_updates).flatMap(p => {
      if (!Array.isArray(p.present)) return []
      const remote = parseRemoteList(p.remote)
      const overhear = parseRemoteList(p.overhear)
      return [{
        present: p.present.map(String).map(s => s.trim()).filter(s => s !== ''),
        ...(remote === undefined ? {} : { remote }),
        ...(overhear === undefined ? {} : { overhear }),
        reason: String(p.reason ?? '用户纠正'),
      }]
    }),
    ledgerUpdates: asArray<Record<string, unknown>>(args['状态账本'])
      .flatMap(u => {
        const character = typeof u.character === 'string' ? u.character.trim() : ''
        if (character === '') return []
        const fields = pickLedgerFields(u)
        return Object.keys(fields).length === 0 ? [] : [{ character, fields }]
      }),
    appends: asArray<{ character?: string; source?: string; entry?: string }>(args.knowledge_appends)
      .filter((a): a is { character: string; source: string; entry: string } =>
        typeof a.character === 'string' && typeof a.entry === 'string' && a.entry !== '')
      .map(a => ({
        character: a.character,
        entry: a.entry,
        // 来源只认四个合法值（工具枚举含"用户指定"）；模型没写或写歪的一律归"用户指定"，不放进任意字符串
        source: a.source !== undefined && ['亲历', '推断', '他人告知', '用户指定'].includes(a.source) ? a.source : '用户指定',
      })),
    retracts: asArray<{ character?: string; mid?: number; text?: string }>(args.knowledge_retracts)
      .filter((r): r is { character: string; mid?: number; text?: string } =>
        typeof r.character === 'string' && (typeof r.mid === 'number' || (typeof r.text === 'string' && r.text !== ''))),
  }
}

// ---------- 现场所见（§5.8）：新进场者对场景实况的目击快照（系统里唯一被允许"生成"的记忆） ----------

export const SCENE_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'record_scene',
    description: '输出一个刚进入场景的人此刻亲眼所见的现场实况（简练白描的现状；不是剧情回顾，不是推理）',
    parameters: {
      type: 'object',
      properties: {
        scene_summary: {
          type: 'string',
          description: '2~4 句白描，此刻亲眼所见的现场状况。只写可观察的：人物姿态/位置/伤势/衣着/表情动作，血迹/痕迹/器物，陈设与环境的当前状况。不回顾历史，不解释来龙去脉，不推断是谁做了什么，不写任何人的内心。禁止伏笔/隐喻/暗示/渲染/夸大/对比/评价，禁止"仿佛/似乎/显然/暗中"。现场无异样就只写"现场无异样"。',
        },
      },
      required: ['scene_summary'],
    },
  },
}

/**
 * 现场所见汇总（§5.8）：读各角色状态账本与最近对话，输出新进场者此刻能**观察到**的实况。
 * 失败/为空抛错由调用方降级（不注入 = 维持现状，可手动补）。
 * 约束是硬性的：这是系统里唯一被允许生成的记忆，绝不允许添油加醋、制造伏笔暗喻——只准白描现状。
 */
export async function askSceneSummarizer(input: {
  presentNotes: string[]
  /** 地图群：各角色当前所在场景（判定层记录；缺键 = 其他）。 */
  locations?: Record<string, string>
  /** 全部角色的状态账本行（不筛在场——现场遗留物属于场景，不属于人）。 */
  ledgers: string[]
  /** 最近对话（进场者缺席期间的，只供参考其中留下的可见痕迹）。 */
  recent: string
  tone: string
  timeoutMs?: number
}): Promise<string> {
  const prompt = [
    '有角色刚进入这个场景，他此前不在场、对这里刚发生的事一无所知。写出他此刻进门第一眼看到的现场实况——这将作为目击记录注入他的记忆。',
    '[现场人员]',
    input.presentNotes.join('、') || '（无）',
    input.locations !== undefined && Object.keys(input.locations).length > 0
      ? `[人员位置（判定层记录）]\n${Object.entries(input.locations).map(([k, v]) => `${k}=${v}`).join('、')}`
      : '',
    input.ledgers.length > 0 ? '[各角色当前状态（原始资料，只提取其中肉眼可见的部分）]\n' + input.ledgers.join('\n') : '',
    '[最近对话（他不在场期间发生的事；只能参考其中留下的可见痕迹，不要复述剧情）]',
    input.recent,
    input.tone !== '' ? `[群聊基调]\n${input.tone}` : '',
    '要求（违反任何一条都不合格）：',
    '- 只写此刻可观察的现状：人物的姿态、位置、伤势、衣着、表情与动作；地上的血迹、痕迹、器物；陈设与环境的当前状况。',
    '- 不回顾历史，不解释来龙去脉，不推断是谁做了什么、怎么发生的（可见的客观证据可以陈述）。',
    '- 不写任何人的内心、情绪、动机——可见的表情与动作可以写。',
    '- 禁止伏笔、隐喻、暗示、渲染、夸大、对比、评价与文采；禁止"仿佛、似乎、显然、暗中"这类词。',
    '- 简练白描，2~4 句；现场无异样就只写"现场无异样"。',
    '调用 record_scene 工具给出 scene_summary。',
  ].filter(s => s !== '').join('\n')
  const call = await chatToolCall(resolveLlm(), {
    messages: [
      { role: 'system', content: '你是这个群聊的现场记录员，只负责客观白描眼前实况。' },
      { role: 'user', content: prompt },
    ],
    tools: [SCENE_TOOL],
    expectedFunction: 'record_scene',
    signal: AbortSignal.timeout(input.timeoutMs ?? 60000),
  })
  const args = JSON.parse(call.arguments) as { scene_summary?: string }
  const summary = typeof args.scene_summary === 'string' ? args.scene_summary.trim() : ''
  if (summary === '') throw new Error('现场汇总为空')
  return summary
}

// ---------- 事件补全（§5.9）：离场期间的经历史上模拟，按参与者限知视角分别渲染 ----------

/** 事件发现工具：只产出客观骨架与参与者名单——事实在此定稿，视角渲染不得增删情节。 */
export const OFFSTORY_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'record_offstory',
    description: '列出离场角色在离场期间卷入的事件（每件事一句话客观骨架 + 全部参与者名单）。只延伸对话中有依据的事，禁止编造重大事件，禁止文笔',
    parameters: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          description: '事件清单；没有可补全的就返回空数组。最多 4 件，每件最多 4 名参与者',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: '一句话客观骨架：谁对谁做了什么/发生了什么。禁止比喻、渲染、评价' },
              participants: { type: 'array', items: { type: 'string' }, description: '全部参与者名单（含离场者本人）' },
            },
            required: ['summary', 'participants'],
          },
        },
      },
      required: ['events'],
    },
  },
}

/**
 * 事件发现（事件补全第一段）：从各回归者的离场窗口对话中，提取并合理补全他们离场期间卷入的事件。
 * 只延伸对话中有依据的事（对他的指令/约定/邀请/关系/他人提到的打算）；日常化；与已有事件补全
 * 不得重复或矛盾；没有可补全的就返回空数组。失败抛错由调用方降级（不注入 = 维持现状）。
 */
export async function askOffStoryDiscovery(input: {
  /** 每个回归者：名字 + 离场窗口对话（截尾）。 */
  windows: Array<{ character: string; dialogue: string }>
  /** 已有的离场经历条目（防重复/防矛盾锚）。 */
  known: string[]
  rosterNames: string[]
  tone: string
  timeoutMs?: number
  log?: (e: Record<string, unknown>) => void
}): Promise<Array<{ summary: string; participants: string[] }> | undefined> {
  const prompt = [
    '有角色要回到场景。他离场期间，剧情仍在多线推进——对话中对他下的指令、与他的约定、别人提到关于他的打算，都可能在离场期间发生或履行。请提取并合理补全这些事件，供注入回归者与参与者的记忆。',
    ...input.windows.map(w => `[${w.character} 离场期间的对话]\n${w.dialogue}`),
    input.known.length > 0 ? '[已有的事件补全（不得重复、不得矛盾）]\n' + input.known.map(k => `- ${k}`).join('\n') : '',
    `[全部角色]\n${input.rosterNames.join('、')}`,
    input.tone !== '' ? `[群聊基调]\n${input.tone}` : '',
    '要求（违反任何一条都不合格）：',
    '- 只补全对话中有依据的事：对他下的指令、与他的约定、对他的邀请、别人提到的关于他的打算——合理模拟这些事的履行经过。',
    '- 每件事一句话客观骨架（谁对谁做了什么/发生了什么）+ 全部参与者名单（含离场者本人）。',
    '- 日常化：禁止编造重大事件（死亡/重伤/重大转折/新角色登场），对话毫无依据的事一律不补。',
    '- 不得与已有的事件补全重复或矛盾；没有可补全的就返回空数组。',
    '- 最多 4 件，每件最多 4 名参与者（超出取与剧情最相关的）。',
    '- 禁止文笔、比喻、伏笔、场景渲染。',
    '调用 record_offstory 工具给出 events。',
  ].filter(s => s !== '').join('\n')
  const t0 = Date.now()
  try {
    const call = await chatToolCall(resolveLlm(), {
      messages: [
        { role: 'system', content: '你是这个群聊的剧情补全员，只负责从既有依据中客观提取与合理延伸离场期间的事件骨架。' },
        { role: 'user', content: prompt },
      ],
      tools: [OFFSTORY_TOOL],
      expectedFunction: 'record_offstory',
      signal: AbortSignal.timeout(input.timeoutMs ?? 60000),
    })
    const args = JSON.parse(call.arguments) as { events?: unknown }
    const names = new Set(input.rosterNames)
    const events = (Array.isArray(args.events) ? args.events : [args.events])
      .map((e): { summary: string; participants: string[] } | undefined => {
        const o = (e ?? {}) as Record<string, unknown>
        const summary = typeof o.summary === 'string' ? o.summary.trim() : ''
        const participants = (Array.isArray(o.participants) ? o.participants : [])
          .map(p => String(p).trim()).filter(p => names.has(p))
        return summary === '' || participants.length === 0 ? undefined : { summary, participants }
      })
      .filter((e): e is { summary: string; participants: string[] } => e !== undefined)
      .slice(0, 4)
    input.log?.({ events, elapsedMs: Date.now() - t0 })
    return events
  } catch (e) {
    input.log?.({ error: String(e instanceof Error ? e.message : e), elapsedMs: Date.now() - t0 })
    return undefined
  }
}

/** 限知视角渲染工具：事实以骨架为准，视角按参与者自身材料走。 */
export const OFFSTORY_POV_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'render_memory',
    description: '以某角色的限知视角，把事件骨架写成他将长期记住的记忆概括（2~3 句，事实与骨架完全一致）',
    parameters: {
      type: 'object',
      properties: {
        memory: { type: 'string', description: '2~3 句记忆概括，以"你"称呼该角色。只复述骨架中的事实，视角与态度按该角色的性格呈现；禁止比喻/隐喻/伏笔/具象化场景渲染/文采/夸大' },
      },
      required: ['memory'],
    },
  },
}

/**
 * 限知视角渲染（事件补全第二段）：同一事件骨架，每个参与者各渲染一份自己的版本——
 * 事实不矛盾（锚死在骨架上），视角与态度按参与者自身性格与处境走（哀求者的感激 与 被求者的
 * 不情愿表面配合，是同一件事的两份合法记忆）。失败抛错由调用方降级（该份不注入）。
 */
export async function askOffStoryPOV(input: {
  /** 一句话客观骨架（事件发现的原样输出）。 */
  event: string
  participant: string
  /** 该角色的初始性格（用户资产）。 */
  personality: string
  /** 该角色当前状态账本行（含人物关系变化）。 */
  ledgerLine: string
  timeoutMs?: number
  log?: (e: Record<string, unknown>) => void
}): Promise<string | undefined> {
  const prompt = [
    `以${input.participant}的限知视角，把下面这件事写成他将长期记住的记忆概括（2~3 句，以"你"称呼他）。`,
    `[事件骨架（事实以此为准，不得增删情节）]\n${input.event}`,
    `[${input.participant} 的初始性格]\n${input.personality || '（无）'}`,
    `[${input.participant} 当前状态账本]\n${input.ledgerLine || '（无）'}`,
    '要求：',
    '- 事实与骨架完全一致，不得增删情节、不得引入骨架外的新信息。',
    '- 只写他能看到/听到/感到的部分——他不知道别人心里的想法，别人的内心只能通过可见的表现呈现。',
    '- 视角与态度按他自己的性格与处境呈现：同一件事，不同角色的记忆版本应当不同。',
    '- 禁止比喻/隐喻/伏笔/具象化场景渲染/文采/夸大；禁止评价性长段；2~3 句。',
    '调用 render_memory 工具给出 memory。',
  ].join('\n')
  const t0 = Date.now()
  try {
    const call = await chatToolCall(resolveLlm(), {
      messages: [
        { role: 'system', content: '你是这个群聊的记忆书写员，只负责把给定事件按指定角色的限知视角写成简练记忆。' },
        { role: 'user', content: prompt },
      ],
      tools: [OFFSTORY_POV_TOOL],
      expectedFunction: 'render_memory',
      signal: AbortSignal.timeout(input.timeoutMs ?? 60000),
    })
    const args = JSON.parse(call.arguments) as { memory?: string }
    const memory = typeof args.memory === 'string' ? args.memory.trim() : ''
    if (memory === '') throw new Error('视角记忆为空')
    input.log?.({ participant: input.participant, memory, elapsedMs: Date.now() - t0 })
    return memory
  } catch (e) {
    input.log?.({ participant: input.participant, error: String(e instanceof Error ? e.message : e), elapsedMs: Date.now() - t0 })
    return undefined
  }
}
