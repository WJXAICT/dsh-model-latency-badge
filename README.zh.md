# dsh-model-latency-badge

在 DeepSeek Harness 的模型选择器每一行显示测速徽章。每个模型的首包延迟在后台自动测量并就地展示，选模型之前就能看出谁现在快。

- **绿点 + `842ms`** — 模型有响应，数字是实测延迟
- **红点 + `不可用`** — 探测失败（上游报错、余额不足、超时）
- **灰点** — 还没测（后台 sweep 会在一分钟内补上）

输入框的模型按钮上也带同一个徽章，不打开菜单也能看到当前模型的延迟。

## 延迟怎么测

Host 半对每个模型发起一次流式调用（`ctx.llm.stream`，单条 `ping` 用户消息，`maxTokens: 32`），计时的是**第一个内容块**（`text-delta` / `reasoning-delta` / `tool-call-delta`）出现的时刻——也就是你按下发送后「开始出字」的那个延迟，不是完整回答的耗时。15 秒无响应即中止。

两类假阴性做了专门处理：

1. **思考型模型**先出 `reasoning-delta`，1 个 token 就被截断会误判成不可用，所以探测预算给到 32 token。
2. **思考强度不匹配**：部分 adapter 的默认档位不被上游接受（报 “the reasoning effort value is not supported by the current model”）。命中该错误时，会依次用 `medium`、`low`、`high`、`max`、`xhigh` 重试，全部失败才标为不可用。

Sweep 以 3 并发测完所有模型：激活后约 1 秒首扫，之后每 15 分钟一次，并在 `llm/models-updated`、`llm/adapters-updated`、`settings/document-updated` 触发时重扫。打开选择器时按需测当前行，页面打开期间每 3 秒刷新一次徽章。

探测会消耗 token——每个模型每 15 分钟一次极短补全，按运行中的 host 计。

## HTTP 路由

Host 半在本地 webserver 上暴露三个只读路由：

| 路由 | 用途 |
| --- | --- |
| `GET /mlb/results` | 全部结果 + `rev` 修订号 |
| `GET /mlb/measure?provider=<id>&model=<id>` | 按需测单个模型 |
| `GET /mlb/catalog` | sweep 所用的模型目录快照 |

这三个路由**不在** DSH 的访问校验之后——能连到本地 webserver 的任何东西都能读到延迟数字并触发一次探测。它们不暴露凭据，也不涉及会话内容。

## 安装

```sh
dsh plugin add dsh-model-latency-badge
```

在**设置 → 插件**里启用，然后刷新 Web GUI，模型选择器里就会出现徽章。

## 卸载

```sh
dsh plugin remove dsh-model-latency-badge
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | host 半：sweep、探测、`/mlb/*` 路由 |
| `client.js` | client 半：注册在 `conversation.input.model.label` 的徽章组件 |
| `cordis.patch.yml` | 插入插件的 bundle manifest |
| `locale/*.json` | 中英文文案 |

## 许可

MIT
