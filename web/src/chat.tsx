/**
 * 聊天页（微信气泡流）：
 * - 聊天栏只有消息与流式文本（SPEC §7.5 决策）；route/ledger/info = 输入框上方瞬态单行状态。
 * - 键盘顶起/回落：visualViewport 驱动 --kb，composer translateY(-var(--kb))，0.18s 同一条
 *   缓动——本页唯一被要求"仔细打磨"的动效，只动 transform。
 * - 消息操作走长按（桌面右键等效）：编辑 / 重掷（仅最后一条角色消息）/ 删除（物理删除，
 *   确认文案按 SPEC 必须说明日志不保留原文）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { avatarUrl, getJson, postJson, postStream, readNdjson, type Ev, type Msg, type Snapshot } from './api.ts'
import { applyRules } from './regex.ts'
import { Avatar, Confirm, Modal, NavBar, useLongPress, useToast } from './ui.tsx'
import { Check, CheckSquare, Ellipsis, MapPin, Pencil, RefreshCw, Trash2, X } from './icons.tsx'

interface Props { group: string; onBack: () => void; onOpenInfo: () => void }

export function ChatView({ group, onBack, onOpenInfo }: Props): React.ReactElement {
  const toast = useToast()
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [avatarV, setAvatarV] = useState(0)
  const [status, setStatus] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [menuMsg, setMenuMsg] = useState<Msg | null>(null)
  const [editMsg, setEditMsg] = useState<Msg | null>(null)
  const [editText, setEditText] = useState('')
  const [delMsg, setDelMsg] = useState<Msg | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** 乐观回显：引擎在 Jev 判定通过后才落盘用户消息（SPEC §1.1），本地先挂同款气泡，快照刷新后撤下。 */
  const [pending, setPending] = useState<Msg | null>(null)
  /** 本轮对话暂存（speaker 追加 / delta 填充 / reply 标记完成不删除）——接力 A>B>C 期间顺序单调，快照刷新后整体替换。 */
  const [turnMsgs, setTurnMsgs] = useState<Array<{ key: number; name: string; text: string; done: boolean }>>([])
  const turnKey = useRef(0)
  /** 重掷进行中：被重掷的旧回复（引擎在原 id 上物理改写）在快照刷新前先从列表隐藏，避免新旧同屏。 */
  const [rerollId, setRerollId] = useState<number | null>(null)
  /** ⊘ 场景手选：弹窗挑选后，本轮发送直接按"已移动到该场景"处理（跳过换场景判定）。 */
  const [scenePick, setScenePick] = useState(false)
  const [pendingScene, setPendingScene] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnap(await getJson<Snapshot>(`/api/group/${encodeURIComponent(group)}`))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [group, toast])

  useEffect(() => { void refresh() }, [refresh])

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

  // 新内容贴底：仅当用户本来就在底部（不抢上翻查看历史的滚动位置）
  useEffect(() => {
    const el = scroller.current
    if (el === null || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [snap, pending, turnMsgs, rerollId])

  const onScroll = useCallback((): void => {
    const el = scroller.current
    if (el === null) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  const run = useCallback(async (path: string, body: Record<string, string>): Promise<void> => {
    setBusy(true)
    setTurnMsgs([]) // 新一轮：清空上轮暂存
    try {
      const res = await postStream(group, path, body)
      await readNdjson(res, (ev: Ev) => {
        if (ev.type === 'speaker') {
          const key = ++turnKey.current
          setTurnMsgs(t => [...t, { key, name: ev.name, text: '', done: false }])
          setStatus('')
        }
        else if (ev.type === 'delta') setTurnMsgs(t => { if (t.length === 0) return t; const c = t.slice(); const last = c[c.length - 1]!; c[c.length - 1] = { ...last, text: last.text + ev.text }; return c })
        else if (ev.type === 'route') setStatus(`── ${ev.picked} 接话（${ev.reason}）${ev.fallback ? '〔降级〕' : ''}`)
        else if (ev.type === 'reply') setTurnMsgs(t => { if (t.length === 0) return t; const c = t.slice(); const last = c[c.length - 1]!; c[c.length - 1] = { ...last, done: true }; return c })
        else if (ev.type === 'ledger') setStatus(`〔记账〕${ev.text}`)
        else if (ev.type === 'info' && ev.text !== '总管判断谁接话…') setStatus(ev.text) // 判定等待提示不展示（乐观回显已覆盖这段空窗）
      })
    } catch (e) {
      setPending(null) // 发送失败：乐观气泡立刻撤下
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
    // 流结束才重拉快照：后台记账/现场所见此刻才落盘（SPEC §7.5）；
    // 快照到位（重掷已改写/新消息已在内）后，同一提交里撤下乐观气泡、整轮暂存与重掷隐藏——无空窗、无重复。
    await refresh()
    setTurnMsgs([])
    setPending(null)
    setRerollId(null)
  }, [group, refresh, toast])

  const send = useCallback((): void => {
    const text = input.trim()
    if (text === '' || busy || snap === null) return
    setInput('')
    if (textareaRef.current !== null) textareaRef.current.style.height = 'auto'
    pinned.current = true
    setPending({
      type: 'msg', id: -1, role: 'user', name: snap.userName || '你', text,
      round: 0, visible_to: 'all', ts: new Date().toISOString(),
    })
    const scene = pendingScene
    setPendingScene(null)
    void run('/message', { text, ...(scene !== null ? { scene } : {}) })
  }, [input, busy, snap, run, pendingScene])

  const autoGrow = useCallback((): void => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [])

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

  return (
    <div className="page chat-page page-enter">
      <NavBar
        title={group}
        onBack={onBack}
        right={<button className="navbar-btn" onClick={onOpenInfo} aria-label="聊天信息"><Ellipsis size={22} /></button>}
      />
      <div className="scroll chat-scroll" ref={scroller} onScroll={onScroll}>
        {snap === null && <div className="empty">加载中……</div>}
        {snap !== null && snap.messages.length === 0 && turnMsgs.length === 0 && pending === null && (
          <div className="empty">还没有消息——在下面说第一句吧</div>
        )}
        {snap?.messages.map(m => {
          if (m.id === rerollId) return null // 重掷中：旧回复暂隐（引擎将在原 id 上改写）
          const mine = m.role === 'user'
          return (
            <MessageRow
              key={m.id}
              msg={m} mine={mine} avatar={avatarFor(m.name, mine)}
              onMenu={setMenuMsg}
              selectMode={selectMode}
              picked={selected.has(m.id)}
              onToggle={togglePicked}
            />
          )
        })}
        {pending !== null && (
          <MessageRow
            msg={pending} mine avatar={avatarFor(pending.name, true)}
            onMenu={m => { if (m.id >= 0) setMenuMsg(m) }}
            selectMode={false} picked={false} onToggle={() => undefined}
          />
        )}
        {turnMsgs.map(tm => (
          <div className="msg-row in" key={tm.key}>
            <Avatar name={tm.name} size={40} url={avatarFor(tm.name, false)} />
            <div className="msg-main">
              <div className="msg-name">{tm.name}</div>
              <div className="bubble">{applyRules(tm.text)}{!tm.done && <span className="cursor" />}</div>
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
            {status !== '' && <div className="composer-status">{status}</div>}
            {status === '' && pendingScene !== null && <div className="composer-status">本轮将前往：{pendingScene}</div>}
            <div className="composer-bar">
              <button
                className={'composer-btn' + (pendingScene !== null ? ' armed' : '')}
                aria-label="选择场景" disabled={busy}
                onClick={() => setScenePick(true)}
              >
                <MapPin size={20} />
              </button>
              <textarea
                ref={textareaRef}
                className="composer-input"
                rows={1}
                value={input}
                disabled={busy}
                placeholder={busy ? '生成中……' : '对大家说……'}
                onChange={e => { setInput(e.target.value); autoGrow() }}
                onKeyDown={onKeyDown}
              />
              <button className="composer-send" disabled={busy || input.trim() === ''} onClick={send}>发送</button>
            </div>
          </>
        )}
      </div>

      {/* ⊘ 场景手选（悬浮）：选中的场景随本轮发送生效——不再走换场景判定，直接按"是"处理 */}
      <Modal open={scenePick} onClose={() => setScenePick(false)} title="前往哪个场景？">
        {(snap?.scenes ?? []).map(s => (
          <button key={s.name} className="menu-item" onClick={() => { setPendingScene(s.name); setScenePick(false) }}>
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
        <button className="menu-item" onClick={() => { setDelMsg(menuMsg); setMenuMsg(null) }}>
          <Trash2 size={18} /> 删除
        </button>
        <button className="menu-item" onClick={() => enterSelect(menuMsg)}>
          <CheckSquare size={18} /> 批量删除
        </button>
        {menuMsg !== null && menuMsg.id === lastCharId && (
          <button className="menu-item" onClick={() => { setRerollId(menuMsg.id); setMenuMsg(null); void run('/roll', {}) }}>
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

/** 单条消息行（hooks 必须在组件里调用，不能在 map 循环里）。 */
function MessageRow({ msg, mine, avatar, onMenu, selectMode, picked, onToggle }: {
  msg: Msg
  mine: boolean
  avatar: string | undefined
  onMenu: (m: Msg) => void
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
      <Avatar name={msg.name} size={40} url={avatar} />
      <div className="msg-main">
        {!mine && <div className="msg-name">{msg.name}</div>}
        {/* 显示层替换：只改你看到的文字，模型上下文/记忆/判定始终是原文 */}
        <div className="bubble">{applyRules(msg.text)}</div>
      </div>
    </div>
  )
}
