/**
 * dsh-insights · memory v2 測試基建。
 *
 * - makeFakeStorage:模擬 dsh-storage-json 關鍵語義——open 只載入 descriptor
 *   內声明的表(缺表初始化為空);每次寫入/close 只序列化 descriptor 內的表
 *   (回滾舊版 → memory_vectors 被靜默丟棄的真實語義,SPEC §11 / 隊長裁決)。
 * - makeCtx:最小 cordis Context 替身(tools.register / provide / get /
 *   inject / effect),可注入假 embedder。
 * - makeEmbedder:可控假 embedder(固定向量 / 拋錯 / 永不返回)。
 */
import assert from 'node:assert/strict'

// ── fake storage(dsh-storage-json 語義子集) ────────────────────────────────

export function makeFakeStorage() {
  // 持久介質:domainName → { tables: Map<table, Map<key, value>> }
  const medium = new Map()

  function flush(name, spec, state) {
    // serialize() 只寫 descriptor 內的表——回滾語義的關鍵。
    const tables = new Map()
    for (const t of Object.keys(spec.tables)) {
      tables.set(t, new Map([...state.get(t)].map(([k, v]) => [k, structuredClone(v)])))
    }
    medium.set(name, { tables })
  }

  const storageDomain = {
    async open(spec) {
      const persisted = medium.get(spec.name) ?? { tables: new Map() }
      const state = new Map()
      for (const t of Object.keys(spec.tables)) {
        state.set(t, new Map(persisted.tables.get(t) ?? []))
      }
      return {
        table(name) {
          if (!state.has(name)) throw new Error(`unknown table '${name}'`)
          const records = state.get(name)
          return {
            get: (k) => records.get(k),
            entries: () => [...records.entries()][Symbol.iterator](),
            get size() { return records.size },
            async put(k, v) { records.set(k, structuredClone(v)); flush(spec.name, spec, state) },
            async delete(k) { records.delete(k); flush(spec.name, spec, state) },
          }
        },
        async close() { flush(spec.name, spec, state) },
      }
    },
  }

  return { medium, storageDomain }
}

// ── fake cordis Context ─────────────────────────────────────────────────────

export function makeCtx({ storageDomain, services = {} } = {}) {
  const tools = new Map()
  const provided = new Map()
  const effects = []
  const getCalls = []
  const ctx = {
    storageDomain,
    tools: {
      register(tool) {
        assert.ok(!tools.has(tool.name), `duplicate tool ${tool.name}`)
        tools.set(tool.name, tool)
      },
    },
    provide(name, svc) { provided.set(name, svc) },
    get(name) {
      getCalls.push(name)
      return services[name]
    },
    inject(_names, _cb) { /* 投影設施在測試中不激活 */ },
    // cordis 語義:effect(execute) 立即調用 execute,其返回值為清理函數。
    effect(execute, _name) {
      const cleanup = execute()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
  }
  return {
    ctx,
    tools,
    provided,
    getCalls,
    async dispose() {
      for (const d of effects.splice(0)) await d()
    },
  }
}

// ── fake embedder ───────────────────────────────────────────────────────────

/**
 * 假 embedder:vectors 由 seed 函數生成(默認:文本長度做特徵的確定性向量)。
 * mode: 'ok' | 'throw' | 'hang'
 */
export function makeEmbedder({ mode = 'ok', dim = 4, seed } = {}) {
  const calls = []
  return {
    calls,
    async embedTexts(texts, opts) {
      calls.push({ texts: [...texts], opts })
      if (mode === 'hang') return new Promise(() => {})
      if (mode === 'throw') {
        const err = new Error(`embedder unavailable (fingerprint: ${opts?.backend}@${opts?.dim})`)
        err.name = 'EmbedderUnavailableError'
        throw err
      }
      const d = opts?.dim ?? dim
      return texts.map((text) => (seed ?? defaultSeed)(text, d))
    },
    async health() { return { mlx: 'down', tf: 'up' } },
  }
}

/** 確定性假向量:按字符碼分桶,可控制餘弦相似度。 */
export function defaultSeed(text, dim) {
  const v = new Array(dim).fill(0)
  for (let i = 0; i < text.length; i++) {
    v[text.charCodeAt(i) % dim] += 1
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? v.map((x) => x / norm) : v
}

/** 指定 id → 向量的精確控制 seed。 */
export function vectorFor(mapping, dim) {
  return (text, d) => {
    for (const [key, vec] of Object.entries(mapping)) {
      if (text.includes(key)) return vec.slice(0, d)
    }
    return defaultSeed(text, d)
  }
}
