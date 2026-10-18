/**
 * 聊天页（微信气泡流）：
 * - 聊天栏只有消息与流式文本（SPEC §7.5 决策）；route/ledger/info = 输入框上方瞬态单行状态。
 * - 键盘顶起/回落：visualViewport 驱动 --kb，composer translateY(-var(--kb))，0.18s 同一条
 *   缓动——本页唯一被要求"仔细打磨"的动效，只动 transform。
 * - 消息操作走长按（桌面右键等效）：编辑 / 重掷（仅最后一条角色消息）/ 删除（物理删除，
 *   确认文案按 SPEC 必须说明日志不保留原文）。
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { avatarUrl, clearGroupRowsCache, getJson, getThinking, getUndoState, listThinkingAfter, postJson, postStream, readNdjson, type Ev, type Msg, type Snapshot, type UndoState } from './api.ts'
import { applyRules } from './regex.ts'
import { subscribeTurn, getTurn, turnBegin, turnSpeaker, turnDelta, turnReplyDone, turnEnd, turnPatch, turnSetStatus, cachedSnapshot, cacheSnapshot } from './turn.ts'
import { Avatar, Confirm, Modal, NavBar, useLongPress, useToast } from './ui.tsx'
import { ArrowDownToLine, Check, CheckSquare, Copy, Ellipsis, Lightbulb, MapPin, Pencil, RefreshCw, Trash2, Undo2, X } from './icons.tsx'

/** 每群当前挂载的刷新入口：流在旧闭包里收尾时，要刷新"现在挂着的那个实例"，而不是已卸载的旧实例 */
const activeRefresh = new Map<string, () => Promise<void>>()

interface Props { group: string; onBack: () => void; onOpenInfo: () => void }

export function ChatView({ group, onBack, onOpenInfo }: Props): React.ReactElement {
  const toast = useToast()
  const [snap, setSnap] = useState<Snapshot | null>(() => cachedSnapshot(group) ?? null)
  const [avatarV, setAvatarV] = useState(0)
  const [input, setInput] = useState(() => loadDraft(group))
  const [menuMsg, setMenuMsg] = useState<Msg | null>(null)
  const [editMsg, setEditMsg] = useState<Msg | null>(null)
  const [editText, setEditText] = useState('')
  const [delMsg, setDelMsg] = useState<Msg | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /**
   * 本轮状态（busy/流式暂存/乐观回显/状态行）保存在模块级 store 里：
   * 离开页面再回来时能接上仍在进行的生成，而不是气泡凭空消失。
   */
  const turn = useSyncExternalStore(
    useCallback(cb => subscribeTurn(group, cb), [group]),
    () => getTurn(group),
  )
  /** 思维链只读弹窗：循环前 = 草稿生成、循环后 = 判定命中后改稿（'' = 无记录，null = 加载中）。 */
  const [thinkingMsg, setThinkingMsg] = useState<Msg | null>(null)
  const [thinkingStage, setThinkingStage] = useState<'循环前' | '循环后'>('循环前')
  const [thinkingData, setThinkingData] = useState<{ before: string; after: string } | null>(null)
  /** 有「循环后」思维链的消息 id：没改过稿就没有这一项，菜单里干脆不显示（免得点开是空的）。 */
  const [afterIds, setAfterIds] = useState<ReadonlySet<number>>(new Set())
  /** 回退状态（SPEC §1.4）：后台还在写时按钮置灰，写完自动变可点。 */
  const [undo, setUndo] = useState<UndoState | null>(null)
  const [undoConfirm, setUndoConfirm] = useState(false)
  /** 头像查看弹窗：点消息头像放大看图（未设置头像的消息没有此入口）。 */
  const [viewAvatar, setViewAvatar] = useState<{ name: string; url: string } | null>(null)
  const openAvatar = useCallback((name: string, url: string): void => { setViewAvatar({ name, url }) }, [])
  /** ⊘ 场景手选：弹窗挑选后，本轮发送直接按"已移动到该场景"处理（跳过换场景判定）。 */
  const [scenePick, setScenePick] = useState(false)
  const [pendingScene, setPendingScene] = useState<string | null>(null)
  /** 客观注入武装态：本轮发送不经感知判定，直接以「客观」来源写入在场者记忆。 */
  const [objectiveMode, setObjectiveMode] = useState(false)
  /** 输入条左侧 ⋯ 菜单（前往地点 / 客观注入）。 */
  const [composerMenu, setComposerMenu] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await getJson<Snapshot>(`/api/group/${encodeURIComponent(group)}`)
      cacheSnapshot(group, s) // 下次进入先展示旧快照，避免"加载中"闪屏
      // 中途重进/收尾时快照里已有真实用户消息：撤下乐观回显，避免同一条消息显示两遍
      const t = getTurn(group)
      const lastUser = [...s.messages].reverse().find(m => m.role === 'user')
      if (t.pending !== null && lastUser !== undefined && lastUser.text === t.pending.text && lastUser.id > t.pendingBase) {
        turnPatch(group, { pending: null, pendingBase: 0 })
      }
      setSnap(s)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
    try {
      setAfterIds(new Set(await listThinkingAfter(group))) // 只影响长按菜单里的一个入口，失败无所谓
    } catch { /* 忽略：菜单少一项不影响剧情 */ }
    try {
      setUndo(await getUndoState(group)) // 回退按钮的可用状态
    } catch { /* 忽略：按钮保持上一次的状态 */ }
  }, [group, toast])

  useEffect(() => { void refresh() }, [refresh])

  // 注册当前挂载实例的刷新入口（卸载即摘除）；流结束时按它刷新"现在看得见的页面"
  useEffect(() => {
    activeRefresh.set(group, refresh)
    return () => { if (activeRefresh.get(group) === refresh) activeRefresh.delete(group) }
  }, [group, refresh])

  // 头像可能刚在聊天信息页里换过——每次回到本页都轻量重验一次
  useEffect(() => { setAvatarV(v => v + 1) }, [group])

  // 键盘处理（极简）：页面被键盘压缩时，输入框作为普通文档流元素天然贴在压缩后的底部，
  // 不做任何位移；这里只负责两点——防浏览器把整页上推露出底色、键盘弹起时贴住消息底部。
  useEffect(() => {
    const onViewport = (): void => {
      if (document.documentElement.scrollTop > 0 || document.body.scrollTop > 0) {
        window.scrollTo(0, 0)
        document.body.scrollTop = 0
      }
      if (pinned.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
    }
    const vv = window.visualViewport
    vv?.addEventListener('resize', onViewport)
    vv?.addEventListener('scroll', onViewport)
    window.addEventListener('resize', onViewport)
    return () => {
      vv?.removeEventListener('resize', onViewport)
      vv?.removeEventListener('scroll', onViewport)
      window.removeEventListener('resize', onViewport)
    }
  }, [])

  // 新内容贴底：仅当用户本来就在底部（不抢上翻查看历史的滚动位置）。
  // 必须用 useLayoutEffect（绘制前同步执行）：useEffect 在绘制后才跑，移动端首帧会
  // 露出未滚动的列表顶部、再跳到底部（长对话 DOM 大、帧时序慢时肉眼可见）。
  useLayoutEffect(() => {
    const el = scroller.current
    if (el === null || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [snap, turn.msgs, turn.pending, turn.rerollId])

  const onScroll = useCallback((): void => {
    const el = scroller.current
    if (el === null) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  const run = useCallback(async (path: string, body: Record<string, string | boolean>): Promise<void> => {
    turnBegin(group) // 忙 + 清空上轮暂存（状态写进模块级 store，离开页面也不丢）
    try {
      const res = await postStream(group, path, body)
      await readNdjson(res, (ev: Ev) => {
        if (ev.type === 'speaker') turnSpeaker(group, ev.name)
        else if (ev.type === 'delta') turnDelta(group, ev.text)
        else if (ev.type === 'route') turnSetStatus(group, `── ${ev.picked} 接话（${ev.reason}）${ev.fallback ? '〔降级〕' : ''}`)
        else if (ev.type === 'reply') turnReplyDone(group)
        else if (ev.type === 'ledger') turnSetStatus(group, `〔记账〕${ev.text}`)
        else if (ev.type === 'info' && ev.text !== '总管判断谁接话…') turnSetStatus(group, ev.text) // 判定等待提示不展示（乐观回显已覆盖这段空窗）
      })
    } catch (e) {
      turnPatch(group, { pending: null }) // 发送失败：乐观气泡立刻撤下
      toast(e instanceof Error ? e.message : String(e))
    }
    // 流结束才重拉快照：后台记账/现场所见此刻才落盘（SPEC §7.5）；
    // 快照到位（重掷已改写/新消息已在内）后，同一提交里撤下乐观气泡、整轮暂存与重掷隐藏——无空窗、无重复。
    // 用"当前挂载实例"的刷新入口：用户中途离开又回来时，旧闭包的 setSnap 已经失效，不能只刷旧实例。
    await (activeRefresh.get(group) ?? refresh)()
    turnEnd(group)
  }, [group, refresh, toast])

  const send = useCallback((): void => {
    const text = input.trim()
    if (text === '' || turn.busy || snap === null) return
    setInput('')
    saveDraft(group, '') // 已发出：草稿清掉，别在重启后复活
    if (textareaRef.current !== null) textareaRef.current.style.height = 'auto'
    pinned.current = true
    const objective = objectiveMode
    turnPatch(group, {
      pending: {
        type: 'msg', id: -1, role: 'user', name: snap.userName || '你', text,
        round: 0, visible_to: 'all', ts: new Date().toISOString(),
        ...(objective ? { objective: true } : {}),
      },
      pendingBase: snap.messages.at(-1)?.id ?? 0,
    })
    const scene = pendingScene
    setPendingScene(null)
    setObjectiveMode(false)
    void run('/message', { text, ...(scene !== null ? { scene } : {}), ...(objective ? { objective: true } : {}) })
  }, [input, turn.busy, snap, run, group, pendingScene, objectiveMode])

  const autoGrow = useCallback((): void => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [])

  // 恢复草稿后按内容撑高输入框（多行草稿只显示一行会看不到全文）
  useLayoutEffect(() => { autoGrow() }, [autoGrow])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 桌面 Enter 发送、Shift+Enter 换行；手机保持系统换行行为
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) {
      e.preventDefault()
      send()
    }
  }, [send])

  const lastCharId = snap === null ? undefined : [...snap.messages].reverse().find(m => m.role === 'character')?.id

  const dirOf = useCallback((name: string): string | undefined =>
    snap?.characters.find(c => c.name === name)?.dirName, [snap])

  const avatarFor = useCallback((name: string, mine: boolean): string | undefined => {
    if (mine) return avatarUrl(group, 'user', avatarV)
    const d = dirOf(name)
    return d === undefined ? undefined : avatarUrl(group, `char:${d}`, avatarV)
  }, [group, dirOf, avatarV])

  const enterSelect = useCallback((first: Msg | null): void => {
    setSelected(first === null ? new Set() : new Set([first.id]))
    setSelectMode(true)
    setMenuMsg(null)
  }, [])

  const togglePicked = useCallback((id: number): void => {
    setSelected(s => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const exitSelect = useCallback((): void => {
    setSelectMode(false)
    setSelected(new Set())
  }, [])

  const batchDelete = useCallback(async (): Promise<void> => {
    setDeleting(true)
    try {
      for (const id of selected) {
        await postJson(`/api/group/${encodeURIComponent(group)}/message/${id}/delete`, {})
      }
      setBatchConfirm(false)
      exitSelect()
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }, [selected, group, refresh, toast, exitSelect])

  const submitEdit = useCallback(async (): Promise<void> => {
    if (editMsg === null) return
    try {
      await postJson(`/api/group/${encodeURIComponent(group)}/message/${editMsg.id}/edit`, { text: editText })
      setEditMsg(null)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [editMsg, editText, group, refresh, toast])

  const submitDelete = useCallback(async (): Promise<void> => {
    if (delMsg === null) return
    try {
      await postJson(`/api/group/${encodeURIComponent(group)}/message/${delMsg.id}/delete`, {})
      setDelMsg(null)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [delMsg, group, refresh, toast])

  /** 复制整段消息文本（剪贴板 API 优先，WebView 里 execCommand 兜底）。 */
  const copyMessage = useCallback((m: Msg): void => {
    const ok = (): void => toast('已复制')
    const fallback = (): void => {
      const ta = document.createElement('textarea')
      ta.value = m.text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy'); ok() } catch { /* 剪贴板不可用 */ } finally { document.body.removeChild(ta) }
    }
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      navigator.clipboard.writeText(m.text).then(ok, fallback)
    } else fallback()
  }, [toast])

  /** 查看思维链（只读）：两段一次取回，弹窗按阶段取其中一段；失败/无记录都有明确提示。 */
  const openThinking = useCallback(async (m: Msg, stage: '循环前' | '循环后'): Promise<void> => {
    setMenuMsg(null)
    setThinkingMsg(m)
    setThinkingStage(stage)
    setThinkingData(null)
    try {
      setThinkingData(await getThinking(group, m.id))
    } catch (e) {
      setThinkingData({ before: '', after: '' })
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [group, toast])
  const thinkingText = thinkingData === null ? null : (thinkingStage === '循环前' ? thinkingData.before : thinkingData.after)

  /** 回退按钮：本轮还在生成 / 后台还在写 / 没有快照时都不可点。 */
  const canUndo = undo?.can === true && !turn.busy
  // 后台写完之前按钮是灰的：隔一会儿再问一次，写完自动恢复可点
  useEffect(() => {
    if (undo === null || undo.can || !undo.pending || turn.busy) return
    const t = window.setTimeout(() => { void getUndoState(group).then(setUndo).catch(() => undefined) }, 1500)
    return () => window.clearTimeout(t)
  }, [undo, turn.busy, group])

  /** 回退最近一轮（SPEC §1.4）：整份还原剧情状态；把你那句话填回输入框，改完可直接重发。 */
  const doUndo = useCallback(async (): Promise<void> => {
    setUndoConfirm(false)
    try {
      const r = await postJson<{ ok: boolean; text?: string; remaining: number }>(`/api/group/${encodeURIComponent(group)}/undo`, {})
      clearGroupRowsCache() // 主页预览（最后一条消息）已变
      await refresh()
      const text = r.text ?? ''
      if (text !== '') { setInput(text); saveDraft(group, text) }
      toast('已回退到这一轮开始前')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [group, refresh, toast])

  return (
    <div className="page chat-page page-enter">
      <NavBar
        title={group}
        onBack={onBack}
        right={(
          <>
            <button
              className="navbar-btn" disabled={!canUndo}
              onClick={() => setUndoConfirm(true)} aria-label="回退这一轮"
            >
              <Undo2 size={21} />
            </button>
            <button className="navbar-btn" onClick={onOpenInfo} aria-label="聊天信息"><Ellipsis size={22} /></button>
          </>
        )}
      />
      <div className="scroll chat-scroll" ref={scroller} onScroll={onScroll}>
        {snap === null && <div className="empty">加载中……</div>}
        {snap !== null && snap.messages.length === 0 && turn.msgs.length === 0 && turn.pending === null && (
          <div className="empty">还没有消息——在下面说第一句吧</div>
        )}
        {snap?.messages.map(m => {
          if (m.id === turn.rerollId) return null // 重掷中：旧回复暂隐（引擎将在原 id 上改写）
          const mine = m.role === 'user'
          return (
          <MessageRow
            key={m.id}
            msg={m} mine={mine} avatar={avatarFor(m.name, mine)} scope={group}
            onMenu={setMenuMsg}
            onAvatar={selectMode ? undefined : openAvatar}
            selectMode={selectMode}
            picked={selected.has(m.id)}
            onToggle={togglePicked}
          />
          )
        })}
        {turn.pending !== null && (
          <MessageRow
            msg={turn.pending} mine avatar={avatarFor(turn.pending.name, true)} scope={group}
            onMenu={m => { if (m.id >= 0) setMenuMsg(m) }}
            onAvatar={openAvatar}
            selectMode={false} picked={false} onToggle={() => undefined}
          />
        )}
        {turn.msgs.map(tm => (
          <div className="msg-row in" key={tm.key}>
            <TapAvatar name={tm.name} url={avatarFor(tm.name, false)} size={40} onTap={url => openAvatar(tm.name, url)} />
            <div className="msg-main">
              <div className="msg-name">{tm.name}</div>
              <div className="bubble">
                {tm.text === '' && !tm.done
                  ? <span className="typing" aria-label="正在输入"><i /><i /><i /></span>
                  : <>{applyRules(tm.text, group)}{!tm.done && <span className="cursor" />}</>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        {selectMode ? (
          <div className="batch-bar">
            <button onClick={exitSelect}>取消</button>
            <span className="spacer" />
            <button className="del" disabled={selected.size === 0 || deleting} onClick={() => setBatchConfirm(true)}>
              {deleting ? '删除中…' : `删除（${selected.size}）`}
            </button>
          </div>
        ) : (
          <>
            {turn.status !== '' && <div className="composer-status">{turn.status}</div>}
            {turn.status === '' && pendingScene !== null && <div className="composer-status">本轮将前往：{pendingScene}</div>}
            <div className="composer-bar">
              <button
                className={'composer-btn' + (pendingScene !== null || objectiveMode ? ' armed' : '')}
                aria-label={objectiveMode ? '取消客观注入' : pendingScene !== null ? '取消前往地点' : '插入'}
                disabled={turn.busy}
                onClick={() => {
                  if (objectiveMode) { setObjectiveMode(false); return }
                  if (pendingScene !== null) { setPendingScene(null); return }
                  setComposerMenu(true)
                }}
              >
                {objectiveMode ? <ArrowDownToLine size={20} /> : pendingScene !== null ? <MapPin size={20} /> : <Ellipsis size={20} />}
              </button>
              <textarea
                ref={textareaRef}
                className="composer-input"
                rows={1}
                value={input}
                disabled={turn.busy}
                placeholder={turn.busy ? '生成中……' : objectiveMode ? '输入要注入的客观内容……' : '对大家说……'}
                onChange={e => { setInput(e.target.value); saveDraft(group, e.target.value); autoGrow() }}
                onKeyDown={onKeyDown}
              />
              <button className="composer-send" disabled={turn.busy || input.trim() === ''} onClick={send}>发送</button>
            </div>
          </>
        )}
      </div>

      {/* ⋯ 插入菜单：前往地点（⊘ 手选）/ 客观注入 */}
      <Modal open={composerMenu} onClose={() => setComposerMenu(false)}>
        <button className="menu-item" onClick={() => { setComposerMenu(false); setScenePick(true) }}>
          <MapPin size={18} /> 前往地点
        </button>
        <button className="menu-item" onClick={() => { setComposerMenu(false); setPendingScene(null); setObjectiveMode(true) }}>
          <ArrowDownToLine size={18} /> 客观注入
        </button>
        {objectiveMode && (
          <button className="menu-item" style={{ color: 'var(--danger)' }} onClick={() => { setComposerMenu(false); setObjectiveMode(false) }}>
            <X size={18} /> 取消客观注入
          </button>
        )}
      </Modal>

      {/* ⊘ 场景手选（悬浮）：选中的场景随本轮发送生效——跳过换场景判定，直接按"是"处理 */}
      <Modal open={scenePick} onClose={() => setScenePick(false)} title="前往哪个场景？">
        {(snap?.scenes ?? []).map(s => (
          <button key={s.name} className="menu-item" onClick={() => { setPendingScene(s.name); setObjectiveMode(false); setScenePick(false) }}>
            <MapPin size={18} /> {s.name}{snap?.scene === s.name ? '（当前）' : ''}
          </button>
        ))}
        {(snap?.scenes.length ?? 0) === 0 && <div className="hint">（还没有场景——到聊天信息的「场景」里创建）</div>}
        {pendingScene !== null && (
          <button className="menu-item" style={{ color: 'var(--danger)' }} onClick={() => { setPendingScene(null); setScenePick(false) }}>
            <X size={18} /> 取消前往（{pendingScene}）
          </button>
        )}
      </Modal>

      {/* 长按菜单（悬浮） */}
      <Modal open={menuMsg !== null} onClose={() => setMenuMsg(null)} title={menuMsg === null ? '' : `${menuMsg.name} 的消息`}>
        <button className="menu-item" onClick={() => { setEditText(menuMsg?.text ?? ''); setEditMsg(menuMsg); setMenuMsg(null) }}>
          <Pencil size={18} /> 修改
        </button>
        <button className="menu-item" onClick={() => { if (menuMsg !== null) copyMessage(menuMsg); setMenuMsg(null) }}>
          <Copy size={18} /> 复制
        </button>
        {menuMsg !== null && menuMsg.role === 'character' && (
          <button className="menu-item" onClick={() => { void openThinking(menuMsg, '循环前') }}>
            <Lightbulb size={18} /> 查看循环前思维链
          </button>
        )}
        {menuMsg !== null && menuMsg.role === 'character' && afterIds.has(menuMsg.id) && (
          <button className="menu-item" onClick={() => { void openThinking(menuMsg, '循环后') }}>
            <Lightbulb size={18} /> 查看循环后思维链
          </button>
        )}
        <button className="menu-item" onClick={() => { setDelMsg(menuMsg); setMenuMsg(null) }}>
          <Trash2 size={18} /> 删除
        </button>
        <button className="menu-item" onClick={() => enterSelect(menuMsg)}>
          <CheckSquare size={18} /> 批量删除
        </button>
        {/* 生成中不允许重掷：再开一条流会与当前轮次写同一份日志 */}
        {menuMsg !== null && menuMsg.id === lastCharId && !turn.busy && (
          <button className="menu-item" onClick={() => { turnPatch(group, { rerollId: menuMsg.id }); setMenuMsg(null); void run('/roll', {}) }}>
            <RefreshCw size={18} /> 重掷这条回复
          </button>
        )}
      </Modal>

      {/* 编辑（悬浮） */}
      <Modal open={editMsg !== null} onClose={() => setEditMsg(null)} title={`修改 ${editMsg?.name ?? ''} 的消息`}>
        <div className="field">
          <textarea
            className="field-input" rows={6} value={editText}
            onChange={e => setEditText(e.target.value)}
          />
        </div>
        <div style={{ padding: '0 var(--s-4) var(--s-2)' }}>
          <button className="btn-primary" style={{ width: '100%', margin: 0 }} disabled={editText.trim() === ''} onClick={() => void submitEdit()}>保存</button>
        </div>
      </Modal>

      {/* 思维链（只读悬浮）：该条角色消息生成时的思考内容——只给人看，不进记忆、任何角色不可见 */}
      <Modal open={thinkingMsg !== null} onClose={() => setThinkingMsg(null)}
        title={thinkingMsg === null ? '' : `${thinkingMsg.name} 的思维链（${thinkingStage}）`}>
        {thinkingText === null && <div className="hint">加载中……</div>}
        {thinkingText !== null && (
          thinkingText.trim() === ''
            ? <div className="hint">{thinkingStage === '循环前' ? '（这条发言没有记录到思维链——模型未输出思考内容）' : '（这条发言没有经过改稿——判定未命中任何规则）'}</div>
            : <div className="thinking-body">{thinkingText}</div>
        )}
      </Modal>

      {/* 头像查看（只读悬浮）：点消息头像放大看图；未设置头像的消息没有此入口 */}
      <Modal open={viewAvatar !== null} onClose={() => setViewAvatar(null)} title={viewAvatar === null ? '' : `${viewAvatar.name} 的头像`}>
        {viewAvatar !== null && <img className="avatar-view" src={viewAvatar.url} alt={viewAvatar.name} />}
      </Modal>

      {/* 回退确认（SPEC §1.4）：整轮回滚，动作不可再恢复 */}
      <Confirm
        open={undoConfirm}
        text="回退到这一轮开始之前？这一轮的对话、场景、记忆、状态账本与任务书都会回滚（角色资料与你的设定不受影响）。"
        okText="回退"
        onOk={() => void doUndo()}
        onClose={() => setUndoConfirm(false)}
      />

      {/* 删除确认：文案按 SPEC 必须说明是物理删除 */}
      <Confirm
        open={delMsg !== null}
        text="删除这条消息？它将从上下文和所有角色的记忆中移除，日志不保留原文。"
        onOk={() => void submitDelete()}
        onClose={() => setDelMsg(null)}
      />
      <Confirm
        open={batchConfirm}
        text={`删除选中的 ${selected.size} 条消息？它们将从上下文和所有角色的记忆中移除，日志不保留原文。`}
        okText="删除"
        onOk={() => void batchDelete()}
        onClose={() => setBatchConfirm(false)}
      />
    </div>
  )
}

/** 可点按的头像：设了图片时点击放大查看（未设置 = 首字色块，无图可看，不可点）。
 *  注意"不可点"（批量删除模式禁用查看）与"无图"是两回事——不可点也要照常显示图片。 */
function TapAvatar({ name, url, size, onTap }: { name: string; url: string | undefined; size: number; onTap?: (url: string) => void }): React.ReactElement {
  if (url === undefined) return <Avatar name={name} size={size} />
  if (onTap === undefined) return <Avatar name={name} size={size} url={url} />
  return (
    <button className="avatar-btn" aria-label={`查看 ${name} 的头像`} onClick={e => { e.stopPropagation(); onTap(url) }}>
      <Avatar name={name} size={size} url={url} />
    </button>
  )
}

/** 单条消息行（hooks 必须在组件里调用，不能在 map 循环里）。
 *  memo：流式输出只重绘变化的那一行，历史消息不跟着每个 token 重渲染。 */
const MessageRow = memo(function MessageRow({ msg, mine, avatar, scope, onMenu, onAvatar, selectMode, picked, onToggle }: {
  msg: Msg
  mine: boolean
  avatar: string | undefined
  /** 显示层正则的作用域（群名）：全局规则 + 本群独立规则叠加。 */
  scope: string
  onMenu: (m: Msg) => void
  onAvatar?: (name: string, url: string) => void
  selectMode: boolean
  picked: boolean
  onToggle: (id: number) => void
}): React.ReactElement {
  const lp = useLongPress(() => { if (!selectMode) onMenu(msg) })
  return (
    <div
      className={'msg-row ' + (mine ? 'out' : 'in') + (picked ? ' picked' : '')}
      {...lp}
      onClick={() => { if (selectMode) onToggle(msg.id) }}
    >
      {selectMode && <div className={'check-box sel-box' + (picked ? ' on' : '')}><Check size={16} /></div>}
      <TapAvatar name={msg.name} url={avatar} size={40} onTap={onAvatar === undefined ? undefined : url => onAvatar(msg.name, url)} />
      <div className="msg-main">
        {!mine && <div className="msg-name">{msg.name}</div>}
        {/* 显示层替换：只改你看到的文字，模型上下文/记忆/判定始终是原文 */}
        <div className="bubble">{msg.objective === true && <span className="obj-tag">[客观注入]</span>}{applyRules(msg.text, scope)}</div>
      </div>
    </div>
  )
})

/* ---------- 输入框草稿（按群聊，跟这台设备走） ---------- */
/**
 * 切到聊天信息页 / 退出聊天页再回来时 ChatView 会整棵卸载，输入框内容随之丢失——
 * 草稿存 localStorage：没发出去的话回来还在（发送成功后清除）。
 */
const DRAFT_KEY = 'groupchat.drafts'

let draftCache: Record<string, string> | null = null

function loadDrafts(): Record<string, string> {
  if (draftCache !== null) return draftCache
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    const obj = raw === null ? null : JSON.parse(raw) as Record<string, string>
    draftCache = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    draftCache = {}
  }
  return draftCache
}

function loadDraft(group: string): string {
  const v = loadDrafts()[group]
  return typeof v === 'string' ? v : ''
}

/** 空串 = 清除该群草稿。写盘失败不影响本次输入（内存里仍生效）。 */
function saveDraft(group: string, text: string): void {
  const m = loadDrafts()
  if (text === '') delete m[group]
  else m[group] = text
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(m)) } catch { /* 私密模式等 */ }
}
