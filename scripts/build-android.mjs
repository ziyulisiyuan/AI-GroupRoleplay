/**
 * 组装安卓 payload：后端单文件 + 前端 dist → android/app/src/main/assets/payload.zip
 *
 * zip 内布局（与 Payload.java 解包约定、后端 config.root 推导三者对齐）：
 *   app/server.mjs     → filesDir/app/server.mjs   （config.root = 其父目录 = filesDir）
 *   dist/…             → filesDir/dist/…           （server-static.ts 托管前端）
 * 数据目录 groups/ 与 settings.yaml 不在 payload 内，升级不会触碰用户数据。
 *
 * 用法：node scripts/build-android.mjs
 */
import { build } from 'esbuild'
import { execFileSync, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const STAGE = join(ROOT, 'android', 'payload')
const ASSETS = join(ROOT, 'android', 'app', 'src', 'main', 'assets')
const DIST = join(ROOT, 'web', 'dist')

// 1) 前端构建
console.log('[1/4] 构建前端 (web/dist) …')
execSync('pnpm --dir web build', { cwd: ROOT, stdio: 'inherit' })
if (!existsSync(join(DIST, 'index.html'))) throw new Error('web/dist 缺失')

// 2) 后端打包（单文件 ESM）——先清空 staging，避免陈旧产物混入 payload
console.log('[2/4] 打包后端 → android/payload/app/server.mjs …')
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(join(STAGE, 'app'), { recursive: true })
await build({
  entryPoints: [join(ROOT, 'src', 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  legalComments: 'none',
  banner: { js: `import { createRequire as __cR } from 'node:module'; const require = __cR(import.meta.url);` },
  outfile: join(STAGE, 'app', 'server.mjs'),
  logLevel: 'warning',
})

// 3) 组织 staging（app/ + dist/）
console.log('[3/4] 组织 payload 目录 …')
cpSync(DIST, join(STAGE, 'dist'), { recursive: true })

// 4) 打 zip 到 assets
// 用 bsdtar（Windows 自带 tar）而不是 Compress-Archive：后者在 Windows 上把条目名写成
// 反斜杠（app\server.mjs），Linux 侧解包会得到字面量文件名 → 必须用正斜杠的 zip。
console.log('[4/4] 生成 assets/payload.zip …')
mkdirSync(ASSETS, { recursive: true })
const zip = join(ASSETS, 'payload.zip')
rmSync(zip, { force: true })
// Git Bash 的 GNU tar 会把 `D:\...` 的盘符冒号当成远程主机名（"Cannot connect to D:"）——
// 显式优先 Windows 自带的 bsdtar（System32/tar.exe，支持 -a 与盘符路径），找不到再退回 PATH 里的 tar
const bsdtar = existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar'
execFileSync(bsdtar, ['-a', '-c', '-f', zip, '-C', STAGE, 'app', 'dist'], { stdio: 'inherit' })

console.log('完成：', zip)
