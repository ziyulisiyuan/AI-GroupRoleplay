/**
 * 后端打包：src/server.ts → 单文件 ESM（android/payload/server.mjs）。
 * - platform=node：node: 内建模块保持外部引用；
 * - banner 注入 createRequire：CJS 依赖（undici 等）在 ESM 产物里的动态 require 落到真实 require；
 * - 产物自包含，手机上由内嵌 Node 直接运行；PC 烟测同用。
 * 用法：node scripts/bundle-server.mjs （或 pnpm bundle:server）
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  legalComments: 'none',
  banner: {
    js: `import { createRequire as __cR } from 'node:module'; const require = __cR(import.meta.url);`,
  },
  outfile: 'android/payload/server.mjs',
  logLevel: 'info',
})
