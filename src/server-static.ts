/**
 * 前端静态托管（安卓自包含部署用；PC 上 dist 存在时顺带同一端口出界面）。
 * 只做增量：ROOT/dist 存在时才注册，把**未知 GET** 回退到 index.html（SPA 单页）。
 * /api 各路由在 server.ts 中先注册先命中，不受影响；dist 不存在时本模块完全不注册，
 * 后端行为与历史版本一致。独立成文件，回滚 = 删本文件 + 删 server.ts 里的两行接线。
 */
import { existsSync } from 'node:fs'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { Hono } from 'hono'
import { config } from './config.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

/** 注册静态回退；ROOT/dist/index.html 不存在时为空操作。 */
export function registerStatic(app: Hono): void {
  const dir = resolve(config.root, 'dist')
  const index = join(dir, 'index.html')
  if (!existsSync(index)) return
  app.get('*', c => {
    const rel = c.req.path === '/' ? 'index.html' : decodeURIComponent(c.req.path.slice(1))
    const p = resolve(dir, rel)
    try {
      // 防路径穿越：解析后必须仍在 dist 内
      if (p.startsWith(dir + sep) && existsSync(p) && statSync(p).isFile()) {
        return c.body(readFileSync(p), 200, { 'content-type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream' })
      }
    } catch { /* 非法路径走 index 回退 */ }
    return c.body(readFileSync(index), 200, { 'content-type': 'text/html; charset=utf-8' })
  })
}
