/**
 * 应用外壳：三 Tab（主页面 / 全局规则 / 模型配置）+ 页面栈（聊天 / 新建群聊）。
 * 主页对齐微信首屏：顶部"主页面"+搜索/添加，群聊一行一条（头像/预览/时间）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { enc, getJson, loadGroupRows, cachedGroupRows, clearGroupRowsCache, postJson, putJson, type GroupRow, type MidCheckItem, type ModelsInfo, type RuleItem } from './api.ts'
import { MidCheckEditPage, MidCheckListPage, RegexPage, RuleEditPage, RuleListPage } from './rulesui.tsx'
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
    body = <InfoRoot key={top.group} group={top.group} onExit={pop} onDeleted={() => setStack([])} />
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
  const [rows, setRows] = useState<GroupRow[] | null>(() => cachedGroupRows())
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

/* ---------- Tab 2：全局（二级页：全局规则 / 正则替换 / Jev中间判定） ----------
   三个页面与聊天信息里的「独立…」页共用同一套实现（rulesui.tsx）——这里只差 endpoint 与文案。 */

type RuleView = { k: 'hub' } | { k: 'ruleList' } | { k: 'regex' } | { k: 'ruleEdit'; id: string | null; seed?: RuleItem }
  | { k: 'midList' } | { k: 'midEdit'; id: string | null; seed?: MidCheckItem }

function RulesTab(): React.ReactElement {
  const [view, setView] = useState<RuleView>({ k: 'hub' })
  const hub = (): void => setView({ k: 'hub' })
  // seed：把列表里刚点的那条直接带进编辑页，首帧就是正确内容（不闪加载/空表单）
  if (view.k === 'ruleList') {
    return <RuleListPage frame="page" title="全局规则" addLabel="＋ 添加全局规则"
      emptyHint="（还没有全局规则——点上方「＋ 添加全局规则」创建）" endpoint="/api/rules" onBack={hub}
      onEdit={r => setView({ k: 'ruleEdit', id: r?.id ?? null, ...(r === null ? {} : { seed: r }) })} />
  }
  // key：从一条规则跳到另一条/新建时强制重挂载，避免沿用上一条的本地草稿
  if (view.k === 'ruleEdit') {
    return <RuleEditPage key={view.id ?? 'new'} frame="page" endpoint="/api/rules" id={view.id} seed={view.seed}
      titleNew="添加全局规则" titleEdit="编辑全局规则" onBack={() => setView({ k: 'ruleList' })} />
  }
  if (view.k === 'midList') {
    return <MidCheckListPage frame="page" title="Jev中间判定" addLabel="＋ 新建 Jev 中间判定"
      emptyHint="（还没有判定——点上方「＋ 新建 Jev 中间判定」创建）" endpoint="/api/mid-checks" onBack={hub}
      onEdit={c => setView({ k: 'midEdit', id: c?.id ?? null, ...(c === null ? {} : { seed: c }) })} />
  }
  if (view.k === 'midEdit') {
    return <MidCheckEditPage key={view.id ?? 'new'} frame="page" endpoint="/api/mid-checks" id={view.id} seed={view.seed}
      titleNew="新建 Jev 中间判定" titleEdit="编辑 Jev 中间判定" onBack={() => setView({ k: 'midList' })} />
  }
  if (view.k === 'regex') return <RegexPage frame="page" title="正则替换" addLabel="＋ 添加正则" onBack={hub} />
  return (
    <>
      <NavBar title="全局" />
      <div className="scroll">
        <Cells>
          <Cell title="全局规则" arrow onTap={() => setView({ k: 'ruleList' })} />
          <Cell title="正则替换" arrow onTap={() => setView({ k: 'regex' })} />
          <Cell title="Jev中间判定" arrow onTap={() => setView({ k: 'midList' })} />
        </Cells>
      </div>
    </>
  )
}

/* ---------- Tab 3：模型配置 ----------
   两段式极简布局（用户决定）：
   - 模型：自定义对话提供方——密钥 + 可展开的「自定义设置」（API 地址 / 模型 ID）+ 一个保存键；
   - 总管快速判断（可选）：只给一个密钥框。填入正确密钥即启用 Jev 快路径（地址/模型固定，不让用户配）；
     留空则保持未启用，引擎按设计自动回退"完整总管"（角色模型代偿）。
   概念边界：Jev 是 TypeSafe SystemOne 判定模型（不生成文本），永远不当角色模型。 */

/** 思考档位（值逐字发给提供方；off = 完全不发该字段——不认它的模型/提供方照样能用）。
 *  没有接口能查某模型支持哪些档位，故全列；提供方是最终校验者。 */
const EFFORT_LABEL: Record<string, string> = {
  off: '不发送（off）',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

/** 模型配置缓存：切回本 Tab 先展示上次结果，再静默刷新 */
let modelsCache: ModelsInfo | null = null

function ModelsView(): React.ReactElement {
  const toast = useToast()
  const [info, setInfo] = useState<ModelsInfo | null>(() => modelsCache)
  const [openCustom, setOpenCustom] = useState(false)
  const [draft, setDraft] = useState({ baseUrl: '', model: '', apiKey: '', reasoningEffort: 'high', maxTokens: '' })
  const [jevKey, setJevKey] = useState('')
  const [busy, setBusy] = useState(false)
  /** 拉取到的可选模型 ID（空数组 = 未拉取/无结果；弹窗据此渲染）。 */
  const [modelList, setModelList] = useState<string[]>([])
  const [pickOpen, setPickOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [fetching, setFetching] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await getJson<ModelsInfo>('/api/models')
      modelsCache = next
      setInfo(next)
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
    setDraft({
      baseUrl: active?.baseUrl ?? 'https://api.deepseek.com',
      model: active?.model ?? 'deepseek-flash',
      apiKey: '',
      reasoningEffort: active?.reasoningEffort ?? 'high',
      maxTokens: active?.maxTokens !== undefined && active.maxTokens > 0 ? String(active.maxTokens) : '',
    })
    setModelList([])
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
          baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), reasoningEffort: draft.reasoningEffort,
          maxTokens: Math.max(0, Math.floor(Number(draft.maxTokens) || 0)),
          ...(draft.apiKey.trim() === '' ? {} : { apiKey: draft.apiKey.trim() }),
        })
        toast('已保存')
      } else {
        const created = await postJson<{ ok: boolean; id: string }>('/api/models', {
          name: '自定义', baseUrl: draft.baseUrl.trim(), model: draft.model.trim(),
          apiKey: draft.apiKey.trim(), reasoningEffort: draft.reasoningEffort,
          maxTokens: Math.max(0, Math.floor(Number(draft.maxTokens) || 0)),
        })
        await postJson(`/api/models/${enc(created.id)}/activate`, {})
        toast('已保存并启用')
      }
      setOpenCustom(false)
      setDraft({ baseUrl: '', model: '', apiKey: '', reasoningEffort: 'high', maxTokens: '' })
      setModelList([])
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

  /** 服务端代查可用模型 ID（浏览器直连会被 CORS 拦，密钥也不该进页面作用域）。 */
  const fetchModels = async (): Promise<void> => {
    if (draft.baseUrl.trim() === '') { toast('先填 API 地址'); return }
    if (draft.apiKey.trim() === '' && active === undefined) { toast('先填 API 密钥'); return } // 已有提供方时留空 = 用已存密钥（后端兜底）
    setFetching(true)
    try {
      const r = await postJson<{ models: string[] }>('/api/models/discover', {
        baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(),
      })
      setModelList(r.models)
      setPickOpen(true)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setFetching(false)
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
              <Field label="API 地址" value={draft.baseUrl} placeholder="https://api.example.com"
                onChange={v => setDraft(d => ({ ...d, baseUrl: v }))} />
              <div className="field-row">
                <Field label="模型 ID" value={draft.model} placeholder="如 gpt-4o-mini"
                  onChange={v => setDraft(d => ({ ...d, model: v }))} />
                <button className="field-action" disabled={fetching} onClick={() => void fetchModels()}>
                  {fetching ? '查询中…' : '获取列表'}
                </button>
              </div>
              {/* 思考档位：模型定下后才出现。只读展示——点"选择"在弹窗里改，避免看起来能打字其实无效 */}
              {draft.model.trim() !== '' && (
                <div className="field-row">
                  <div className="field" style={{ flex: 1, minWidth: 0 }}>
                    <div className="field-label">思考档位</div>
                    <div className="field-input">{EFFORT_LABEL[draft.reasoningEffort] ?? draft.reasoningEffort}</div>
                  </div>
                  <button className="field-action" onClick={() => setEffortOpen(true)}>选择</button>
                </div>
              )}
              {/* 输出上限：留空/0 = 完全不发该字段（上限交给提供方）；填数字 = 显式写死 */}
              <Field label="输出上限" type="number" value={draft.maxTokens} placeholder="留空 = 不设上限" 
                onChange={v => setDraft(d => ({ ...d, maxTokens: v }))} />
            </>
          )}
        </Cells>
        {openCustom && (
          <button className="btn-primary" disabled={busy} onClick={() => void saveCustom()}>
            {busy ? '保存中…' : '保存'}
          </button>
        )}

        {/* 可用模型 ID：服务端代查的结果，点选即填入模型 ID */}
        <Modal open={pickOpen} onClose={() => setPickOpen(false)} title="可用模型">
          <div className="pick-list">
            {modelList.map(m => (
              <button key={m} className={'pick-row' + (m === draft.model ? ' on' : '')}
                onClick={() => { setDraft(d => ({ ...d, model: m })); setPickOpen(false) }}>
                {m}
              </button>
            ))}
          </div>
        </Modal>

        {/* 思考档位：DeepSeek 与 OpenAI 两套用词都列出，提供方自己校验，选错只报它自己的错 */}
        <Modal open={effortOpen} onClose={() => setEffortOpen(false)} title="思考档位">
          <div className="pick-list">
            {Object.entries(EFFORT_LABEL).map(([k, label]) => (
              <button key={k} className={'pick-row' + (k === draft.reasoningEffort ? ' on' : '')}
                onClick={() => { setDraft(d => ({ ...d, reasoningEffort: k })); setEffortOpen(false) }}>
                {label}
              </button>
            ))}
          </div>
        </Modal>

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
      clearGroupRowsCache() // 新群还没进主页缓存：下次回主页重新拉（先显示旧列表再补齐）
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
            // div 而非 button：内部还有"移除"按钮，button 不能嵌套（HTML 解析会提前闭合外层）
            <div key={s.name} className="cell tap" role="button" tabIndex={0} onClick={() => setActive(s.name)}
              onKeyDown={e => {
                if (e.target !== e.currentTarget) return // 内层"移除"按钮自己的键盘事件
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(s.name) }
              }}>
              <div className="cell-title">
                <div className="main">{s.name}{active === s.name ? '（开局）' : ''}</div>
                {s.description !== '' && <div className="sub">{s.description}</div>}
              </div>
              <button className="mem-del" onClick={e => {
                e.stopPropagation()
                setScenes(list => list.filter(x => x.name !== s.name))
                setActive(a => (a === s.name ? (scenes.find(x => x.name !== s.name)?.name ?? '') : a))
              }}>移除</button>
            </div>
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
