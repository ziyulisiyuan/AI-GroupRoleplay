/**
 * 规则类页面的共享实现：全局页（作用于所有群）与聊天信息里的「独立…」页（只作用于本群）
 * 用同一套 UI —— 差别只有 endpoint / 存储作用域与几行文案，避免两份长得不一样的实现。
 *
 *   规则       自由文本，注入角色提示词（RuleListPage / RuleEditPage）
 *   正则       显示层替换，存 localStorage（RegexPage；scope = 群名，缺省 = 全局）
 *   Jev中间判定 两段固定格式（MidCheckListPage / MidCheckEditPage）
 *
 * frame：'page'   = 自带导航栏与外层滚动（全局页，App.tsx 的二级页）
 *        'inline' = 只有内容（聊天信息子页，导航栏与滚动由 InfoRoot 提供）
 */
import React, { useCallback, useEffect, useState } from 'react'
import { getJson, putJson, type MidCheckItem, type RuleItem } from './api.ts'
import { Cells, Field, Modal, NavBar, useToast } from './ui.tsx'
import { isValidPattern, loadRules, newRuleId, saveRules, type RegexRule } from './regex.ts'

/** 列表缓存（按 endpoint / 作用域键控）：列表→编辑→返回不闪空、不重复拉取。 */
const ruleCaches = new Map<string, RuleItem[]>()
const midCaches = new Map<string, MidCheckItem[]>()

export type Frame = 'page' | 'inline'

/* ---------- 规则（自由文本） ---------- */

export function RuleListPage({ frame, title, addLabel, emptyHint, endpoint, onBack, onEdit }: {
  frame: Frame
  title: string
  addLabel: string
  emptyHint: string
  endpoint: string
  onBack?: () => void
  onEdit: (r: RuleItem | null) => void
}): React.ReactElement {
  const toast = useToast()
  const [rules, setRules] = useState<RuleItem[] | null>(() => ruleCaches.get(endpoint) ?? null)
  const load = useCallback(async (): Promise<void> => {
    try {
      const list = (await getJson<{ rules: RuleItem[] }>(endpoint)).rules
      ruleCaches.set(endpoint, list)
      setRules(list)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [endpoint, toast])
  useEffect(() => { void load() }, [load])
  const persist = async (next: RuleItem[]): Promise<void> => {
    setRules(next)
    ruleCaches.set(endpoint, next)
    try {
      await putJson(endpoint, { rules: next })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  const body = (
    <Cells>
      <button className="cell" onClick={() => onEdit(null)}>
        <div className="cell-title"><div className="main" style={{ color: 'var(--brand)' }}>{addLabel}</div></div>
      </button>
      {rules?.map(r => (
        <button key={r.id} className="cell" onClick={() => onEdit(r)}>
          <div className="cell-title">
            <div className="main">{r.name}</div>
            <div className="sub">{r.text.trim() !== '' ? r.text.trim().split('\n')[0] : '（空）'}</div>
          </div>
          <span
            className={'switch' + (r.enabled ? ' on' : '')}
            onClick={e => { e.stopPropagation(); void persist((rules ?? []).map(x => (x.id === r.id ? { ...x, enabled: !x.enabled } : x))) }}
          >
            <span className="knob" />
          </span>
        </button>
      ))}
      {rules !== null && rules.length === 0 && <div className="hint">{emptyHint}</div>}
    </Cells>
  )
  if (frame === 'inline') return body
  return (
    <>
      <NavBar title={title} {...(onBack === undefined ? {} : { onBack })} />
      <div className="scroll view-enter">{body}</div>
    </>
  )
}

export function RuleEditPage({ frame, endpoint, id, seed, titleNew, titleEdit, onBack }: {
  frame: Frame
  endpoint: string
  id: string | null
  seed?: RuleItem
  titleNew: string
  titleEdit: string
  onBack: () => void
}): React.ReactElement {
  const toast = useToast()
  const [rules, setRules] = useState<RuleItem[] | null>(() => ruleCaches.get(endpoint) ?? null)
  const [name, setName] = useState(seed?.name ?? '')
  const [text, setText] = useState(seed?.text ?? '')
  /** 载入时的原文：只有改动过才显示保存键（真机反馈：常驻保存键是噪音） */
  const [initial, setInitial] = useState<{ name: string; text: string } | null>(
    id === null ? { name: '', text: '' } : (seed === undefined ? null : { name: seed.name, text: seed.text }),
  )
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void (async () => {
      try {
        const list = (await getJson<{ rules: RuleItem[] }>(endpoint)).rules
        ruleCaches.set(endpoint, list)
        setRules(list)
        if (id === null || seed !== undefined) return
        const r = list.find(x => x.id === id)
        if (r === undefined) { toast('规则不存在'); onBack(); return }
        setName(r.name)
        setText(r.text)
        setInitial({ name: r.name, text: r.text })
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
        if (seed === undefined) onBack()
      }
    })()
  }, [id, seed, endpoint, toast, onBack])
  const dirty = initial !== null && (name !== initial.name || text !== initial.text)
  const save = async (): Promise<void> => {
    if (rules === null || busy) return
    if (name.trim() === '') { toast('名称不能为空'); return }
    setBusy(true)
    try {
      const next = id === null
        ? [...rules, { id: `r${Date.now().toString(36)}`, name: name.trim(), enabled: true, text }]
        : rules.map(r => (r.id === id ? { ...r, name: name.trim(), text } : r))
      await putJson(endpoint, { rules: next })
      ruleCaches.set(endpoint, next)
      onBack()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (rules === null || id === null || busy) return
    setBusy(true)
    try {
      const next = rules.filter(r => r.id !== id)
      await putJson(endpoint, { rules: next })
      ruleCaches.set(endpoint, next)
      onBack()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  // 规则载入完成前不渲染表单：否则会先闪一帧空表单（看起来像"添加规则"页）
  if (initial === null) {
    return frame === 'inline'
      ? <div className="empty">加载中……</div>
      : (<><NavBar title={id === null ? titleNew : titleEdit} onBack={onBack} /><div className="scroll"><div className="empty">加载中……</div></div></>)
  }
  const form = (
    <>
      <Cells>
        <Field label="名称" value={name} onChange={setName} placeholder="规则的显示名（只影响列表，不进入角色提示词）" />
        <Field label="规则正文" value={text} onChange={setText} multiline rows={16} placeholder="（只写这条规则的内容；只有开启的规则才会注入角色）" />
      </Cells>
      {id !== null && (
        <div style={{ padding: '0 var(--s-4) var(--s-3)' }}>
          <button style={{ color: 'var(--danger)', fontSize: 'var(--fs-sub)' }} disabled={busy} onClick={() => void remove()}>删除这条规则</button>
        </div>
      )}
    </>
  )
  if (frame === 'inline') {
    return (
      <>
        {form}
        <button className="btn-primary" disabled={busy || rules === null || !dirty} onClick={() => void save()}>保存</button>
      </>
    )
  }
  return (
    <>
      <NavBar
        title={id === null ? titleNew : titleEdit}
        onBack={onBack}
        right={dirty
          ? <button className="navbar-text-btn" disabled={busy || rules === null} onClick={() => void save()}>保存</button>
          : undefined}
      />
      <div className="scroll view-enter" style={{ display: 'flex', flexDirection: 'column' }}>{form}</div>
    </>
  )
}

/* ---------- 正则替换（显示层；存 localStorage，按作用域分开） ---------- */

export function RegexPage({ frame, scope, title, addLabel, onBack }: {
  frame: Frame
  /** 作用域：群名 = 该群独立正则；缺省 = 全局。 */
  scope?: string
  title: string
  addLabel: string
  onBack?: () => void
}): React.ReactElement {
  const toast = useToast()
  const [rules, setRules] = useState<RegexRule[]>(() => loadRules(scope))
  const [editing, setEditing] = useState<{ id: string | null; pattern: string; replacement: string; name: string; enabled: boolean } | null>(null)

  const persist = (next: RegexRule[]): void => {
    setRules(next)
    saveRules(next, scope)
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
      enabled: editing.enabled,
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

  const body = (
    <Cells>
      <button className="cell" onClick={() => setEditing({ id: null, pattern: '', replacement: '', name: '', enabled: true })}>
        <div className="cell-title"><div className="main" style={{ color: 'var(--brand)' }}>{addLabel}</div></div>
      </button>
      {rules.map(r => (
        <button key={r.id} className="cell" onClick={() => setEditing({ id: r.id, pattern: r.pattern, replacement: r.replacement, name: r.name, enabled: r.enabled })}>
          <div className="cell-title">
            <div className="main">{r.name}</div>
            <div className="sub">{r.pattern} → {r.replacement === '' ? '（删除）' : r.replacement}</div>
          </div>
          <span
            className={'switch' + (r.enabled ? ' on' : '')}
            onClick={e => { e.stopPropagation(); persist(rules.map(x => (x.id === r.id ? { ...x, enabled: !x.enabled } : x))) }}
          >
            <span className="knob" />
          </span>
        </button>
      ))}
      {rules.length === 0 && <div className="hint">（还没有规则）</div>}
    </Cells>
  )

  return (
    <>
      {frame === 'inline'
        ? body
        : (<>
            <NavBar title={title} {...(onBack === undefined ? {} : { onBack })} />
            <div className="scroll view-enter">{body}</div>
          </>)}
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

/* ---------- Jev 中间判定（两段固定格式） ---------- */

export function MidCheckListPage({ frame, title, addLabel, emptyHint, endpoint, onBack, onEdit }: {
  frame: Frame
  title: string
  addLabel: string
  emptyHint: string
  endpoint: string
  onBack?: () => void
  onEdit: (c: MidCheckItem | null) => void
}): React.ReactElement {
  const toast = useToast()
  const [checks, setChecks] = useState<MidCheckItem[] | null>(() => midCaches.get(endpoint) ?? null)
  const load = useCallback(async (): Promise<void> => {
    try {
      const list = (await getJson<{ checks: MidCheckItem[] }>(endpoint)).checks
      midCaches.set(endpoint, list)
      setChecks(list)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }, [endpoint, toast])
  useEffect(() => { void load() }, [load])
  const persist = async (next: MidCheckItem[]): Promise<void> => {
    setChecks(next)
    midCaches.set(endpoint, next)
    try {
      await putJson(endpoint, { checks: next })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  const body = (
    <Cells>
      <button className="cell" onClick={() => onEdit(null)}>
        <div className="cell-title"><div className="main" style={{ color: 'var(--brand)' }}>{addLabel}</div></div>
      </button>
      {checks?.map(c => (
        <button key={c.id} className="cell" onClick={() => onEdit(c)}>
          <div className="cell-title">
            <div className="main">{c.name}</div>
            <div className="sub">{c.check.trim() !== '' ? `本段输出是否违反了${c.check.trim()}` : '（空）'}</div>
          </div>
          <span
            className={'switch' + (c.enabled ? ' on' : '')}
            onClick={e => { e.stopPropagation(); void persist((checks ?? []).map(x => (x.id === c.id ? { ...x, enabled: !x.enabled } : x))) }}
          >
            <span className="knob" />
          </span>
        </button>
      ))}
      {checks !== null && checks.length === 0 && <div className="hint">{emptyHint}</div>}
    </Cells>
  )
  if (frame === 'inline') return body
  return (
    <>
      <NavBar title={title} {...(onBack === undefined ? {} : { onBack })} />
      <div className="scroll view-enter">{body}</div>
    </>
  )
}

export function MidCheckEditPage({ frame, endpoint, id, seed, titleNew, titleEdit, onBack }: {
  frame: Frame
  endpoint: string
  id: string | null
  seed?: MidCheckItem
  titleNew: string
  titleEdit: string
  onBack: () => void
}): React.ReactElement {
  const toast = useToast()
  const [checks, setChecks] = useState<MidCheckItem[] | null>(() => midCaches.get(endpoint) ?? null)
  const [name, setName] = useState(seed?.name ?? '')
  const [check, setCheck] = useState(seed?.check ?? '')
  const [fix, setFix] = useState(seed?.fix ?? '')
  const [initial, setInitial] = useState<{ name: string; check: string; fix: string } | null>(
    id === null ? { name: '', check: '', fix: '' } : (seed === undefined ? null : { name: seed.name, check: seed.check, fix: seed.fix }),
  )
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void (async () => {
      try {
        const list = (await getJson<{ checks: MidCheckItem[] }>(endpoint)).checks
        midCaches.set(endpoint, list)
        setChecks(list)
        if (id === null || seed !== undefined) return
        const c = list.find(x => x.id === id)
        if (c === undefined) { toast('判定不存在'); onBack(); return }
        setName(c.name)
        setCheck(c.check)
        setFix(c.fix)
        setInitial({ name: c.name, check: c.check, fix: c.fix })
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
        if (seed === undefined) onBack()
      }
    })()
  }, [id, seed, endpoint, toast, onBack])
  const dirty = initial !== null && (name !== initial.name || check !== initial.check || fix !== initial.fix)
  const save = async (): Promise<void> => {
    if (checks === null || busy) return
    if (name.trim() === '') { toast('名称不能为空'); return }
    if (check.trim() === '') { toast('第一段不能为空'); return }
    if (fix.trim() === '') { toast('第二段不能为空'); return }
    setBusy(true)
    try {
      const next = id === null
        ? [...checks, { id: `m${Date.now().toString(36)}`, name: name.trim(), enabled: true, check: check.trim(), fix }]
        : checks.map(c => (c.id === id ? { ...c, name: name.trim(), check: check.trim(), fix } : c))
      await putJson(endpoint, { checks: next })
      midCaches.set(endpoint, next)
      onBack()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (checks === null || id === null || busy) return
    setBusy(true)
    try {
      const next = checks.filter(c => c.id !== id)
      await putJson(endpoint, { checks: next })
      midCaches.set(endpoint, next)
      onBack()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  // 载入完成前不渲染表单：否则会先闪一帧空表单（看起来像"新建"页）
  if (initial === null) {
    return frame === 'inline'
      ? <div className="empty">加载中……</div>
      : (<><NavBar title={id === null ? titleNew : titleEdit} onBack={onBack} /><div className="scroll"><div className="empty">加载中……</div></div></>)
  }
  const form = (
    <>
      <Cells>
        <Field label="名称" value={name} onChange={setName} placeholder="判定的显示名（只影响列表，不进入 Jev）" />
        <div className="field">
          <div className="field-label">第一段（发给 Jev 的问题）</div>
          <div className="sentence-field">
            <span className="lead">本段输出是否违反了</span>
            <input className="field-input" value={check} placeholder="如：不得替用户说话"
              onChange={e => setCheck(e.target.value)} />
          </div>
        </div>
        <Field label="第二段（命中时发回角色）" value={fix} onChange={setFix} multiline rows={6}
          placeholder="如：不要替用户决定他要做什么，只写你自己的言行" />
      </Cells>
      {id !== null && (
        <div style={{ padding: '0 var(--s-4) var(--s-3)' }}>
          <button style={{ color: 'var(--danger)', fontSize: 'var(--fs-sub)' }} disabled={busy} onClick={() => void remove()}>删除这条判定</button>
        </div>
      )}
    </>
  )
  if (frame === 'inline') {
    return (
      <>
        {form}
        <button className="btn-primary" disabled={busy || checks === null || !dirty} onClick={() => void save()}>保存</button>
      </>
    )
  }
  return (
    <>
      <NavBar
        title={id === null ? titleNew : titleEdit}
        onBack={onBack}
        right={dirty
          ? <button className="navbar-text-btn" disabled={busy || checks === null} onClick={() => void save()}>保存</button>
          : undefined}
      />
      <div className="scroll view-enter" style={{ display: 'flex', flexDirection: 'column' }}>{form}</div>
    </>
  )
}
