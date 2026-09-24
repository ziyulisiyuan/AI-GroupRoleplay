/**
 * 安卓 Node 运行时落地脚本：termux deb → jniLibs（arm64-v8a），并做闭环校验。
 *
 * 为什么需要本步骤：
 * - Android 安装器只把 **lib*.so** 形式的文件解包到 nativeLibraryDir，带版本后缀的
 *   （libcrypto.so.3 / libicuuc.so.78 …）不会落地 → 必须改名；
 * - 而 ELF 的 DT_NEEDED / DT_SONAME 里引用的正是带版本的名字 → 必须原地打补丁
 *   （新名更短，补零保持长度，不移动任何偏移）；
 * - 打完补丁必须做闭环校验：每个 NEEDED 要么在 jniLibs 内，要么是系统库。
 *
 * 用法：node scripts/stage-node-android.mjs [--check]
 *   前置：runtime-node/deb/*.deb 已下载（见 docs/安卓应用说明.md 的下载清单）
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DEB_DIR = join(ROOT, 'runtime-node', 'deb')
const EXTRACT_DIR = join(ROOT, 'runtime-node', 'extract')
const JNI_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'jniLibs', 'arm64-v8a')

/** 系统库（Android 自带，不需要打包）。 */
const SYSTEM_LIBS = new Set(['libc.so', 'libdl.so', 'libm.so', 'liblog.so', 'libandroid.so', 'libz.so', 'ld-android.so'])

/** termux usr 布局前缀（deb 内的数据路径）。 */
const PREFIX = 'data/data/com.termux/files/usr'

/** 需要的库 → 目标文件名（jniLibs 内）。node 二进制单独处理成 libnodeexec.so。 */
const LIB_SOURCES = [
  { from: `libc++/lib/libc++_shared.so`, to: 'libc++_shared.so' },
  { from: `c-ares/lib/libcares.so`, to: 'libcares.so' },
  { from: `libffi/lib/libffi.so`, to: 'libffi.so' },
  { from: `openssl/lib/libcrypto.so.3`, to: 'libcrypto.so' },
  { from: `openssl/lib/libssl.so.3`, to: 'libssl.so' },
  { from: `libicu/lib/libicudata.so.78.3`, to: 'libicudata.so' },
  { from: `libicu/lib/libicui18n.so.78.3`, to: 'libicui18n.so' },
  { from: `libicu/lib/libicuuc.so.78.3`, to: 'libicuuc.so' },
  { from: `libsqlite/lib/libsqlite3.so.3.53.4`, to: 'libsqlite3.so' },
  { from: `zlib/lib/libz.so.1.3.2`, to: 'libz.so' },
]

/** 需要改名 + 打补丁的 NEEDED/SONAME 旧名 → 新名。 */
const RENAME = [
  ['libz.so.1', 'libz.so'],
  ['libcrypto.so.3', 'libcrypto.so'],
  ['libssl.so.3', 'libssl.so'],
  ['libicui18n.so.78', 'libicui18n.so'],
  ['libicuuc.so.78', 'libicuuc.so'],
  ['libicudata.so.78', 'libicudata.so'],
]

/* ---------------- ELF64 读取（aarch64，小端） ---------------- */

function parseElf(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('不是 ELF 文件')
  if (buf[4] !== 2 || buf[5] !== 1) throw new Error('仅支持 ELF64 小端')
  const phoff = Number(buf.readBigUInt64LE(0x20))
  const phentsize = buf.readUInt16LE(0x36)
  const phnum = buf.readUInt16LE(0x38)
  const loads = []
  let dynOff = -1
  let dynSize = 0
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize
    const type = buf.readUInt32LE(o)
    const offset = Number(buf.readBigUInt64LE(o + 8))
    const vaddr = Number(buf.readBigUInt64LE(o + 16))
    const filesz = Number(buf.readBigUInt64LE(o + 32))
    const align = Number(buf.readBigUInt64LE(o + 48))
    if (type === 1) loads.push({ offset, vaddr, filesz, align })
    else if (type === 2) { dynOff = offset; dynSize = filesz }
  }
  const vaddrToOff = v => {
    for (const s of loads) if (v >= s.vaddr && v < s.vaddr + s.filesz) return s.offset + (v - s.vaddr)
    return -1
  }
  const needed = []
  let soname
  if (dynOff >= 0) {
    const entries = []
    for (let i = 0; i < dynSize / 16; i++) {
      const tag = Number(buf.readBigInt64LE(dynOff + i * 16))
      const val = Number(buf.readBigUInt64LE(dynOff + i * 16 + 8))
      entries.push([tag, val])
      if (tag === 0) break
    }
    const strtab = entries.find(e => e[0] === 5)?.[1] ?? 0
    const strOff = vaddrToOff(strtab)
    const readStr = v => {
      if (strOff < 0) return ''
      let s = ''
      let p = strOff + v
      while (p < buf.length && buf[p] !== 0) s += String.fromCharCode(buf[p++])
      return s
    }
    for (const [tag, val] of entries) {
      if (tag === 1) needed.push(readStr(val))
      else if (tag === 14) soname = readStr(val)
    }
  }
  const maxAlign = loads.reduce((m, s) => Math.max(m, s.align), 0)
  return { needed, soname, maxAlign }
}

/** 原地补字符串：新名必须不长于旧名，补零保持长度（不移动任何偏移）。 */
function patchString(buf, oldName, newName) {
  if (newName.length > oldName.length) throw new Error(`新名更长: ${oldName} -> ${newName}`)
  const oldBytes = Buffer.from(`${oldName}\0`, 'utf8')
  const newBytes = Buffer.alloc(oldBytes.length, 0)
  Buffer.from(newName, 'utf8').copy(newBytes)
  let count = 0
  let idx = 0
  while ((idx = buf.indexOf(oldBytes, idx)) !== -1) {
    newBytes.copy(buf, idx)
    count++
    idx += oldBytes.length
  }
  return count
}

/* ---------------- 主流程 ---------------- */

const checkOnly = process.argv.includes('--check')
const findExtract = suffix => {
  const hits = readdirSync(EXTRACT_DIR).filter(d => d.startsWith(suffix))
  if (hits.length === 0) throw new Error(`未找到解包目录: ${suffix}（先解包 deb）`)
  return join(EXTRACT_DIR, hits[0])
}

if (!checkOnly) {
  if (!existsSync(DEB_DIR)) throw new Error(`缺少 ${DEB_DIR}`)
  rmSync(EXTRACT_DIR, { recursive: true, force: true })
  mkdirSync(EXTRACT_DIR, { recursive: true })
  for (const deb of readdirSync(DEB_DIR).filter(f => f.endsWith('.deb'))) {
    const dir = join(EXTRACT_DIR, basename(deb, '.deb'))
    mkdirSync(dir, { recursive: true })
    const cwd = process.cwd()
    process.chdir(dir)
    // Windows 上 tar 无法创建 deb 内的符号链接（非零退出），真实文件仍然会解出来——
    // 容忍退出码，靠后面的 existsSync 校验兜底（缺文件会立刻报错）。
    const tryTar = (args) => {
      try { execFileSync('tar', args, { stdio: 'ignore' }) } catch { /* 见上 */ }
    }
    try {
      tryTar(['-xf', join(DEB_DIR, deb)])
      if (existsSync('data.tar.xz')) tryTar(['-xf', 'data.tar.xz'])
      else if (existsSync('data.tar.gz')) tryTar(['-xf', 'data.tar.gz'])
      else if (existsSync('data.tar.zst')) tryTar(['--zstd', '-xf', 'data.tar.zst'])
    } finally {
      process.chdir(cwd)
    }
  }

  mkdirSync(JNI_DIR, { recursive: true })
  for (const f of readdirSync(JNI_DIR)) rmSync(join(JNI_DIR, f), { force: true })

  // node 二进制 → libnodeexec.so（必须在 nativeLibraryDir 才可执行）
  const nodeSrc = readdirSync(EXTRACT_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('nodejs'))
    .map(d => join(EXTRACT_DIR, d.name, PREFIX, 'bin', 'node'))
    .find(p => existsSync(p))
  if (nodeSrc === undefined) throw new Error('未找到 node 二进制')
  copyFileSync(nodeSrc, join(JNI_DIR, 'libnodeexec.so'))
  console.log(`node 二进制 → libnodeexec.so (${(statSync(nodeSrc).size / 1048576).toFixed(1)} MB)`)

  for (const { from, to } of LIB_SOURCES) {
    const [pkg, ...rest] = from.split('/')
    const src = join(findExtract(pkg), PREFIX, ...rest)
    if (!existsSync(src)) throw new Error(`缺少库文件: ${from}（查 ${src}）`)
    copyFileSync(src, join(JNI_DIR, to))
  }
  console.log(`共复制 ${readdirSync(JNI_DIR).length} 个文件到 jniLibs`)

  // 补 NEEDED/SONAME（对所有产物统一处理；找不到旧名不报错，找到就补）
  for (const f of readdirSync(JNI_DIR)) {
    const p = join(JNI_DIR, f)
    const buf = readFileSync(p)
    let touched = 0
    for (const [oldName, newName] of RENAME) touched += patchString(buf, oldName, newName)
    if (touched > 0) {
      writeFileSync(p, buf)
      console.log(`补丁 ${f}: ${touched} 处版本后缀名`)
    }
  }
}

/* ---------------- 闭环校验（每次都跑） ---------------- */

const files = readdirSync(JNI_DIR)
const present = new Set(files)
let failed = false
const report = []
for (const f of files) {
  const { needed, soname, maxAlign } = parseElf(readFileSync(join(JNI_DIR, f)))
  const missing = needed.filter(n => !present.has(n) && !SYSTEM_LIBS.has(n))
  const alignKb = maxAlign / 1024
  report.push({ f, soname, needed, missing, alignKb })
  if (missing.length > 0) failed = true
}
console.log('\n=== 闭环校验 ===')
for (const r of report) {
  const flag = r.missing.length > 0 ? '✗' : '✓'
  console.log(`${flag} ${r.f}  soname=${r.soname ?? '(无)'}  align=${r.alignKb}KB`)
  console.log(`    needs: ${r.needed.join(', ') || '(无)'}`)
  if (r.missing.length > 0) console.log(`    !! 缺失: ${r.missing.join(', ')}`)
}
const badAlign = report.filter(r => r.alignKb < 16)
if (badAlign.length > 0) console.log(`\n注意：${badAlign.map(r => r.f).join(', ')} 为 4KB 页对齐（16KB 页设备上可能加载失败）`)
if (failed) {
  console.error('\n校验失败：存在未满足的依赖')
  process.exit(1)
}
console.log('\n校验通过：依赖闭环完整')
