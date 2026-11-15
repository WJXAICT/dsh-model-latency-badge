# dsh-model-latency-badge

在**模型选择器**上为每个模型显示自动测速徽章：绿色代表可用（显示毫秒延迟），红色代表不可用。

## 行为

**Host half**（`index.js`）

- 通过 `ctx.llm.listProviders()` + `ctx.llm.listModels(provider)` 枚举全部模型；
- 对每个模型发起一次一次性探测调用：`ctx.llm.stream({ provider, model, messages:[{role:'user',content:[{type:'text',text:'ping'}]}], maxTokens:32 })`；
- 计时口径：**从发起调用到收到第一个内容块**（`text-delta` / `reasoning-delta` / `tool-call-delta`），即首包延迟；
- 成功 → 绿色，记录 `ms`；调用超时（默认 15s）、adapter 失败（finish.reason.kind 为 `error`/`aborted`）或无响应 → 红色，记录错误；
- 若失败原因是「思考强度不被支持」，会用 `medium`/`low`/`high`/`max`/`xhigh` 依次重试一次，避免把只是档位不匹配的模型误判为不可用；
- 后台 sweep：激活后 1.2s 内开始全量测速，之后每 15 分钟刷新，并监听 `llm/models-updated` / `llm/adapters-updated` / `settings/document-updated` 事件触发重扫；
- 结果保存在内存（key = `provider/model`），通过 HTTP 路由暴露（前缀刻意避开 `/api`，那段被 RPC 鉴权层接管）：

| 路由 | 说明 |
| --- | --- |
| `GET /mlb/results` | 全量结果 + `rev` 修订号 |
| `GET /mlb/measure?provider=<p>&model=<m>` | 按需测单个模型（徽章挂载时自动触发） |
| `GET /mlb/catalog` | 目录快照（provider → models、可用档位），用于自查 |

**Client half**（`client.js`）

- 注册 `conversation.input.model.label` slot（`order: 6`），在官方模型选择器的每行模型名旁渲染徽章；
- 保留官方目录徽章（`model.badge`，如「限时免费」）并使用 ui-primitives 的 `Tag` 渲染；
- 颜色规则：
  - 🟢 绿点 + `<ms>ms` —— 测速成功，模型可用；
  - 🔴 红点 + `不可用` —— 测速失败/超时，模型不可用；
  - ⚪ 灰点 —— 尚未测速（后台 sweep 会补齐）；
- 菜单打开时，对当前可见的每一行自动触发一次按需测速；随后每 3 秒轮询 `results` 刷新全部徽章。

## 安装

```
plugin_manager action=install_bundle target=<bundle 目录>
```

重启 dsh（或在 GUI 刷新）后生效；插件在 profile 中启用后，模型选择器每行即出现测速徽章。

## 配置（可选）

通过插件配置传入：

```json
{
  "callTimeoutMs": 15000,
  "refreshIntervalMs": 900000,
  "minAgeMs": 120000,
  "maxModels": 200
}
```

## 数据流

```
浏览器（模型选择器 slot）──fetch──▶ Host webServer 路由 ──▶ ctx.llm.stream 探测 ──▶ 首块延迟
        ▲                              │
        └── 每 3s 轮询 results ◀──────┘ 内存 Map（rev 递增触发刷新）
```

桌面 Electron 场景下，Web GUI 的 fetch 经 IPC bridge 转发；若 bridge 无法转发该命名路由，徽章显示灰点（保持优雅降级，不阻塞模型选择）。
