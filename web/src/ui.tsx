/**
 * 共享 UI 组件：导航栏 / TabBar / 头像（含回退与上传压缩）/ 单元组 /
 * 底部弹层 / 确认框 / Toast / 字段 / 长按。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Check, ChevronLeft, MessageCircle, ScrollText, Settings2 } from './icons.tsx'

/* ---------- TabBar ---------- */

export type TabKey = 'home' | 'rules' | 'models'

export function TabBarBar({ tab, onChange }: { tab: TabKey; onChange: (t: TabKey) => void }): React.ReactElement {
  const tabs: Array<{ k: TabKey; label: string; icon: React.ReactNode }> = [
    { k: 'home', label: '主页面', icon: <MessageCircle size={24} /> },
    { k: 'rules', label: '全局', icon: <ScrollText size={24} /> },
    { k: 'models', label: '模型配置', icon: <Settings2 size={24} /> },
  ]
  return (
    <div className="tabbar">
      {tabs.map(t => (
        <button key={t.k} className={'tab' + (tab === t.k ? ' active' : '')} onClick={() => onChange(t.k)}>
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Toast ---------- */

const ToastCtx = createContext<(msg: string) => void>(() => undefined)
export const useToast = (): ((msg: string) => void) => useContext(ToastCtx)

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((m: string): void => {
    setMsg(m)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(null), 2400)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg !== null && <div className="toast">{msg}</div>}
    </ToastCtx.Provider>
  )
}

/* ---------- 导航栏 ---------- */

export function NavBar({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }): React.ReactElement {
  return (
    <div className="navbar">
      <div className="navbar-side">
        {onBack !== undefined && (
          <button className="navbar-btn" onClick={onBack} aria-label="返回"><ChevronLeft size={24} /></button>
        )}
      </div>
      <div className="navbar-title">{title}</div>
      <div className="navbar-side right">{right}</div>
    </div>
  )
}

/* ---------- 头像（回退：名字首字 + 名字哈希取调色板底色） ---------- */

const PALETTE = ['#8fa3b8', '#9bb0a5', '#b0a0b8', '#b8a48e', '#8fa8a8', '#a89ab8', '#a8a08f', '#988fa8']

function hashColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

export function Avatar({ name, url, size = 40 }: { name: string; url?: string; size?: number }): React.ReactElement {
  const [broken, setBroken] = useState(false)
  // URL 变化（换头像后版本号变了）必须重置失败态：否则一次 404 之后永远停在首字色块上，
  // 表现为"换了头像不变、退出页面才生效"（真机反馈）。
  useEffect(() => { setBroken(false) }, [url])
  const showImg = url !== undefined && !broken
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: showImg ? undefined : hashColor(name) }}
    >
      {showImg ? <img src={url} alt="" onError={() => setBroken(true)} /> : (name.trim()[0] ?? '群')}
    </div>
  )
}

/** 选图 → 手动裁剪（拖动 + 缩放）→ 320px JPEG → 交由调用方上传。 */
function Cropper({ file, onCancel, onDone }: {
  file: File
  onCancel: () => void
  onDone: (blob: Blob) => void
}): React.ReactElement {
  const VIEW = 260 // 裁剪视窗边长（CSS px）
  const OUT = 320  // 输出边长
  const [src] = useState(() => URL.createObjectURL(file))
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    let dead = false
    void (async () => {
      const bm = await createImageBitmap(file)
      if (!dead) setBitmap(bm)
    })()
    return () => { dead = true; URL.revokeObjectURL(src) }
  }, [file, src])

  /** 覆盖式基准缩放：图片短边铺满视窗。 */
  const base = bitmap === null ? 1 : Math.max(VIEW / bitmap.width, VIEW / bitmap.height)
  const total = base * scale
  const dispW = (bitmap?.width ?? 0) * total
  const dispH = (bitmap?.height ?? 0) * total
  const maxX = Math.max(0, (dispW - VIEW) / 2)
  const maxY = Math.max(0, (dispH - VIEW) / 2)
  const clamp = (v: number, m: number): number => (v > m ? m : v < -m ? -m : v)
  const ox = clamp(offset.x, maxX)
  const oy = clamp(offset.y, maxY)

  const move = (e: React.PointerEvent): void => {
    if (drag.current === null) return
    setOffset({
      x: drag.current.ox + (e.clientX - drag.current.x),
      y: drag.current.oy + (e.clientY - drag.current.y),
    })
  }

  const confirm = (): void => {
    if (bitmap === null) return
    const crop = VIEW / total // 视窗对应的原图边长
    const sx = bitmap.width / 2 - ox / total - crop / 2
    const sy = bitmap.height / 2 - oy / total - crop / 2
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = OUT
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, sx, sy, crop, crop, 0, 0, OUT, OUT)
    canvas.toBlob(b => {
      if (b === null) return onCancel()
      onDone(b)
    }, 'image/jpeg', 0.88)
  }

  return (
    <div className="cropper">
      <div
        className="cropper-view"
        style={{ width: VIEW, height: VIEW }}
        onPointerDown={e => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, ox, oy }
        }}
        onPointerMove={move}
        onPointerUp={() => { drag.current = null }}
        onPointerCancel={() => { drag.current = null }}
      >
        {bitmap !== null && (
          <img
            src={src} alt="" draggable={false}
            style={{
              width: dispW, height: dispH,
              transform: `translate(${ox}px, ${oy}px)`,
            }}
          />
        )}
        <div className="cropper-frame" />
      </div>
      <input
        className="cropper-zoom" type="range" min={1} max={4} step={0.01} value={scale}
        onChange={e => setScale(Number(e.target.value))}
      />
      <div className="cropper-actions">
        <button onClick={onCancel}>取消</button>
        <button className="ok" onClick={confirm}>确定</button>
      </div>
    </div>
  )
}

export function AvatarPicker({ name, url, size, upload }: {
  name: string
  url: string | undefined
  size: number
  upload: (blob: Blob) => Promise<void>
}): React.ReactElement {
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [crop, setCrop] = useState<File | null>(null)

  const send = async (blob: Blob): Promise<void> => {
    setCrop(null)
    setBusy(true)
    try {
      await upload(blob)
      toast('头像已更新')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="avatar-pick" style={{ width: size, height: size }} onClick={() => { if (!busy) inputRef.current?.click() }}>
        <Avatar name={name} url={url} size={size} />
        <div className="avatar-pick-mask"><Camera size={Math.round(size * 0.44)} /></div>
        <input
          ref={inputRef} type="file" accept="image/*" hidden
          onChange={e => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f !== undefined) setCrop(f) // 先裁剪，确认后再上传
          }}
        />
      </div>
      <Modal open={crop !== null} onClose={() => setCrop(null)} title="裁剪头像">
        {crop !== null && (
          <Cropper file={crop} onCancel={() => setCrop(null)} onDone={blob => void send(blob)} />
        )}
      </Modal>
    </>
  )
}

/* ---------- 单元 ---------- */

export function Cells({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="cell-group">{children}</div>
}

export function Cell({ avatar, title, sub, value, arrow, danger, onTap }: {
  avatar?: React.ReactNode
  title: React.ReactNode
  sub?: React.ReactNode
  value?: React.ReactNode
  arrow?: boolean
  danger?: boolean
  onTap?: () => void
}): React.ReactElement {
  const body = (
    <>
      {avatar}
      <div className="cell-title">
        <div className={'main' + (danger === true ? ' cell-danger-main' : '')}>{title}</div>
        {sub !== undefined && <div className="sub">{sub}</div>}
      </div>
      {value !== undefined && <div className="cell-value">{value}</div>}
      {arrow === true && <div className="cell-chevron"><ChevronLeft size={18} style={{ transform: 'rotate(180deg)' }} /></div>}
    </>
  )
  return onTap === undefined
    ? <div className={'cell' + (danger === true ? ' cell-danger' : '')}>{body}</div>
    : <button className={'cell' + (danger === true ? ' cell-danger' : '')} onClick={onTap}>{body}</button>
}

export function CheckCell({ on, label, onToggle }: { on: boolean; label: React.ReactNode; onToggle: (next: boolean) => void }): React.ReactElement {
  return (
    <div className={'check-cell' + (on ? ' on' : '')} onClick={() => onToggle(!on)} role="checkbox" aria-checked={on}>
      <div className="check-box"><Check size={16} /></div>
      {label}
    </div>
  )
}

/* ---------- 悬浮弹窗（居中）/ 确认框 ---------- */

export function Modal({ open, onClose, title, children }: {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
}): React.ReactElement | null {
  const [render, setRender] = useState(open)
  useEffect(() => {
    if (open) { setRender(true); return }
    const t = setTimeout(() => setRender(false), 200) // 收起动画播完再卸载
    return () => clearTimeout(t)
  }, [open])
  if (!render) return null
  const closing = !open
  return (
    <div className={'dialog' + (closing ? ' closing' : '')}>
      <div className="dialog-mask" onClick={onClose} />
      <div className="modal-box">
        {title !== undefined && <div className="modal-title">{title}</div>}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function Confirm({ open, text, okText = '删除', danger = true, onOk, onClose }: {
  open: boolean
  text: React.ReactNode
  okText?: string
  danger?: boolean
  onOk: () => void
  onClose: () => void
}): React.ReactElement | null {
  if (!open) return null
  return (
    <div className="dialog">
      <div className="dialog-mask" onClick={onClose} />
      <div className="dialog-box">
        <div className="dialog-text">{text}</div>
        <div className="dialog-btns">
          <button onClick={onClose}>取消</button>
          <button className={'ok' + (danger ? ' danger' : '')} onClick={onOk}>{okText}</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- 表单字段 ---------- */

export function Field({ label, value, onChange, multiline = false, placeholder, rows = 4, type = 'text', inputRef }: {
  label: string
  value: string
  onChange: (v: string) => void
  multiline?: boolean
  placeholder?: string
  rows?: number
  /** 单行输入的类型（密钥用 password，不回显） */
  type?: 'text' | 'password'
  inputRef?: React.RefObject<HTMLTextAreaElement>
}): React.ReactElement {
  return (
    <label className="field">
      <div className="field-label">{label}</div>
      {multiline
        ? <textarea className="field-input" rows={rows} placeholder={placeholder} value={value} ref={inputRef ?? undefined} onChange={e => onChange(e.target.value)} />
        : <input className="field-input" type={type} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />}
    </label>
  )
}

/* ---------- 长按（移动长按 450ms；桌面右键等效） ---------- */

export function useLongPress(onLongPress: () => void): {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchCancel: () => void
  onContextMenu: (e: React.MouseEvent) => void
} {
  const timer = useRef<number | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | undefined>(undefined)
  const clear = useCallback((): void => {
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  useEffect(() => clear, [clear])
  return useMemo(() => ({
    onTouchStart: (e: React.TouchEvent): void => {
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY }
      clear()
      timer.current = window.setTimeout(onLongPress, 450)
    },
    onTouchMove: (e: React.TouchEvent): void => {
      const t = e.touches[0]
      if (start.current !== undefined && Math.abs(t.clientX - start.current.x) + Math.abs(t.clientY - start.current.y) > 10) clear()
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
    onContextMenu: (e: React.MouseEvent): void => {
      e.preventDefault()
      onLongPress()
    },
  }), [onLongPress, clear])
}
