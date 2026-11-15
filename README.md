# dsh-model-latency-badge

A latency badge on every row of the DeepSeek Harness model picker. Each model's first-chunk latency is measured in the background and shown inline, so you can see which model is fast right now before you pick it.

- **green dot + `842ms`** — the model answered; the number is the measured latency
- **red dot + `unavailable`** — the probe failed (upstream error, insufficient balance, timeout)
- **grey dot** — not measured yet (the background sweep fills it in within a minute)

The same badge appears on the composer's model trigger, so the selected model's latency is visible without opening the menu.

## How the latency is measured

For each model the host half opens one streaming call through `ctx.llm.stream` — a single `ping` user message, `maxTokens: 32` — and times **the first content chunk** (`text-delta`, `reasoning-delta` or `tool-call-delta`). That is the number you feel when a reply starts, not the time to the full answer. The call is aborted after 15 s.

Two false-negative cases are handled explicitly:

1. **Reasoning models** emit `reasoning-delta` first and can spend more than one token before any content appears; the probe budget is 32 tokens so they are not cut off and misreported as unavailable.
2. **Reasoning effort mismatch** — some adapters ship a default effort that the upstream rejects ("the reasoning effort value is not supported by the current model"). When the failure matches that message, the probe retries once with each of `medium`, `low`, `high`, `max`, `xhigh` before the model is marked unavailable.

A sweep measures every model with 3 concurrent probes: once ~1 s after activation, then every 15 minutes, and again whenever `llm/models-updated`, `llm/adapters-updated` or `settings/document-updated` fires. Opening the picker also measures the rows on demand and refreshes the badges every 3 s while the page is open.

Probe calls consume tokens — one very short completion per model per 15 minutes, per running host.

## HTTP routes

The host half exposes three read-only routes on the local harness webserver:

| Route | Purpose |
| --- | --- |
| `GET /mlb/results` | all measured entries plus a `rev` counter |
| `GET /mlb/measure?provider=<id>&model=<id>` | measure one model on demand |
| `GET /mlb/catalog` | the model catalog snapshot the sweep works from |

These routes are **not** behind the DSH access check — anything that can reach the local webserver can read latency numbers and trigger a probe. They expose no credentials and no conversation data.

## Install

```sh
dsh plugin add dsh-model-latency-badge
```

Enable it in **Settings → Plugins**, then reload the Web GUI. The badges appear in the model picker.

## Uninstall

```sh
dsh plugin remove dsh-model-latency-badge
```

## Files

| File | Role |
| --- | --- |
| `index.js` | host half: sweep, probe, `/mlb/*` routes |
| `client.js` | client half: the badge component registered on `conversation.input.model.label` |
| `cordis.patch.yml` | bundle manifest that inserts the plugin |
| `locale/*.json` | zh / en strings |

## License

MIT
