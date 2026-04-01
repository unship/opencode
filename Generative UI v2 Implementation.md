# Generative UI v2：在 OpenCode Web 里重新实现

这是在上一轮实现被 revert 之后的第二次尝试。目标不变：把大模型生成的交互式 HTML 控件接入 OpenCode Web 的会话流。但这次在架构选择上做了几个不同的决定。

参考：

- [Reverse-engineering Claude's generative UI](https://michaellivs.com/blog/reverse-engineering-claude-generative-ui)
- [pi-generative-ui](https://github.com/Michaelliv/pi-generative-ui)
- 上一轮实现的文档：`Generative UI in OpenCode Web.md`

## 和上一轮的关键差异

上一轮走过一条"先跑通再加固"的路径：先同文档注入，再 morphdom 增量 diff，再 Shadow DOM，再 document proxy……每一步都是被问题推着走的。这一轮直接从终态开始：

| 决策点 | 上一轮 | 这一轮 |
|--------|--------|--------|
| 样式隔离 | 先同文档，后迁移 Shadow DOM | 直接 Shadow DOM |
| 流式渲染 | morphdom 增量 diff | 非流式 v1，工具完成后一次性渲染 |
| 脚本执行 | 流式阶段收集，完成后执行 | 完成后统一注入并执行 |
| prefillPrompt 行为 | 写入 composer，用户手动发送 | 自动发送（auto-send） |
| 文件组织 | 独立 widget-tool.tsx | 内联在 message-part.tsx |
| read_me 定位 | 从风格指南逐步演化为行为协议 | 初始版本就是行为协议 |

最大的理念差异是：**不做渐进式迁移，直接面向已知的终态设计**。上一轮的文档已经把问题边界看清楚了，这一轮只需要按图施工。

## 整体架构

```text
模型调用 read_me({ modules: ["interactive"] })
  -> 返回设计规则 + 行为协议 + 正反例 + 自检清单
  ->
模型调用 show_widget({ i_have_seen_read_me: true, title: "...", widget_code: "..." })
  -> 工具把 widget_code 持久化到 ToolPart.metadata
  -> 前端 ToolRegistry 匹配到 show_widget renderer
  ->
message-part.tsx 中的 show_widget renderer：
  -> 等待工具状态变为 completed
  -> 创建 Shadow DOM，注入 HTML（去掉 script）
  -> 通过 document proxy 执行 script
  -> 注入 window.prefillPrompt(text) bridge
  ->
用户在 widget 中操作，点击最终按钮
  -> 按钮的 addEventListener 调用 window.prefillPrompt(text)
  -> 触发 CustomEvent("opencode:widget-prompt")，bubbles + composed 穿透 Shadow DOM
  ->
session.tsx 监听 opencode:widget-prompt
  -> 构建 FollowupDraft
  -> 调用 sendFollowupDraft 自动发送
  -> 对话继续
```

关键文件：

- `packages/opencode/src/tool/read_me.ts` — 懒加载设计指南工具
- `packages/opencode/src/tool/read_me_guidelines.txt` — 完整的行为协议文档
- `packages/opencode/src/tool/show_widget.ts` — widget 渲染工具
- `packages/ui/src/components/message-part.tsx` — widget 前端渲染器（内联）
- `packages/app/src/pages/session.tsx` — prefillPrompt 事件监听 + 自动发送

## `read_me`：从第一天就当行为协议写

### 吸取上一轮的教训

上一轮最重要的结论是：**`read_me` 比 `show_widget` 更重要**。模型能生成 HTML 不等于能生成能工作的 HTML。上一轮的 `read_me` 从"风格指南"逐步演化成"行为协议"，过程中反复踩坑。

这一轮直接把 `read_me_guidelines.txt` 写成了行为协议的形式：

```text
# 结构规则
CSS first, HTML next, <script> last.
No <!DOCTYPE>, <html>, <head>, <body>. Fragment only.

# 脚本规则
NEVER use inline event handlers (onclick, onchange).
Always use addEventListener.
document.querySelector works — host patches it to shadow root.

# Host Bridge API
window.prefillPrompt(text) — THE ONLY way to complete widget interaction.

# 正确流程
1. Render UI
2. Let user interact
3. On final button click: assemble prompt, call window.prefillPrompt(text)

# 错误模式（明确列出）
- "Sent!" without prefillPrompt() — WRONG
- window.selectedItems — WRONG
- navigator.clipboard.writeText — WRONG
- Updating local UI only — WRONG

# 自检
- Does the final button addEventListener("click", ...) call prefillPrompt?
- Is the prompt assembled from actual user selections?
- If no to either: widget is NOT complete.
```

关键设计：**不只告诉模型"怎么做对"，同时告诉它"哪些常见做法是错的"**。上一轮发现模型很多时候不是不知道 `prefillPrompt`，而是把"本地完成"误当成"对话完成"。所以错误模式列表和自检问题比规则本身更重要。

### 模块化加载

和 Claude 的 `visualize:read_me` 一致，`read_me` 支持按模块加载：

```json
{ "modules": ["interactive", "chart"] }
```

目前支持三个模块：`interactive`、`chart`、`diagram`。实现上是把 `read_me_guidelines.txt` 按 `## Module:` 标题切分，只返回请求的模块加上通用部分。这样不用让模型每次都背着整套设计系统。

### 工具定义

```typescript
export const ReadMeTool = Tool.define("read_me", {
  description: DESCRIPTION,
  parameters: z.object({
    modules: z.array(z.enum(["interactive", "chart", "diagram"])).min(1),
  }),
  async execute(params) {
    // 解析 GUIDELINES，提取通用部分 + 请求模块部分
    // 返回拼接后的文本
    return {
      title: `Loaded guidelines: ${params.modules.join(", ")}`,
      output: sections.join("\n\n"),
      metadata: { modules: params.modules, truncated: false },
    }
  },
})
```

在 UI 层，`read_me` 被加入了 `HIDDEN_TOOLS`：它是系统管道的一部分，用户不需要看到它。

## `show_widget`：非流式 v1 + Shadow DOM

### 为什么这一轮选择非流式

上一轮用 morphdom 做增量 diff，解决了流式渲染闪烁的问题，但也引入了复杂度：

- 每次 `tool-input-delta` 都要尝试解析不完整的 JSON
- morphdom 和 Shadow DOM 的交互需要特殊处理
- 脚本执行时机控制复杂

这一轮选择先做**非流式版本**：等 `tool-call` 完成、工具状态变为 `completed` 后，一次性渲染完整的 `widget_code`。

好处很直接：

1. 不需要修改 `session/processor.ts` — 现有的 `tool-input-delta` 直接 return 即可
2. 不需要 morphdom — 没有增量更新的需求
3. 脚本执行时机天然正确 — DOM 已经完整
4. 实现简单，bug surface 小

代价是用户要等工具调用完成才能看到 widget。对于大多数 widget（几十行到几百行 HTML），这个等待时间可以接受。流式渲染可以作为 v2 的增强。

### 工具定义

```typescript
export const ShowWidgetTool = Tool.define("show_widget", {
  description: DESCRIPTION,
  parameters: z.object({
    i_have_seen_read_me: z.boolean(),
    title: z.string(),
    loading_messages: z.array(z.string()).min(1).max(4),
    widget_code: z.string(),
  }),
  async execute(params) {
    if (!params.i_have_seen_read_me) {
      throw new Error("You must call read_me first.")
    }
    return {
      title: params.title,
      output: "Widget rendered successfully.",
      metadata: {
        title: params.title,
        loading_messages: params.loading_messages,
        widget_code: params.widget_code,
        truncated: false,
      },
    }
  },
})
```

两个设计细节：

1. **`i_have_seen_read_me` 校验**：运行时检查，如果模型没有先调用 `read_me` 就直接调 `show_widget`，会报错。这是 Claude 逆向分析里的 compile-time check 的简化版。
2. **`truncated: false`**：显式标记，跳过 `Tool.define` 里的默认截断逻辑。`widget_code` 可能很长，截断会破坏 HTML。

### Web-only 门控

两个工具都只在 Web 端可用：

```typescript
// registry.ts
...(Flag.OPENCODE_CLIENT === "app" ? [ReadMeTool, ShowWidgetTool] : []),
```

CLI 和 TUI 无法渲染 HTML widget，没有理由暴露这两个工具给模型。

## 前端渲染：Shadow DOM + Document Proxy

### 为什么直接上 Shadow DOM

上一轮的经验已经证明：同文档注入必然导致样式污染。模型生成的 `button { ... }` 会影响宿主页面的所有按钮。这不是"可能"的问题，是"一定"的问题。

所以这一轮直接用 Shadow DOM：

```typescript
function injectWidget(host: HTMLDivElement, widgetCode: string) {
  let shadowRoot = host.shadowRoot
  if (!shadowRoot) {
    shadowRoot = host.attachShadow({ mode: "open" })
  }
  shadowRoot.innerHTML = ""

  // 创建带主题变量的容器
  const wrapper = document.createElement("div")
  for (const [key, value] of Object.entries(WIDGET_THEME_VARS)) {
    wrapper.style.setProperty(key, value)
  }

  // 注入 HTML（去掉 script）
  const htmlWithoutScripts = widgetCode.replace(/<script[\s\S]*?<\/script>/gi, "")
  wrapper.innerHTML = htmlWithoutScripts
  shadowRoot.appendChild(wrapper)

  // DOM 完整后执行脚本
  executeWidgetScripts(shadowRoot, widgetCode)

  // 注入 bridge
  window.prefillPrompt = (text) => {
    host.dispatchEvent(new CustomEvent("opencode:widget-prompt", {
      bubbles: true,
      composed: true,  // 穿透 Shadow DOM
      detail: { text },
    }))
  }
}
```

三步：**注入结构 -> 执行脚本 -> 挂载 bridge**。顺序不能乱。

### Document Proxy：让模型以为自己在普通文档里

Shadow DOM 的经典兼容问题：模型写 `document.querySelector("#myButton")`，在 shadow root 里找不到节点。

解法是给脚本执行注入一个 `document` proxy：

```typescript
function createDocumentProxy(root: ShadowRoot): typeof document {
  return new Proxy(document, {
    get(target, prop, receiver) {
      if (prop === "querySelector")
        return (selector: string) => root.querySelector(selector)
      if (prop === "querySelectorAll")
        return (selector: string) => root.querySelectorAll(selector)
      if (prop === "getElementById")
        return (id: string) => root.querySelector(`#${CSS.escape(id)}`)
      // ... 其他查询方法类似
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
```

脚本通过 `new Function("document", "shadowRoot", code)` 执行，第一个参数绑定到 proxy：

```typescript
const fn = new Function("document", "shadowRoot", code)
fn(docProxy, shadowRoot)
```

这样模型写的 `document.querySelector(...)` 实际操作的是 shadow root 内部的节点，但模型不需要知道这一点。

### 主题变量

widget 通过 CSS 变量获取宿主主题色：

```typescript
const WIDGET_THEME_VARS = {
  "--color-bg": "var(--color-background-base, #1a1a2e)",
  "--color-text": "var(--color-text-base, #e0e0e0)",
  "--color-primary": "var(--color-button-primary-background, #6366f1)",
  // ...
}
```

这些变量设置在 shadow root 内部的 wrapper 元素上。模型在 `read_me` 中被告知使用这些变量，不要硬编码颜色。由于 Shadow DOM 的 CSS 隔离，这些变量不会泄漏到宿主。

### 为什么内联在 message-part.tsx 而不是独立文件

最初创建了独立的 `widget-tool.tsx`，但立刻遇到了循环依赖：

- `message-part.tsx` 需要 `import "./widget-tool"` 来触发 ToolRegistry.register
- `widget-tool.tsx` 需要 `import { ToolRegistry } from "./message-part"` 来调用 register

所有其他工具的渲染器（read、bash、edit、write 等）都是直接在 `message-part.tsx` 底部通过 `ToolRegistry.register` 注册的。保持一致，把 widget renderer 也内联进去，避免循环依赖。

## `prefillPrompt`：自动发送

### 和上一轮的关键区别：auto-send

上一轮的设计是 Claude 风格的 prefill：把文本写进 composer 输入框，让用户看一眼再手动发送。这次直接做了 auto-send。

理由：

1. widget 的交互本身已经是用户的"确认"动作 — 点击最终按钮意味着用户已经做出选择
2. 多一步手动发送会打断"对话流"的感觉
3. 上一轮发现即使 prefill 成功，用户也几乎不会修改内容就发送

### 实现：CustomEvent + sendFollowupDraft

bridge 端（在 message-part.tsx 的 widget renderer 里）：

```typescript
window.prefillPrompt = (text: string) => {
  host.dispatchEvent(new CustomEvent("opencode:widget-prompt", {
    bubbles: true,
    composed: true,  // 穿透 Shadow DOM 边界
    detail: { text },
  }))
}
```

监听端（在 session.tsx 的 Page 组件里）：

```typescript
const handleWidgetPrompt = (e: Event) => {
  const detail = (e as CustomEvent).detail
  if (!detail?.text || typeof detail.text !== "string") return
  const sessionID = params.id
  if (!sessionID) return

  const currentModel = local.model.current()
  const currentAgent = local.agent.current()
  if (!currentModel || !currentAgent) return

  const draft: FollowupDraft = {
    sessionID,
    sessionDirectory: sdk.directory,
    prompt: [{ type: "text", content: text, start: 0, end: text.length }],
    context: [],
    agent: currentAgent.name,
    model: { providerID: currentModel.provider.id, modelID: currentModel.id },
  }
  sendFollowupDraft({ client: sdk.client, sync, globalSync, draft, optimisticBusy: true })
}
```

直接复用了 `sendFollowupDraft` — 和用户在输入框里手动输入、点发送走的是同一条路径。不需要新建任何 API 或消息通道。

### 为什么用 CustomEvent 而不是直接调 prompt.set

因为 widget 运行在 Shadow DOM 里，其脚本上下文没有访问 Solid.js 响应式系统的能力。`window.prefillPrompt` 是一个普通的 JS 函数，widget 脚本可以直接调用。CustomEvent 的 `composed: true` 确保事件能穿透 Shadow DOM 边界到达 document 层，被 session.tsx 捕获。

这是一个干净的隔离：widget 不知道宿主用什么框架，宿主不关心 widget 的内部实现。

## 当前未实现的部分

### 流式渲染

当前是等工具完成后一次性渲染。v2 可以在 `tool-input-delta` 阶段增量解析 partial JSON，提取已完成的 `widget_code` 片段，用 morphdom 做 DOM diff。上一轮已经证明这个方向可行，这里只是优先级的取舍。

### CSP / 安全沙箱

当前版本没有内容安全策略。widget 脚本通过 `new Function` 执行，理论上可以访问宿主的全局变量。v2 可以考虑：

- iframe sandbox 替代 Shadow DOM（更强隔离，但失去 CSS 变量穿透）
- 白名单 CDN 校验（`read_me` 里已经声明了允许的 CDN 列表，但没有运行时检查）
- 对 `widget_code` 做基本的 sanitization（检测 `javascript:` URL 等）

### 多 widget 共存

当前实现会把 `window.prefillPrompt` 挂到全局。如果一个会话里有多个 widget，后面的会覆盖前面的。v2 可以改成每个 widget 有独立的 bridge scope。

### 模型兼容性

上一轮文档里详细记录了模型"知道 prefillPrompt 但不用它"的各种坏模式。这一轮在 `read_me_guidelines.txt` 里通过正反例和自检清单来约束，但最终效果取决于模型的指令遵从能力。这不是代码能完全解决的问题。

## 文件清单

### 新建

| 文件 | 作用 |
|------|------|
| `packages/opencode/src/tool/read_me.ts` | read_me 工具定义 |
| `packages/opencode/src/tool/read_me.txt` | read_me 工具描述 |
| `packages/opencode/src/tool/read_me_guidelines.txt` | 完整行为协议（结构/样式/脚本/bridge/模块规则） |
| `packages/opencode/src/tool/show_widget.ts` | show_widget 工具定义 |
| `packages/opencode/src/tool/show_widget.txt` | show_widget 工具描述（含自检清单） |

### 修改

| 文件 | 改动 |
|------|------|
| `packages/opencode/src/tool/registry.ts` | 导入并注册两个工具，`Flag.OPENCODE_CLIENT === "app"` 门控 |
| `packages/ui/src/components/message-part.tsx` | getToolInfo 增加 show_widget/read_me 条目；read_me 加入 HIDDEN_TOOLS；底部新增 widget renderer（Shadow DOM + document proxy + script execution + prefillPrompt bridge） |
| `packages/app/src/pages/session.tsx` | 新增 `opencode:widget-prompt` 事件监听，auto-send via sendFollowupDraft |

## 总结

和上一轮相比，这次实现更短、更直接。核心原因是上一轮已经把问题空间探索清楚了：

- Shadow DOM 是必须的 — 不经过"先同文档再迁移"的弯路
- read_me 必须是行为协议 — 不经过"先风格指南再收紧"的弯路
- prefillPrompt 的 bridge 设计已经验证过 — 直接复用 CustomEvent + sendFollowupDraft
- 流式渲染可以后做 — 先保证端到端跑通

最终实现改动了 3 个文件，新建了 5 个文件，没有引入新依赖，没有修改 session processor。

留给 v2 的问题：流式渲染、安全沙箱、多 widget 共存、以及永远的难题 — 让模型稳定遵守宿主协议。
