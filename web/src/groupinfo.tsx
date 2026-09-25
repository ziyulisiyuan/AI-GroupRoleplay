/**
 * 聊天信息（"···"进入）：微信式设置页 + 六个子页。
 * 页面跳转（内容多、要键盘输入的）而非弹窗——对齐微信原生形态；
 * 内容编辑走居中悬浮弹窗（消息操作在 chat.tsx；账本字段编辑在角色资料页）。
 * 镜像契约（SPEC §7.5）：LEDGER_KEYS 七字段顺序与后端 status.ts 一字不差；
 * 场景只渲染现场勾选（接入/单向感知不显示），absent 不渲染。
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  avatarUrl, delJson, enc, getJson, postJson, putJson,
  type Draft, type JudgeRow, type MemoryEntry, type Snapshot,
} from './api.ts'
import { Avatar, AvatarPicker, Cell, Cells, CheckCell, Field, Modal, NavBar, useToast } from './ui.tsx'
import type { Scene } from './api.ts'

export const LEDGER_KEYS = ['生理状态', '心理状态', '外观状态', '位置状态', '性格演变', '姓名变化', '人物关系变化'] as const

type InfoView =
  | 'hub' | 'settings' | 'me' | 'director' | 'presence' | 'log' | 'scenes'
  | { char: string }                                        // 角色资料收纳页（'' = 新建角色表单）
  | { charSub: string; page: 'profile' | 'memory' | 'ledger' }

const VIEW_TITLES: Record<Exclude<InfoView, { char: string } | { charSub: string; page: 'profile' | 'memory' | 'ledger' }>, string> = {
  hub: '聊天信息', settings: '群聊设定', me: '我的设定', director: '对总管说（纠正）',
  presence: '此时明确现场者', log: '运行日志', scenes: '场景',
}

export function InfoRoot({ group, onExit }: { group: string; onExit: () => void }): React.ReactElement {
  const [stack, setStack] = useState<InfoView[]>(['hub'])
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [avatarV, setAvatarV] = useState(1)
  const toast = useToast()

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnap(await getJson<Snapshot>(`/api/group/${enc(group)}`))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [group, toast])

  useEffect(() => { void refresh() }, [refresh])
  const bump = useCallback((): void => setAvatarV(v => v + 1), [])

  const top = stack[stack.length - 1]
  const push = (v: InfoView): void => setStack(s => [...s, v])
  const pop = (): void => {
    if (stack.length > 1) setStack(s => s.slice(0, -1))
    else onExit()
  }
  const title = typeof top === 'string' ? VIEW_TITLES[top]
    : 'char' in top ? (top.char === '' ? '新建角色' : '角色资料')
      : top.page === 'profile' ? '个人资料' : top.page === 'memory' ? '记忆' : '状态账本'

  return (
    <div className="page page-enter">
      <NavBar title={title} onBack={pop} />
      <div className="scroll">
        {top === 'hub' && <HubView group={group} snap={snap} avatarV={avatarV} bump={bump} go={push} />}
        {top === 'settings' && <SettingsView group={group} snap={snap} onSaved={refresh} />}
        {top === 'me' && <MeView group={group} snap={snap} avatarV={avatarV} bump={bump} onSaved={refresh} />}
        {top === 'director' && <DirectorView group={group} onChanged={refresh} />}
        {top === 'presence' && <PresenceView group={group} snap={snap} onChanged={refresh} />}
        {top === 'log' && <LogView group={group} />}
        {top === 'scenes' && <ScenesView group={group} snap={snap} onChanged={refresh} />}
        {typeof top !== 'string' && 'char' in top && (
          top.char === ''
            ? <CharProfileView key="new" group={group} dirName="" scenes={snap?.scenes ?? []} onChanged={refresh}
                onCreated={name => setStack(s => [...s.slice(0, -1), { char: name }])} />
            : <CharHubView key={top.char} group={group} dirName={top.char} snap={snap} avatarV={avatarV} bump={bump} go={push} />
        )}
        {typeof top !== 'string' && 'page' in top && top.page === 'profile' && (
          <CharProfileView key={`p-${top.charSub}`} group={group} dirName={top.charSub} scenes={snap?.scenes ?? []} onChanged={refresh} />
        )}
        {typeof top !== 'string' && 'page' in top && top.page === 'memory' && (
          <CharMemoryView key={`m-${top.charSub}`} group={group} dirName={top.charSub} />
        )}
        {typeof top !== 'string' && 'page' in top && top.page === 'ledger' && (
          <CharLedgerView
            key={`l-${top.charSub}`} group={group} dirName={top.charSub}
            name={snap?.characters.find(c => c.dirName === top.charSub)?.name ?? top.charSub}
          />
        )}
      </div>
    </div>
  )
}

/* ---------- 聊天信息（首页） ---------- */

function HubView({ group, snap, avatarV, bump, go }: {
  group: string
  snap: Snapshot | null
  avatarV: number
  bump: () => void
  go: (v: InfoView) => void
}): React.ReactElement {
  return (
    <>
      <div className="info-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)' }}>
          <AvatarPicker
            name={group} size={64}
            url={avatarUrl(group, 'group', avatarV)}
            upload={async blob => { await putBytesAvatar(`/api/group/${enc(group)}/avatar`, blob); bump() }}
          />
          <div className="info-top-name">
            <div className="n">{group}</div>
            <div className="e">{snap?.era !== '' ? snap?.era : '（未设置时代背景）'}</div>
          </div>
        </div>
        <div className="member-row">
          {snap?.characters.map(c => (
            <div key={c.dirName} className="member" onClick={() => go({ char: c.dirName })}>
              <Avatar name={c.name} size={44} url={avatarUrl(group, `char:${c.dirName}`, avatarV)} />
              <div className="member-name">{c.name}</div>
            </div>
          ))}
          <div className="member" onClick={() => go('me')}>
            <Avatar name={snap?.userName ?? '我'} size={44} url={avatarUrl(group, 'user', avatarV)} />
            <div className="member-name">我</div>
          </div>
          <div className="member" onClick={() => go({ char: '' })}>
            <div className="avatar" style={{ width: 44, height: 44, fontSize: 22, background: 'var(--bg-page)', color: 'var(--text-2)' }}>＋</div>
            <div className="member-name">新建</div>
          </div>
        </div>
      </div>
      <Cells>
        <Cell title="群聊设定" arrow onTap={() => go('settings')} />
        <Cell title="我的设定" arrow onTap={() => go('me')} />
      </Cells>
      <Cells>
        <Cell title="纠正窗口" arrow onTap={() => go('director')} />
        <Cell title="此时明确现场者" arrow onTap={() => go('presence')} />
      </Cells>
      <Cells>
        <Cell title="场景" sub={snap !== null && snap.scene !== '' ? `当前：${snap.scene} · 共 ${snap.scenes.length} 个` : `共 ${snap?.scenes.length ?? 0} 个`} arrow onTap={() => go('scenes')} />
      </Cells>
      <Cells>
        <Cell title="运行日志" arrow onTap={() => go('log')} />
      </Cells>
    </>
  )
}

async function putBytesAvatar(path: string, blob: Blob): Promise<void> {
  const r = await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: blob })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}) as { error?: string }) as { error?: string }
    throw new Error(j.error ?? `HTTP ${r.status}`)
  }
}

/* ---------- 群聊设定 ---------- */

function SettingsView({ group, snap, onSaved }: { group: string; snap: Snapshot | null; onSaved: () => Promise<void> }): React.ReactElement {
  const toast = useToast()
  const [era, setEra] = useState<string | null>(null)
  const [world, setWorld] = useState('')
  const [tone, setTone] = useState('')
  const [initial, setInitial] = useState<{ era: string; world: string; tone: string } | null>(null)
  useEffect(() => {
    if (snap !== null && era === null) {
      setEra(snap.era); setWorld(snap.world); setTone(snap.tone)
      setInitial({ era: snap.era, world: snap.world, tone: snap.tone })
    }
  }, [snap, era])
  const dirty = initial !== null && (era !== initial.era || world !== initial.world || tone !== initial.tone)
  const save = async (): Promise<void> => {
    try {
      await putJson(`/api/group/${enc(group)}/settings`, { era: era ?? '', world, tone })
      setInitial({ era: era ?? '', world, tone })
      toast('群聊设定已保存')
      await onSaved()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <>
      <Cells>
        <Field label="时代背景" value={era ?? ''} onChange={setEra} placeholder="如：架空的大晟王朝末年" />
        <Field label="世界观设定" value={world} onChange={setWorld} multiline rows={6} />
        <Field label="总管基调" value={tone} onChange={setTone} multiline rows={3} />
      </Cells>
      <button className="btn-primary" disabled={era === null || !dirty} onClick={() => void save()}>保存</button>
    </>
  )
}

/* ---------- 我的设定 ---------- */

function MeView({ group, snap, avatarV, bump, onSaved }: {
  group: string; snap: Snapshot | null; avatarV: number; bump: () => void; onSaved: () => Promise<void>
}): React.ReactElement {
  const toast = useToast()
  const [name, setName] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [initial, setInitial] = useState<{ name: string; text: string } | null>(null)
  useEffect(() => {
    if (snap !== null && name === null) {
      void (async () => {
        try {
          const me = await getJson<{ name: string; text: string }>(`/api/group/${enc(group)}/user`)
          setName(me.name)
          setText(me.text)
          setInitial({ name: me.name, text: me.text })
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e))
        }
      })()
    }
  }, [snap, name, group, toast])
  const dirty = initial !== null && (name !== initial.name || text !== initial.text)
  const save = async (): Promise<void> => {
    try {
      await putJson(`/api/group/${enc(group)}/user`, { name: name ?? '', text })
      setInitial({ name: name ?? '', text })
      toast('我的设定已保存')
      await onSaved()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <>
      <div className="info-top" style={{ alignItems: 'center' }}>
        <AvatarPicker
          name={snap?.userName ?? '我'} size={64}
          url={avatarUrl(group, 'user', avatarV)}
          upload={async blob => { await putBytesAvatar(`/api/group/${enc(group)}/user/avatar`, blob); bump() }}
        />
        <div className="info-top-name">
          <div className="n">{snap?.userName ?? '我'}</div>
        </div>
      </div>
      <Cells>
        <Field label="称呼" value={name ?? ''} onChange={setName} placeholder="你" />
        <Field label="你的设定" value={text} onChange={setText} multiline rows={6} />
      </Cells>
      <button className="btn-primary" disabled={name === null || !dirty} onClick={() => void save()}>保存</button>
    </>
  )
}

/* ---------- 纠正窗口 ---------- */

interface DirHistory { text: string; reply: string; applied: string[]; ts: string }

function DirectorView({ group, onChanged }: { group: string; onChanged: () => Promise<void> }): React.ReactElement {
  const toast = useToast()
  const [history, setHistory] = useState<DirHistory[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setHistory((await getJson<{ history: DirHistory[] }>(`/api/group/${enc(group)}/director`)).history.slice().reverse())
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [group, toast])
  useEffect(() => { void load() }, [load])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (text === '' || busy) return
    setBusy(true)
    try {
      await postJson(`/api/group/${enc(group)}/director`, { text })
      setInput('')
      await load()
      await onChanged()
      toast('总管已回应')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="dir-chat">
        {history.map((h, i) => (
          <div key={i}>
            <div className="msg-row out">
              <div className="msg-main"><div className="bubble">{h.text}</div></div>
            </div>
            <div className="msg-row in">
              <div className="msg-main">
                <div className="msg-name">总管</div>
                <div className="bubble">{h.reply}</div>
                {h.applied.length > 0 && <div className="applied">已改：{h.applied.join('；')}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {history.length === 0 && <div className="empty">（还没有对话——发一句试试）</div>}
      <div style={{ height: 'calc(72px + env(safe-area-inset-bottom))' }} />
      <div className="dir-input-bar" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 520, margin: '0 auto' }}>
        <textarea
          placeholder="告诉总管要改什么……"
          value={input}
          onChange={e => setInput(e.target.value)}
        />
        <button disabled={busy || input.trim() === ''} onClick={() => void send()}>{busy ? '总管思考中…' : '发送'}</button>
      </div>
    </>
  )
}

/* ---------- 此时明确现场者 ---------- */

function PresenceView({ group, snap, onChanged }: {
  group: string; snap: Snapshot | null; onChanged: () => Promise<void>
}): React.ReactElement {
  const toast = useToast()
  const [present, setPresent] = useState<Set<string>>(new Set())
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (snap !== null && !ready) { setPresent(new Set(snap.present)); setReady(true) }
  }, [snap, ready])

  const toggle = async (name: string, on: boolean): Promise<void> => {
    const next = new Set(present)
    if (on) next.add(name)
    else next.delete(name)
    setPresent(next)
    try {
      // 只提交现场层；remote/overhear 不传 = 保持现状（后端语义）
      await putJson(`/api/group/${enc(group)}/presence`, { present: [...next] })
      await onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  if (snap === null) return <div className="empty">加载中……</div>
  return (
    <>
      <Cells>
        {snap.characters.map(c => (
          <CheckCell key={c.dirName} on={present.has(c.name)} label={c.name} onToggle={on => void toggle(c.name, on)} />
        ))}
      </Cells>
    </>
  )
}

/* ---------- 场景（地图）：名称一经创建不可改不可删，描述可改；仅用户可写 ---------- */

function ScenesView({ group, snap, onChanged }: {
  group: string; snap: Snapshot | null; onChanged: () => Promise<void>
}): React.ReactElement {
  const toast = useToast()
  const [scenes, setScenes] = useState<Scene[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [editing, setEditing] = useState<Scene | null>(null)
  const [editDesc, setEditDesc] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setScenes((await getJson<{ scenes: Scene[] }>(`/api/group/${enc(group)}/scenes`)).scenes)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [group, toast])
  useEffect(() => { void load() }, [load])

  const add = async (): Promise<void> => {
    if (newName.trim() === '') { toast('场景名称不能为空'); return }
    try {
      await postJson(`/api/group/${enc(group)}/scenes`, { name: newName.trim(), description: newDesc.trim() })
      setNewName(''); setNewDesc('')
      setAdding(false)
      await load()
      await onChanged()
      toast('场景已创建')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const saveDesc = async (): Promise<void> => {
    if (editing === null) return
    try {
      await putJson(`/api/group/${enc(group)}/scenes/${enc(editing.name)}`, { description: editDesc })
      setEditing(null)
      await load()
      await onChanged()
      toast('描述已保存')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  if (scenes === null) return <div className="empty">加载中……</div>
  return (
    <>
      <Cells>
        <button className="cell" onClick={() => { setNewName(''); setNewDesc(''); setAdding(true) }}>
          <div className="cell-title"><div className="main" style={{ color: 'var(--brand)' }}>＋ 添加场景</div></div>
        </button>
        {scenes.length === 0 && <div className="hint">（还没有场景）</div>}
        {scenes.map(s => (
          <button key={s.name} className="cell" onClick={() => { setEditing(s); setEditDesc(s.description) }}>
            <div className="cell-title">
              <div className="main">{s.name}{snap?.scene === s.name ? '（当前）' : ''}</div>
              {s.description !== '' && <div className="sub">{s.description}</div>}
            </div>
          </button>
        ))}
      </Cells>

      <Modal open={adding} onClose={() => setAdding(false)} title="添加场景">
        <div className="field">
          <div className="field-label">场景名称</div>
          <input className="field-input" value={newName}
            onChange={e => setNewName(e.target.value)} />
        </div>
        <div className="field">
          <div className="field-label">场景描述</div>
          <textarea className="field-input" rows={4} value={newDesc}
            onChange={e => setNewDesc(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-2)', padding: '0 var(--s-4) var(--s-2)' }}>
          <button className="btn-plain" style={{ flex: 1, width: 'auto', margin: 0 }} onClick={() => setAdding(false)}>取消</button>
          <button className="btn-primary" style={{ flex: 1, width: 'auto', margin: 0 }} onClick={() => void add()}>保存</button>
        </div>
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={`场景 · ${editing?.name ?? ''}`}>
        <div className="field">
          <div className="field-label">描述</div>
          <textarea className="field-input" rows={6} value={editDesc} onChange={e => setEditDesc(e.target.value)} />
        </div>
        <div style={{ padding: '0 var(--s-4) var(--s-2)' }}>
          <button className="btn-primary" style={{ width: '100%', margin: 0 }} onClick={() => void saveDesc()}>保存</button>
        </div>
      </Modal>
    </>
  )
}

/* ---------- 角色资料：收纳页（头像 + 三入口）与三个子页 ---------- */

const EMPTY_DRAFT: Draft = { name: '', appearance: '', background: '', personality: '', relationships: '', scene: '' }

/** 角色资料收纳页：头像 + 个人资料/记忆/状态账本三个入口。 */
function CharHubView({ group, dirName, snap, avatarV, bump, go }: {
  group: string
  dirName: string
  snap: Snapshot | null
  avatarV: number
  bump: () => void
  go: (v: InfoView) => void
}): React.ReactElement {
  const name = snap?.characters.find(c => c.dirName === dirName)?.name ?? dirName
  return (
    <>
      <div className="info-top">
        <AvatarPicker
          name={name} size={64}
          url={avatarUrl(group, `char:${dirName}`, avatarV)}
          upload={async blob => { await putBytesAvatar(`/api/group/${enc(group)}/character/${enc(dirName)}/avatar`, blob); bump() }}
        />
        <div className="info-top-name">
          <div className="n">{name}</div>
        </div>
      </div>
      <Cells>
        <Cell title="个人资料" arrow onTap={() => go({ charSub: dirName, page: 'profile' })} />
        <Cell title="记忆" arrow onTap={() => go({ charSub: dirName, page: 'memory' })} />
        <Cell title="状态账本" arrow onTap={() => go({ charSub: dirName, page: 'ledger' })} />
      </Cells>
    </>
  )
}

/** 个人资料：五项初始定义（新建模式下即创建表单）。初始所在场景：建角色时从地图选定，此后只显示。 */
function CharProfileView({ group, dirName, scenes, onChanged, onCreated }: {
  group: string
  dirName: string
  scenes: Scene[]
  onChanged: () => Promise<void>
  onCreated?: (name: string) => void
}): React.ReactElement {
  const toast = useToast()
  const isNew = dirName === ''
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  /** 载入快照：只有改动过才可保存（与全局规则页一致的"无改动不打扰"） */
  const [initial, setInitial] = useState<Draft>(EMPTY_DRAFT)
  const [loaded, setLoaded] = useState(isNew)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (isNew) { setLoaded(true); return }
    void (async () => {
      try {
        const d = { ...EMPTY_DRAFT, ...(await getJson<Draft>(`/api/group/${enc(group)}/character/${enc(dirName)}`)) }
        setDraft(d)
        setInitial(d)
        setLoaded(true)
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [group, dirName, isNew, toast])

  const dirty = isNew || JSON.stringify(draft) !== JSON.stringify(initial)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      if (isNew) {
        const name = draft.name.trim()
        await postJson(`/api/group/${enc(group)}/character`, draft)
        toast('角色已创建')
        await onChanged()
        onCreated?.(name)
      } else {
        await putJson(`/api/group/${enc(group)}/character/${enc(dirName)}`, draft)
        setInitial(draft)
        toast('已保存')
        await onChanged()
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return <div className="empty">加载中……</div>
  return (
    <>
      <Cells>
        <Field label="初始姓名 *" value={draft.name} onChange={v => setDraft({ ...draft, name: v })} />
        <Field label="初始外观" value={draft.appearance} onChange={v => setDraft({ ...draft, appearance: v })} multiline rows={3} />
        <Field label="初始背景" value={draft.background} onChange={v => setDraft({ ...draft, background: v })} multiline rows={4} />
        <Field label="初始性格" value={draft.personality} onChange={v => setDraft({ ...draft, personality: v })} multiline rows={3} />
        <Field label="初始人物关系" value={draft.relationships} onChange={v => setDraft({ ...draft, relationships: v })} multiline rows={3} />
      </Cells>
      {isNew && scenes.length > 0 && (
        <Cells>
          <Cell title="初始所在场景" />
          {scenes.map(s => (
            <CheckCell key={s.name} on={draft.scene === s.name} label={s.name}
              onToggle={on => { if (on) setDraft(d => ({ ...d, scene: s.name })) }} />
          ))}
        </Cells>
      )}
      {!isNew && (
        <Cells>
          <Cell title="初始所在场景" sub={draft.scene !== '' ? draft.scene : '（无）'} />
        </Cells>
      )}
      <button className="btn-primary" disabled={busy || !dirty || draft.name.trim() === ''} onClick={() => void save()}>
        {busy ? '保存中…' : isNew ? '创建' : '保存'}
      </button>
    </>
  )
}

/** 记忆：查看/补记/撤回（只影响该角色）。 */
function CharMemoryView({ group, dirName }: { group: string; dirName: string }): React.ReactElement {
  const toast = useToast()
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null)
  const [newMem, setNewMem] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setMemory((await getJson<{ entries: MemoryEntry[] }>(`/api/group/${enc(group)}/character/${enc(dirName)}/memory`)).entries)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [group, dirName, toast])
  useEffect(() => { void load() }, [load])

  const addMem = async (): Promise<void> => {
    if (newMem.trim() === '' || memory === null) return
    try {
      await postJson(`/api/group/${enc(group)}/character/${enc(dirName)}/memory`, { text: newMem })
      setNewMem('')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  const dropMem = async (index: number): Promise<void> => {
    try {
      await delJson(`/api/group/${enc(group)}/character/${enc(dirName)}/memory/${index}`)
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  if (memory === null) return <div className="empty">加载中……</div>
  return (
    <>
      <Cells>
        {memory.length === 0 && <div className="hint">（还没有记忆条目）</div>}
        {memory.map(e => (
          <div key={e.index} className="mem-entry" style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span className="mem-tag">[{e.source}·第{e.round}轮]</span>
              {e.text}
            </div>
            <button className="mem-del" onClick={() => void dropMem(e.index)}>删除</button>
          </div>
        ))}
      </Cells>
      <div className="mem-add">
        <input placeholder="补一条他该知道的事（只影响他）……" value={newMem} onChange={e => setNewMem(e.target.value)} />
        <button disabled={newMem.trim() === ''} onClick={() => void addMem()}>添加</button>
      </div>
    </>
  )
}

/** 状态账本：七字段行 + 点词条弹悬浮窗编辑（单字段 PUT，后端缺省字段保持）。 */
function CharLedgerView({ group, dirName, name }: { group: string; dirName: string; name: string }): React.ReactElement {
  const toast = useToast()
  const [ledger, setLedger] = useState<Record<string, string> | null>(null)
  const [editField, setEditField] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        setLedger((await getJson<{ ledger: Record<string, string> }>(`/api/group/${enc(group)}/character/${enc(dirName)}/ledger`)).ledger)
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [group, dirName, toast])

  const saveField = async (): Promise<void> => {
    if (editField === null) return
    try {
      // 整体快照语义、缺省字段保持：单字段 PUT 即单字段覆盖（后端合并）
      await putJson(`/api/group/${enc(group)}/character/${enc(dirName)}/ledger`, { ledger: { [editField]: editVal } })
      setLedger(s => ({ ...(s ?? {}), [editField]: editVal.trim() }))
      setEditField(null)
      toast('已保存（AI 每轮都会重读）')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  if (ledger === null) return <div className="empty">加载中……</div>
  return (
    <>
      <Cells>
        {LEDGER_KEYS.map(k => {
          const v = ledger[k]?.trim() ?? ''
          return (
            <button
              key={k} className="cell"
              onClick={() => { setEditField(k); setEditVal(ledger[k] ?? '') }}
            >
              <div className="cell-title">
                <div className="main" style={{ fontSize: 'var(--fs-sub)', color: 'var(--text-2)' }}>{k}</div>
                <div className="ledger-val">{v !== '' ? v : '无'}</div>
              </div>
            </button>
          )
        })}
      </Cells>
      <Modal open={editField !== null} onClose={() => setEditField(null)} title={`${name} · ${editField ?? ''}`}>
        <div className="field">
          <textarea
            className="field-input" rows={5} value={editVal}
            onChange={e => setEditVal(e.target.value)}
          />
        </div>
        <div style={{ padding: '0 var(--s-4) var(--s-2)' }}>
          <button className="btn-primary" style={{ width: '100%', margin: 0 }} onClick={() => void saveField()}>保存</button>
        </div>
      </Modal>
    </>
  )
}

/* ---------- 运行日志（判定.jsonl 尾部，只给人看） ---------- */

function judgeSummary(r: JudgeRow): string {
  const parts: string[] = []
  if (typeof r.picked === 'string') parts.push(`${r.picked} 接话`)
  if (typeof r.confidence === 'number') parts.push(`置信${r.confidence}`)
  if (r.phase === '回复判定' && typeof r.speaker === 'string') parts.push(`${r.speaker} 回复后`)
  if (typeof r.relay === 'string') parts.push(`接力→${r.relay}`)
  if (typeof r.subject === 'string') parts.push(String(r.subject))
  if (Array.isArray(r.knows)) parts.push(`知情:${(r.knows as string[]).join('、') || '无'}`)
  if (Array.isArray(r.told) && (r.told as unknown[]).length > 0) parts.push(`转告:${(r.told as string[]).join('、')}`)
  if (r.stateDirty === true) parts.push('持久影响:有')
  if (r.stateDirty === false) parts.push('持久影响:无')
  if (typeof r.character === 'string') parts.push(String(r.character))
  if (Array.isArray(r.candidateRounds)) parts.push(`候选轮:${(r.candidateRounds as number[]).join('、')}`)
  if (Array.isArray(r.granted)) parts.push(`命中轮:${(r.granted as number[]).join('、') || '无'}`)
  if (typeof r.scene === 'string') parts.push(`场景${r.scene}`)
  if (typeof r.note === 'string') parts.push(String(r.note))
  if (typeof r.error === 'string') parts.push(`出错:${String(r.error)}`)
  if (typeof r.elapsedMs === 'number') parts.push(`${r.elapsedMs}ms`)
  return parts.join(' · ')
}

function LogView({ group }: { group: string }): React.ReactElement {
  const toast = useToast()
  const [rows, setRows] = useState<JudgeRow[] | null>(null)
  const load = useCallback(async (): Promise<void> => {
    try {
      setRows((await getJson<{ lines: JudgeRow[] }>(`/api/group/${enc(group)}/judgments`)).lines)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [group, toast])
  useEffect(() => { void load() }, [load])

  return (
    <>
      <div className="mem-add">
        <span style={{ flex: 1 }} />
        <button onClick={() => void load()}>刷新</button>
      </div>
      <div className="cell-group">
        {rows === null && <div className="hint">加载中……</div>}
        {rows !== null && rows.length === 0 && <div className="hint">（还没有记录）</div>}
        {rows?.map((r, i) => (
          <details key={i} className="log-row">
            <summary className="log-head">
              <span className="t">{String(r.ts ?? '').slice(11, 19)}</span>
              <span className="p">{String(r.phase ?? '未知')}</span>
              <span className="s">{judgeSummary(r)}</span>
            </summary>
            <pre>{JSON.stringify(r, null, 2)}</pre>
          </details>
        ))}
      </div>
      <div style={{ height: 'var(--s-4)' }} />
    </>
  )
}
