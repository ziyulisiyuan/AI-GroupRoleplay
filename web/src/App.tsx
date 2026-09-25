/**
 * 应用外壳：三 Tab（主页面 / 全局规则 / 模型配置）+ 页面栈（聊天 / 新建群聊）。
 * 主页对齐微信首屏：顶部"主页面"+搜索/添加，群聊一行一条（头像/预览/时间）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { enc, getJson, loadGroupRows, postJson, putJson, type GroupRow, type ModelsInfo } from './api.ts'
import { applyRules, isValidPattern, loadRules, newRuleId, saveRules, type RegexRule } from './regex.ts'
import { Avatar, Cell, Cells, Field, Modal, NavBar, TabBarBar, ToastProvider, useToast } from './ui.tsx'
import { ChatView } from './chat.tsx'
import { InfoRoot } from './groupinfo.tsx'
import { Plus, Search, X } from './icons.tsx'

type Tab = 'home' | 'rules' | 'models'
type View = { k: 'chat'; group: string } | { k: 'newgroup' } | { k: 'info'; group: string }

export function App(): React.ReactElement {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}

function Shell(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('home')
  const [stack, setStack] = useState<View[]>([])
  const top = stack[stack.length - 1]
  const push = (v: View): void => setStack(s => [...s, v])
  const pop = (): void => setStack(s => s.slice(0, -1))
  const openChat = (group: string): void => { setStack([{ k: 'chat', group }]) }

  let body: React.ReactElement
  if (top === undefined) {
    body = (
      <div className="page">
        {tab === 'home' && <HomeView onOpen={openChat} onNew={() => push({ k: 'newgroup' })} />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'models' && <ModelsView />}
        <TabBarBar tab={tab} onChange={setTab} />
      </div>
    )
  } else if (top.k === 'chat') {
    body = <ChatView key={top.group} group={top.group} onBack={pop} onOpenInfo={() => push({ k: 'info', group: top.group })} />
  } else if (top.k === 'info') {
    body = <InfoRoot key={top.group} group={top.group} onExit={pop} />
  } else {
    body = <NewGroupView onBack={pop} onCreated={openChat} />
  }
  return <div className="app">{body}</div>
}

/* ---------- Tab 1：主页面（群列表） ---------- */

function listTime(ts: number): string {
  if (ts === 0) return ''
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  const yesterday = new Date(now.getTime() - 86400000)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function HomeView({ onOpen, onNew }: { onOpen: (g: string) => void; onNew: () => void }): React.ReactElement {
  const toast = useToast()
  const [rows, setRows] = useState<GroupRow[] | null>(null)
  const [q, setQ] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await loadGroupRows())
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [toast])
  useEffect(() => { void load() }, [load])

  const shown = rows?.filter(r => q === null || q === '' || r.name.includes(q) || r.preview.includes(q)) ?? null

  return (
    <>
      <NavBar
        title="主页面"
        right={(
          <>
            <button className="navbar-btn" aria-label="搜索" onClick={() => setQ(v => (v === null ? '' : null))}>
              {q === null ? <Search size={21} /> : <X size={21} />}
            </button>
            <button className="navbar-btn" aria-label="新建群聊" onClick={onNew}><Plus size={22} /></button>
          </>
        )}
      />
      {q !== null && (
        <div className="search-row">
          <input autoFocus placeholder="搜索群聊…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      )}
      <div className="scroll">
        {rows === null && <div className="empty">加载中……</div>}
        {rows !== null && rows.length === 0 && (
          <div className="empty">还没有群聊<br />点右上角 ＋ 新建一个</div>
        )}
        <Cells>
          {shown?.map(r => (
            <Cell
              key={r.name}
              avatar={<Avatar name={r.name} size={46} url={`/api/group/${enc(r.name)}/avatar?v=1`} />}
              title={r.name}
              sub={r.preview}
              value={listTime(r.ts)}
              onTap={() => onOpen(r.name)}
            />
          ))}
          {shown !== null && shown.length === 0 && rows !== null && rows.length > 0 && <div className="hint">（没有匹配的群聊）</div>}
        </Cells>
      </div>
    </>
  )
}

/* ---------- Tab 2：全局（二级页：全局规则 / 正则替换） ---------- */

function RulesTab(): React.ReactElement {
  const [view, setView] = useState<'hub' | 'rules' | 'regex'>('hub')
  if (view === 'rules') return <RulesView onBack={() => setView('hub')} />
  if (view === 'regex') return <RegexView onBack={() => setView('hub')} />
  return (
    <>
      <NavBar title="全局" />
      <div className="scroll">
        <Cells>
          <Cell title="全局规则" arrow onTap={() => setView('rules')} />
          <Cell title="正则替换" arrow onTap={() => setView('regex')} />
        </Cells>
      </div>
    </>
  )
}

function RulesView({ onBack }: { onBack: () => void }): React.ReactElement {
  const toast = useToast()
  const [text, setText] = useState<string | null>(null)
  /** 载入时的原文：只有改动过才显示保存键（真机反馈：常驻保存键是噪音） */
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void (async () => {
      try {
        const cur = (await getJson<{ text: string }>('/api/rules')).text
        setText(cur)
        setSaved(cur)
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [toast])
  const dirty = text !== null && saved !== null && text !== saved
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await putJson('/api/rules', { text })
      setSaved(text)
      toast('全局规则已保存（对所有群生效）')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <NavBar
        title="全局规则"
        onBack={onBack}
        right={dirty
          ? <button className="navbar-text-btn" disabled={busy} onClick={() => void save()}>保存</button>
          : undefined}
      />
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column' }}>
        <Cells>
          <Field label="规则正文" value={text ?? ''} onChange={setText} multiline rows={16} placeholder="（空 = 不注入任何规则）" />
        </Cells>
      </div>
    </>
  )
}

/* ---------- 正则替换（显示层：只改你看到的文字，不影响模型与记忆） ---------- */

function RegexView({ onBack }: { onBack: () => void }): React.ReactElement {
  const toast = useToast()
  const [rules, setRules] = useState<RegexRule[]>(() => loadRules())
  const [editing, setEditing] = useState<{ id: string | null; pattern: string; replacement: string; name: string } | null>(null)

  const persist = (next: RegexRule[]): void => {
    setRules(next)
    saveRules(next)
  }

  const submit = (): void => {
    if (editing === null) return
    const pattern = editing.pattern.trim()
    if (pattern === '') {
      toast('匹配内容不能为空')
      return
    }
    if (!isValidPattern(pattern)) {
      toast('正则写法有误，请检查')
      return
    }
    const rule: RegexRule = {
      id: editing.id ?? newRuleId(),
      pattern,
      replacement: editing.replacement,
      name: editing.name.trim() || pattern,
    }
    persist(editing.id === null ? [...rules, rule] : rules.map(r => (r.id === editing.id ? rule : r)))
    setEditing(null)
    toast('已保存（只影响显示）')
  }

  const remove = (): void => {
    if (editing?.id === null || editing === null) return
    persist(rules.filter(r => r.id !== editing.id))
    setEditing(null)
    toast('已删除')
  }

  return (
    <>
      <NavBar title="正则替换" onBack={onBack} />
      <div className="scroll">
        <Cells>
          <button className="cell" onClick={() => setEditing({ id: null, pattern: '', replacement: '', name: '' })}>
            <div className="cell-title"><div className="main" style={{ color: 'var(--brand)' }}>＋ 添加正则</div></div>
          </button>
          {rules.map(r => (
            <button key={r.id} className="cell" onClick={() => setEditing({ id: r.id, pattern: r.pattern, replacement: r.replacement, name: r.name })}>
              <div className="cell-title">
                <div className="main">{r.name}</div>
                <div className="sub">{r.pattern} → {r.replacement === '' ? '（删除）' : r.replacement}</div>
              </div>
            </button>
          ))}
          {rules.length === 0 && <div className="hint">（还没有规则）</div>}
        </Cells>
      </div>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing?.id == null ? '添加正则' : '编辑正则'}>
        <div className="field">
          <div className="field-label">匹配（正则）</div>
          <input className="field-input" value={editing?.pattern ?? ''} placeholder="如：tt"
            onChange={e => setEditing(s => (s === null ? s : { ...s, pattern: e.target.value }))} />
        </div>
        <div className="field">
          <div className="field-label">替换为</div>
          <input className="field-input" value={editing?.replacement ?? ''} placeholder="如：你好（留空 = 删掉匹配到的内容）"
            onChange={e => setEditing(s => (s === null ? s : { ...s, replacement: e.target.value }))} />
        </div>
        <div className="field">
          <div className="field-label">正则命名</div>
          <input className="field-input" value={editing?.name ?? ''} placeholder="如：口令替换"
            onChange={e => setEditing(s => (s === null ? s : { ...s, name: e.target.value }))} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-2)', padding: '0 var(--s-4) var(--s-2)' }}>
          <button className="btn-plain" style={{ flex: 1, width: 'auto', margin: 0 }} onClick={() => setEditing(null)}>取消</button>
          <button className="btn-primary" style={{ flex: 1, width: 'auto', margin: 0 }} onClick={submit}>保存</button>
        </div>
        {editing?.id != null && (
          <div style={{ padding: '0 var(--s-4) var(--s-3)' }}>
            <button style={{ color: 'var(--danger)', fontSize: 'var(--fs-sub)' }} onClick={remove}>删除这条规则</button>
          </div>
        )}
      </Modal>
    </>
  )
}

/* ---------- Tab 3：模型配置 ----------
   两段式极简布局（用户决定）：
   - 模型：自定义对话提供方——密钥 + 可展开的「自定义设置」（API 地址 / 模型 ID）+ 一个保存键；
   - 总管快速判断（可选）：只给一个密钥框。填入正确密钥即启用 Jev 快路径（地址/模型固定，不让用户配）；
     留空则保持未启用，引擎按设计自动回退"完整总管"（角色模型代偿）。
   概念边界：Jev 是 TypeSafe SystemOne 判定模型（不生成文本），永远不当角色模型。 */

function ModelsView(): React.ReactElement {
  const toast = useToast()
  const [info, setInfo] = useState<ModelsInfo | null>(null)
  const [openCustom, setOpenCustom] = useState(false)
  const [draft, setDraft] = useState({ baseUrl: '', model: '', apiKey: '' })
  const [jevKey, setJevKey] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setInfo(await getJson<ModelsInfo>('/api/models'))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [toast])
  useEffect(() => { void load() }, [load])

  const providers = info?.providers ?? []
  const isJev = (p: ModelsInfo['providers'][number]): boolean =>
    /jev/i.test(p.model) || /inferera/i.test(p.baseUrl) || p.id === info?.routerId
  /** 角色模型 = activeId 指向的提供方；若指向的是 Jev（异常配置）则退回第一个非 Jev。 */
  const activeRaw = providers.find(p => p.id === info?.activeId)
  const active = activeRaw !== undefined && !isJev(activeRaw) ? activeRaw : providers.find(p => !isJev(p))
  /** 快速判断用的 Jev 提供方（含"已配置但未启用"的情形）。 */
  const jevProvider = providers.find(isJev)
  const routerEnabled = jevProvider !== undefined && info?.routerId === jevProvider.id

  /** 展开自定义设置：预填当前生效值，密钥留空（不回显既有密钥）。 */
  const openEditor = (): void => {
    setDraft({ baseUrl: active?.baseUrl ?? 'https://api.deepseek.com', model: active?.model ?? 'deepseek-flash', apiKey: '' })
    setOpenCustom(true)
  }

  const saveCustom = async (): Promise<void> => {
    if (draft.baseUrl.trim() === '' || draft.model.trim() === '') {
      toast('API 地址与模型 ID 必填')
      return
    }
    if (active === undefined && draft.apiKey.trim() === '') {
      toast('首次配置需要填入 API 密钥')
      return
    }
    setBusy(true)
    try {
      if (active !== undefined) {
        await putJson(`/api/models/${enc(active.id)}`, {
          baseUrl: draft.baseUrl.trim(), model: draft.model.trim(),
          ...(draft.apiKey.trim() === '' ? {} : { apiKey: draft.apiKey.trim() }),
        })
        toast('已保存')
      } else {
        const created = await postJson<{ ok: boolean; id: string }>('/api/models', {
          name: '自定义', baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKey: draft.apiKey.trim(),
        })
        await postJson(`/api/models/${enc(created.id)}/activate`, {})
        toast('已保存并启用')
      }
      setOpenCustom(false)
      setDraft({ baseUrl: '', model: '', apiKey: '' })
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 填入密钥即启用快速判断：不存在 Jev 提供方则按固定参数创建。地址/模型不让用户操心。 */
  const enableRouter = async (): Promise<void> => {
    const key = jevKey.trim()
    if (key === '') {
      toast('填入 Jev 密钥即可启用')
      return
    }
    setBusy(true)
    try {
      let id = jevProvider?.id
      if (id === undefined) {
        const created = await postJson<{ ok: boolean; id: string }>('/api/models', {
          name: 'Jev（AIHubMix 中转）', baseUrl: 'https://api.inferera.com', model: 'jev-latest',
          apiKey: key, reasoningEffort: 'off',
        })
        id = created.id
      } else {
        await putJson(`/api/models/${enc(id)}`, { apiKey: key })
      }
      await putJson('/api/models/router', { id })
      setJevKey('')
      toast('快速判断已启用')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const disableRouter = async (): Promise<void> => {
    try {
      await putJson('/api/models/router', { id: '' })
      toast('已停用，改用完整总管')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <NavBar title="模型配置" />
      <div className="scroll">
        <Cells>
          <Cell title="模型" />
          <Cell
            title={active === undefined ? '自定义（未配置）' : '自定义'}
            sub={active === undefined ? '填写 API 地址与模型 ID 后启用' : `${active.model} · ${active.baseUrl}`}
            arrow
            onTap={() => (openCustom ? setOpenCustom(false) : openEditor())}
          />
          {openCustom && (
            <>
              <Field label="API 密钥" type="password" value={draft.apiKey}
                placeholder={active === undefined ? 'sk-…' : '已配置——输入新值可替换'}
                onChange={v => setDraft(d => ({ ...d, apiKey: v }))} />
              <Field label="API 地址" value={draft.baseUrl} placeholder="https://api.deepseek.com"
                onChange={v => setDraft(d => ({ ...d, baseUrl: v }))} />
              <Field label="模型 ID" value={draft.model} placeholder="deepseek-flash"
                onChange={v => setDraft(d => ({ ...d, model: v }))} />
            </>
          )}
        </Cells>
        {openCustom && (
          <button className="btn-primary" disabled={busy} onClick={() => void saveCustom()}>
            {busy ? '保存中…' : '保存'}
          </button>
        )}

        <Cells>
          <Cell
            title="总管快速判断（可选）"
            sub={routerEnabled ? '已启用 Jev 快路径' : '不填则用上面模型代偿（完整总管）'}
          />
          <div className="mem-add">
            <input
              type="password"
              placeholder={jevProvider === undefined ? '填入 Jev 密钥即启用' : '已配置——输入新值可替换'}
              value={jevKey}
              onChange={e => setJevKey(e.target.value)}
            />
            <button disabled={busy || jevKey.trim() === ''} onClick={() => void enableRouter()}>
              {routerEnabled ? '更新密钥' : '启用'}
            </button>
          </div>
          {routerEnabled && (
            <div className="mem-add">
              <span style={{ flex: 1 }} />
              <button style={{ color: 'var(--text-2)' }} onClick={() => void disableRouter()}>停用快速判断</button>
            </div>
          )}
        </Cells>
      </div>
    </>
  )
}

/* ---------- 新建群聊 ---------- */

function NewGroupView({ onBack, onCreated }: { onBack: () => void; onCreated: (g: string) => void }): React.ReactElement {
  const toast = useToast()
  const [name, setName] = useState('')
  const [era, setEra] = useState('')
  const [world, setWorld] = useState('')
  const [tone, setTone] = useState('')
  /** 地图：场景随群创建；条目点选其一作为开局地点。添加走悬浮弹窗（同正则替换）。 */
  const [scenes, setScenes] = useState<Array<{ name: string; description: string }>>([])
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [active, setActive] = useState('')
  const [busy, setBusy] = useState(false)

  const addScene = (): void => {
    const n = draftName.trim()
    if (n === '') { toast('场景名称不能为空'); return }
    if (scenes.some(s => s.name === n)) { toast('场景重名了'); return }
    setScenes(s => [...s, { name: n, description: draftDesc.trim() }])
    setActive(a => (a === '' ? n : a))
    setDraftName('')
    setDraftDesc('')
    setAdding(false)
  }

  const create = async (): Promise<void> => {
    if (name.trim() === '' || busy) return
    setBusy(true)
    try {
      await postJson<{ ok: boolean; name: string }>('/api/groups', {
        name: name.trim(), era, world, tone, scenes, scene: active,
      })
      onCreated(name.trim())
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="page page-enter">
      <NavBar title="新建群聊" onBack={onBack} />
      <div className="scroll">
        <Cells>
          <Field label="群聊名 *" value={name} onChange={setName} />
          <Field label="时代背景" value={era} onChange={setEra} />
          <Field label="世界观设定" value={world} onChange={setWorld} multiline rows={5} />
          <Field label="总管基调" value={tone} onChange={setTone} multiline rows={2} />
        </Cells>
        <Cells>
          <Cell title="场景" />
          <button className="cell" onClick={() => { setDraftName(''); setDraftDesc(''); setAdding(true) }}>
            <div className="cell-title"><div className="main" style={{ color: 'var(--brand)' }}>＋ 新建场景</div></div>
          </button>
          {scenes.map(s => (
            <button key={s.name} className="cell" onClick={() => setActive(s.name)}>
              <div className="cell-title">
                <div className="main">{s.name}{active === s.name ? '（开局）' : ''}</div>
                {s.description !== '' && <div className="sub">{s.description}</div>}
              </div>
              <button className="mem-del" onClick={e => {
                e.stopPropagation()
                setScenes(list => list.filter(x => x.name !== s.name))
                setActive(a => (a === s.name ? (scenes.find(x => x.name !== s.name)?.name ?? '') : a))
              }}>移除</button>
            </button>
          ))}
        </Cells>
        <button className="btn-primary" disabled={busy || name.trim() === ''} onClick={() => void create()}>创建</button>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="新建场景">
        <div className="field">
          <div className="field-label">场景名称</div>
          <input className="field-input" value={draftName}
            onChange={e => setDraftName(e.target.value)} />
        </div>
        <div className="field">
          <div className="field-label">场景描述</div>
          <textarea className="field-input" rows={4} value={draftDesc}
            onChange={e => setDraftDesc(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-2)', padding: '0 var(--s-4) var(--s-2)' }}>
          <button className="btn-plain" style={{ flex: 1, width: 'auto', margin: 0 }} onClick={() => setAdding(false)}>取消</button>
          <button className="btn-primary" style={{ flex: 1, width: 'auto', margin: 0 }} onClick={addScene}>保存</button>
        </div>
      </Modal>
    </div>
  )
}
