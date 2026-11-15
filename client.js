/**
 * dsh-model-latency-badge — Client half (Web GUI).
 *
 * Registers the `conversation.input.model.label` slot next to the official
 * model picker and renders a latency badge beside every provider/model:
 *
 *   green dot + `<ms>ms`  → measured, reachable
 *   red dot   + 不可用    → measured, unreachable / timed out
 *   gray dot              → not measured yet
 *
 * Data comes from the host half over same-origin HTTP (the browser carries
 * the GUI auth cookie):
 *   GET /mlb/results
 *   GET /mlb/measure?provider=<p>&model=<m>
 *
 * Hand-written bundles have no build step, so this artifact uses the browser
 * module-table factory form directly (`window.__ModuleLoader__.load`), not ESM.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-latency-badge',
  factory(require) {
    const React = require('react')
    /** ui-primitives gives the official Tag look for a model's catalog badge. */
    let Tag
    try {
      Tag = require('@deepseek-ai/dsh-client-ui-primitives').Tag
    } catch {
      Tag = undefined
    }
    /** Filled from the plugin context: localizes a badge's text payload. */
    const api = { resolveText: (text) => (typeof text === 'string' ? text : (text && text.text) || '') }

    const GREEN = '#22c55e'
    const RED = '#ef4444'
    const GRAY = '#9ca3af'
    const POLL_MS = 3000

    // Module-level store; shared across every mounted badge so one poll feeds all.
    const store = {
      results: {},
      rev: 0,
      inFlight: new Set(),
      apply(updates) {
        let changed = false
        for (const key of Object.keys(updates)) {
          const value = updates[key]
          const prev = this.results[key]
          if (prev === undefined || prev.at !== value.at) {
            this.results[key] = value
            changed = true
          }
        }
        if (changed) this.rev += 1
      },
    }

    async function fetchState() {
      try {
        const res = await fetch('/mlb/results', { credentials: 'same-origin' })
        if (!res.ok) return
        const payload = await res.json()
        if (payload && payload.results && payload.rev !== undefined) {
          store.results = payload.results
          store.rev = payload.rev
        }
      } catch {
        // Host half unreachable (desktop bridge, offline GUI): badges stay gray.
      }
    }

    function requestMeasure(providerId, modelId) {
      const key = providerId + '/' + modelId
      if (store.inFlight.has(key)) return
      const existing = store.results[key]
      if (existing !== undefined && Date.now() - existing.at < 90 * 1000) return
      store.inFlight.add(key)
      fetch(`/mlb/measure?provider=${encodeURIComponent(providerId)}&model=${encodeURIComponent(modelId)}`, { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.json() : null))
        .then((payload) => {
          if (payload && payload.ok && payload.entry) store.apply({ [key]: payload.entry })
        })
        .catch(() => {})
        .finally(() => {
          store.inFlight.delete(key)
        })
    }

    function h(type, props, ...children) {
      return React.createElement(type, props, ...children)
    }

    function Dot(color, title) {
      return h('span', {
        'aria-label': title || color,
        role: 'img',
        style: {
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: color,
          flex: '0 0 auto',
          verticalAlign: 'middle',
          marginLeft: '6px',
          marginRight: '6px',
          opacity: 0.92,
        },
      })
    }

    function Badge(entry) {
      if (entry === undefined) return Dot(GRAY, 'latency not measured')
      if (entry.ok) {
        return h('span', {
          title: `model latency: ${entry.ms}ms (${new Date(entry.at).toLocaleString()})`,
          style: { display: 'inline-flex', alignItems: 'center', color: GREEN, fontSize: '11px', fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap' },
        }, Dot(GREEN), `${entry.ms}ms`)
      }
      return h('span', {
        title: `model unavailable: ${entry.error || 'no-response'}`,
        style: { display: 'inline-flex', alignItems: 'center', color: RED, fontSize: '11px', fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap' },
      }, Dot(RED), '不可用')
    }

    function ModelLatencyBadge(props) {
      const providerId = props && props.provider && props.provider.id
      const modelId = props && props.model && props.model.id
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => force, [store.rev])

      const entry = providerId && modelId ? store.results[providerId + '/' + modelId] : undefined

      React.useEffect(() => {
        if (providerId && modelId) requestMeasure(providerId, modelId)
      }, [providerId, modelId])

      const label = (props && props.model && props.model.name) || modelId || ''
      const badge = Badge(entry)
      const before = props && props.placement === 'trigger'
      const model = props && props.model
      const toneTag = model && model.badge !== undefined && Tag !== undefined
        ? h(Tag, { tone: model.badge.tone, style: { marginLeft: '4px', flex: '0 0 auto' } }, api.resolveText(model.badge.text))
        : null
      const core = before
        ? [badge, label, toneTag]
        : [label, toneTag, badge]
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } }, ...core)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Read locale without declaring it in inject: a missing service must
        // not block the badge, and cordis throws on an undeclared read.
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.resolveText === 'function') {
          api.resolveText = (text) => {
            try {
              const resolved = locale.resolveText(text)
              return typeof resolved === 'string' ? resolved : (text && text.text) || ''
            } catch {
              return typeof text === 'string' ? text : (text && text.text) || ''
            }
          }
        }
        ctx.slots.inject('conversation.input.model.label', () =>
          ctx.slots.register(
            { name: 'conversation.input.model.label' },
            ModelLatencyBadge,
          ),
        )

        ctx.effect(() => {
          void fetchState()
          const timer = setInterval(() => { void fetchState() }, POLL_MS)
          return () => clearInterval(timer)
        }, 'dsh-model-latency-badge: poll state')
      },
    }
  },
})
