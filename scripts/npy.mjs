/**
 * dsh-insights · 極簡 .npy v1.0 讀寫(僅 '<f4' little-endian float32 C-order)。
 * 供消融腳本讀取 dsh-wemm-poc/results/cache/ 快取向量,零第三方依賴。
 */
import { readFile, writeFile } from 'node:fs/promises'

/** 讀取 .npy → { data: Float32Array, shape: number[] }。 */
export async function readNpy(path) {
  const buf = await readFile(path)
  if (buf.length < 10 || buf[0] !== 0x93 || buf.toString('latin1', 1, 6) !== 'NUMPY') {
    throw new Error(`not an npy file: ${path}`)
  }
  const major = buf[6]
  let headerLen
  let off
  if (major === 1) {
    headerLen = buf.readUInt16LE(8)
    off = 10
  } else {
    headerLen = buf.readUInt32LE(8)
    off = 12
  }
  const header = buf.toString('latin1', off, off + headerLen)
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1]
  if (descr !== '<f4') throw new Error(`unsupported dtype '${descr}' in ${path} (only <f4)`)
  if (/'fortran_order':\s*True/.test(header)) throw new Error(`fortran order unsupported: ${path}`)
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1]
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number)
  if (!shape || shape.some((n) => !Number.isInteger(n))) throw new Error(`bad shape in ${path}: ${header}`)
  const count = shape.reduce((a, b) => a * b, 1)
  const dataOff = off + headerLen
  const data = new Float32Array(count)
  for (let i = 0; i < count; i++) data[i] = buf.readFloatLE(dataOff + i * 4)
  return { data, shape }
}

/** 寫出 2-D float32 .npy(v1.0)。rows: number[][] 或 Float32Array[]。 */
export async function writeNpy(path, rows) {
  const n = rows.length
  const d = n > 0 ? rows[0].length : 0
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${n}, ${d}), }`
  // v1.0:magic(6)+ver(2)+hlen(2)+header,總長須 64 字節對齊,header 以 \n 結尾。
  const base = 10 + header.length + 1
  const pad = (64 - (base % 64)) % 64
  const headerText = header + ' '.repeat(pad) + '\n'
  const out = Buffer.alloc(10 + headerText.length + n * d * 4)
  out.write('\x93NUMPY', 0, 'latin1')
  out[6] = 1
  out[7] = 0
  out.writeUInt16LE(headerText.length, 8)
  out.write(headerText, 10, 'latin1')
  let p = 10 + headerText.length
  for (const row of rows) {
    if (row.length !== d) throw new Error('ragged rows')
    for (let i = 0; i < d; i++) {
      out.writeFloatLE(row[i], p)
      p += 4
    }
  }
  await writeFile(path, out)
}

/** Float32Array 2-D 視圖。 */
export function rows2d(data, shape) {
  const [n, d] = shape
  const rows = new Array(n)
  for (let i = 0; i < n; i++) rows[i] = data.subarray(i * d, (i + 1) * d)
  return rows
}
