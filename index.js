/**
 * dsh-model-latency-badge — Host half.
 *
 * Measures the first-content-chunk latency of every provider/model in the
 * LLM catalog through a direct one-shot `ctx.llm.stream()` call, keeps the
 * results in memory, and serves them over two HTTP routes:
 *
 *   GET /mlb/results
 *   GET /mlb/measure?provider=<p>&model=<m>
 *
 * The client half renders the badges in the model picker label slot.
 */

export const name = 'dsh-model-latency-badge'

export const inject = ['llm', 'webServer']

const ROUTE_PREFIX = '/mlb'
const SWEEP_INTERVAL_MS = 15 * 60 * 1000
/** A model measured inside this window is not re-measured by the sweep. */
const MIN_AGE_MS = 2 * 60 * 1000
/** Per-model call budget; first-chunk latency needs only a short window. */
const CALL_TIMEOUT_MS = 15 * 1000
const CONCURRENCY = 3
const SWEEP_MAX_MODELS = 200

const probeText = 'ping'
/**
 * Output budget for the probe. One token is not enough: a model that emits
 * reasoning before content would be truncated before its first content chunk
 * and look unreachable. A small budget still ends the call immediately after
 * the first chunk (we abort the stream ourselves).
 */
const PROBE_MAX_TOKENS = 32

/** Wire values tried when a provider rejects the effort the adapter defaulted to. */
const FALLBACK_EFFORTS = ['medium', 'low', 'high', 'max', 'xhigh']

/** Measure one model: time to the first content chunk, or a failure verdict. */
async function measureOne(ctx, provider, model, timeoutMs, effort) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  let firstChunkAt = 0
  let finishReason = ''
  let failure = ''
  try {
    const stream = ctx.llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: probeText }] }],
      maxTokens: PROBE_MAX_TOKENS,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      const type = chunk && chunk.type
      if (type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta') {
        if (firstChunkAt === 0) firstChunkAt = Date.now() - started
        break
      }
      if (type === 'finish') {
        const reason = chunk && chunk.reason
        finishReason = (reason && reason.kind) || 'unknown'
        if (finishReason === 'error' || finishReason === 'aborted') {
          failure = (reason && reason.failure && (reason.failure.message || reason.failure.code)) || finishReason
        }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(deadline)
  }
  if (firstChunkAt > 0) {
    return { provider, model, ok: true, ms: firstChunkAt, at: Date.now() }
  }
  if (failure !== '') {
    return { provider, model, ok: false, ms: Date.now() - started, error: failure, at: Date.now() }
  }
  if (finishReason === 'stop' || finishReason === 'max-tokens') {
    // Completed without any content chunk: still a reachable endpoint.
    return { provider, model, ok: true, ms: Date.now() - started, at: Date.now() }
  }
  return { provider, model, ok: false, ms: Date.now() - started, error: finishReason || 'no-response', at: Date.now() }
}

/** Run `fn` with a bounded number of concurrent operations. */
async function mapLimit(items, limit, fn) {
  const queue = [...items]
  const workers = []
  for (let i = 0; i < Math.min(limit, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        await fn(item)
      }
    })())
  }
  await Promise.all(workers)
}

export function apply(ctx, config = {}) {
  const timeoutMs = config.callTimeoutMs ?? CALL_TIMEOUT_MS
  const refreshIntervalMs = config.refreshIntervalMs ?? SWEEP_INTERVAL_MS
  const minAgeMs = config.minAgeMs ?? MIN_AGE_MS
  const maxModels = config.maxModels ?? SWEEP_MAX_MODELS

  const entries = new Map()
  const pending = new Set()
  /** key -> reasoning effort ids the catalog advertises for that model. */
  const efforts = new Map()
  let rev = 0
  let sweepRunning = false
  let sweepQueued = false

  const effortIdsOf = (model) => {
    const reasoning = model && model.reasoning
    if (reasoning === undefined || !Array.isArray(reasoning.efforts)) return []
    return reasoning.efforts.map((effort) => effort && effort.id).filter((id) => typeof id === 'string')
  }

  /**
   * Probe one model, retrying with a declared reasoning effort when the
   * provider rejects the default one. Some gateways answer "this model does
   * not support that thinking level" instead of choosing their own default.
   */
  async function probe(provider, model, timeoutMs) {
    const key = provider + '/' + model
    let entry = await measureOne(ctx, provider, model, timeoutMs, undefined)
    if (entry.ok) return entry
    const match = /reasoning effort|思考强度|UNSUPPORTED/i.test(entry.error || '')
    if (!match) return entry
    const candidates = efforts.get(key) || []
    let best = entry
    for (const effort of candidates.slice(0, 3)) {
      const retried = await measureOne(ctx, provider, model, timeoutMs, effort)
      if (retried.ok) return retried
      best = retried
    }
    // The catalog does not always surface an adapter's effort table, so fall
    // back to the usual wire values; `medium` is the most common single tier.
    for (const effort of FALLBACK_EFFORTS) {
      if (candidates.includes(effort)) continue
      const retried = await measureOne(ctx, provider, model, timeoutMs, effort)
      if (retried.ok) return retried
    }
    return best
  }

  const touch = () => {
    rev += 1
    return rev
  }

  const storeState = () => ({
    rev,
    results: Object.fromEntries(entries),
    measuring: pending.size,
  })

  const writeJson = (res, payload, status = 200) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(body)
  }

  /** Enumerate the live catalog and measure whatever is stale or absent. */
  async function sweep(force) {
    if (sweepRunning) {
      sweepQueued = true
      return
    }
    sweepRunning = true
    try {
      let targets = []
      try {
        for (const provider of ctx.llm.listProviders()) {
          let models = []
          try {
            models = await ctx.llm.listModels(provider.id)
          } catch {
            continue
          }
          for (const model of models) {
            const key = provider.id + '/' + model.id
            efforts.set(key, effortIdsOf(model))
            const existing = entries.get(key)
            const fresh = existing !== undefined && Date.now() - existing.at < minAgeMs && !force
            if (!fresh) targets.push({ provider: provider.id, model: model.id })
            if (targets.length >= maxModels) break
          }
          if (targets.length >= maxModels) break
        }
      } catch (error) {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn('dsh-model-latency-badge: catalog enumeration failed: %s', String(error))
        }
      }
      await mapLimit(targets, CONCURRENCY, async (target) => {
        const key = target.provider + '/' + target.model
        if (pending.has(key)) return
        pending.add(key)
        try {
          const entry = await probe(target.provider, target.model, timeoutMs)
          entries.set(key, entry)
          touch()
        } finally {
          pending.delete(key)
          touch()
        }
      })
    } finally {
      sweepRunning = false
      if (sweepQueued) {
        sweepQueued = false
        void sweep(force)
      }
    }
  }

  /** Measure a single model on demand; used by the badge for visible rows. */
  async function measure(provider, model) {
    const key = provider + '/' + model
    if (!efforts.has(key)) {
      try {
        for (const info of await ctx.llm.listModels(provider)) {
          efforts.set(provider + '/' + info.id, effortIdsOf(info))
        }
      } catch {
        // Catalog unavailable for this provider: probe without an effort hint.
      }
    }
    if (pending.has(key)) {
      const existing = entries.get(key)
      if (existing !== undefined) return existing
      return { provider, model, ok: false, ms: 0, error: 'measuring', at: Date.now() }
    }
    pending.add(key)
    try {
      const entry = await probe(provider, model, timeoutMs)
      entries.set(key, entry)
      touch()
      return entry
    } finally {
      pending.delete(key)
      touch()
    }
  }

  // HTTP routes for the client half.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      const url = new URL(req.url || '', 'http://placeholder')
      const path = url.pathname.replace(/\/+$/, '')
      const provider = url.searchParams.get('provider')
      const model = url.searchParams.get('model')
      if (path === '/mlb/results') {
        writeJson(res, storeState())
        return
      }
      if (path === '/mlb/catalog') {
        void (async () => {
          const providers = []
          for (const provider of ctx.llm.listProviders()) {
            let models = []
            try {
              models = await ctx.llm.listModels(provider.id)
            } catch (error) {
              providers.push({ id: provider.id, error: String(error) })
              continue
            }
            providers.push({
              id: provider.id,
              models: models.map((info) => ({
                id: info.id,
                name: info.name,
                efforts: effortIdsOf(info),
                defaultEffort: info.reasoning && info.reasoning.defaultEffort,
              })),
            })
          }
          writeJson(res, { providers })
        })().catch((error) => writeJson(res, { ok: false, error: String(error) }, 500))
        return
      }
      if (path === '/mlb/measure') {
        if (!provider || !model) {
          writeJson(res, { ok: false, error: 'missing provider or model' }, 400)
          return
        }
        measure(provider, model)
          .then((entry) => writeJson(res, { ok: true, entry }))
          .catch((error) => writeJson(res, { ok: false, error: String(error) }, 500))
        return
      }
      writeJson(res, { ok: false, error: 'not-found' }, 404)
    },
  }), 'dsh-model-latency-badge: routes')

  // Background sweep: first sweep shortly after activation, then periodically.
  ctx.effect(() => {
    setTimeout(() => { void sweep(false) }, 1200)
    const timer = setInterval(() => { void sweep(false) }, refreshIntervalMs)
    return () => clearInterval(timer)
  }, 'dsh-model-latency-badge: sweep')

  // Re-sweep when the model catalog changes.
  ctx.effect(() => {
    const onCatalog = () => {
      for (const key of [...entries.keys()]) {
        const entry = entries.get(key)
        if (entry !== undefined && Date.now() - entry.at < minAgeMs) continue
        void sweep(false)
        return
      }
      void sweep(false)
    }
    ctx.on('llm/models-updated', onCatalog)
    ctx.on('llm/adapters-updated', onCatalog)
    ctx.on('settings/document-updated', onCatalog)
  }, 'dsh-model-latency-badge: catalog events')
}
