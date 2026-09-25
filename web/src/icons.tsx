/**
 * 内联图标——路径数据取自捆绑的 Lucide 官方图标集
 * （本地捆绑副本，MIT）。
 * 只内联用到的 16 个，不引入运行时依赖。
 */
import React from 'react'

interface P { size?: number; className?: string; style?: React.CSSProperties }

function icon(paths: React.ReactNode): (p: P) => React.ReactElement {
  return ({ size = 22, className, style }: P) => (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true"
    >
      {paths}
    </svg>
  )
}

export const ChevronLeft = icon(<path d="m15 18-6-6 6-6" />)
export const ChevronRight = icon(<path d="m9 18 6-6-6-6" />)
export const Search = icon(<><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>)
export const Plus = icon(<><path d="M5 12h14" /><path d="M12 5v14" /></>)
export const Ellipsis = icon(<><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>)
export const MessageCircle = icon(<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />)
export const ScrollText = icon(<><path d="M15 12h-5" /><path d="M15 8h-5" /><path d="M19 17V5a2 2 0 0 0-2-2H4" /><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" /></>)
export const Settings2 = icon(<><path d="M14 17H5" /><path d="M19 7h-9" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>)
export const Pencil = icon(<><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></>)
export const Trash2 = icon(<><path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>)
export const RefreshCw = icon(<><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>)
export const X = icon(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>)
export const Check = icon(<path d="M20 6 9 17l-5-5" />)
export const CheckSquare = icon(<><path d="M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344" /><path d="m9 11 3 3L22 4" /></>)
export const Camera = icon(<><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3" /></>)
export const UsersRound = icon(<><path d="M18 21a8 8 0 0 0-16 0" /><circle cx="10" cy="8" r="5" /><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" /></>)
export const MapPin = icon(<><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>)
