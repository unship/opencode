# 将「Generative UI」接入 OpenCode Web

这次在 `OpenCode Web` 里实现 Generative UI，最初动机非常直接：把大模型生成的 HTML/JS 控件真正接进会话流，让它不只是“展示一个漂亮卡片”，而是能参与下一轮交互。

这篇文章重点梳理三条主线：

1. `read_me`：为什么它是整个系统里最重要的一层，不只是“读文档”，而是模型行为约束。
2. `show_widget`：模型如何把一段流式生成的 `widget_code` 变成会话里真正活着的交互 UI。
3. `prefillPrompt`：交互式 UI 如何把用户在 widget 里的选择反馈回下一步对话，以及这部分为什么到现在还没有完全做完。

本文会把两条实现线并排来看：

- Claude / `pi-generative-ui` 的公开逆向分析
- 我们这次在 `OpenCode` 里的落地、修改和踩坑

参考：

- [Reverse-engineering Claude's generative UI](https://michaellivs.com/blog/reverse-engineering-claude-generative-ui)
- [pi-generative-ui](https://github.com/Michaelliv/pi-generative-ui)

## 为什么从 `read_me` 和 `show_widget` 开始

在 Michael Livshits 的逆向分析里，Claude 的 Generative UI 不是“把 HTML 混进 markdown”，而是一个明确的工具调用协议：

```json
{
  "i_have_seen_read_me": true,
  "title": "snake_case_identifier",
  "loading_messages": ["First loading message", "Second loading message"],
  "widget_code": "...styles...\n...html...\n...script..."
}
```

这个设计有两个很关键的点：

1. UI 是一个工具，不是一段普通文本。
2. 在 `show_widget` 之前，模型必须先调用 `read_me`，显式加载对应模块的规则。

这套设计的厉害之处不是“多了两个工具”，而是它把模型生成 UI 的问题拆成了两个阶段：

- 先加载约束
- 再输出代码

对人类工程师来说，这很像“先读接口文档，再写调用代码”。对模型来说，这其实是把“前端设计规范、交互协议、运行边界”从系统提示词里剥离出来，改成一种按需加载的懒文档系统。

我们这次在 `OpenCode` 里沿用了这个模式，而且很快发现：**`read_me` 其实比 `show_widget` 更重要**。因为真正难的不是“让模型吐出一段 HTML”，而是让它吐出一段**能在宿主环境里可靠运行、并符合交互预期**的 HTML。

## 目标：先跑通，再贴近 Claude

这一轮的目标优先级其实很务实：

1. 尽快跑通：端到端可见“工具调用 -> 会话里长出可交互控件”。
2. 尽量贴近 Claude：`widget_code` 边流边渲染，结构先出现，`script` 最后执行。
3. 不大改现有架构：尽量少和 `opencode` 当前代码冲突。
4. 接受当前阶段的风险：先采用同文档注入和 `morphdom`，暂时不投入 iframe 沙箱和严格 CSP。
5. 结果要持久化：widget 不是一闪而过的 demo，而是会话的一部分。

换句话说，这次不是做一个“新玩具”，而是把 Generative UI 接进现有的会话系统。

## 总体架构：从工具流到会话内联 UI

在 `OpenCode` 里，整体链路大致是：

```text
模型调用 read_me
  ->
模型拿到特定模块的 UI 规则
  ->
模型调用 show_widget，开始流式生成 widget_code
  ->
session processor 增量解析 tool input
  ->
packages/ui/widget-tool 在会话里渐进渲染 widget
  ->
用户在 widget 中完成交互
  ->
widget 将下一步 prompt 反馈回主 composer
```

其中最关键的三个节点分别是：

- `packages/opencode/src/tool/read_me.ts`
- [ ] `packages/opencode/src/tool/show_widget.ts`
- `packages/ui/src/components/widget-tool.tsx`

而“把结果送回下一轮对话”的最后一步，则落在：

- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/widget-prompt.ts`

## `read_me`：从“懒文档”变成“行为协议”

### Claude / `pi-generative-ui` 的做法

在逆向分析和 `pi-generative-ui` 里，`read_me` 的作用是懒加载 UI 设计指南。它的输入很简单：

```json
{
  "modules": ["interactive", "chart"]
}
```

不同模块返回不同规则：

- `interactive`
- `chart`
- `mockup`
- `art`
- `diagram`

模型不会总是背着整套设计系统，而是在需要的时候先取一部分。这一点非常重要，因为它把 token 成本和任务上下文耦合起来了。

### `OpenCode` 里的第一版实现

我们在 `OpenCode` 里一开始也把 `read_me` 做成了一个模块化指南工具。第一版更多是“风格说明”：

- 结构要先出现
- `script` 放最后
- 用原生控件
- 避免太重的视觉效果

这版足够让模型开始生成一个“像样的 widget”，但很快暴露出两个问题：

1. 模型能生成 UI，不等于模型能生成**能工作的 UI**
2. 模型理解“交互完成”这件事，经常和宿主的预期不一致

尤其在“让 widget 的交互结果回到下一轮对话”这个问题上，模型会反复犯错：

- 只更新 widget 本地结果卡片
- 把结果挂到 `window.selectedFruits`
- 生成一个 “Sent!” 按钮，但并没有通知宿主
- 生成一个 “Copy Prompt” 按钮，把文本复制到剪贴板，却不写回聊天输入框

所以后来 `read_me` 的职责变了。它不再只是“风格指南”，而是逐渐演化成了一套**行为协议**。

### 这次真正修改的重点

`read_me` 后面被反复加强，核心思想是：

- 不是“建议”模型怎么做
- 而是“明确告诉模型哪些行为算完成，哪些不算”

围绕 widget -> composer 这一段，我们最后收敛成了非常强的约束：

- `OpenCode` 只认一种把结果写回主输入框的方式：`window.prefillPrompt(text)`
- 如果最终动作没有触发 `window.prefillPrompt(text)`，widget 就不算完成
- 不要把 `Sent / Saved / Done / Generated` 当成成功，除非同一个点击动作也调用了 `window.prefillPrompt(text)`
- 不要只更新局部 UI、全局变量、结果区文本、copy 按钮

后来我们还把提示词进一步改成了“流程 + 正反例 + 自检”的形式，而不是只有规则列表：

- 正确流程：先收集本地状态 -> 等用户确认 -> 组装完整 prompt -> 调用 `window.prefillPrompt(text)`
- 错误流程：只改按钮文案、只显示结果卡片、只复制 prompt、不写回 composer
- 自检问题：最终按钮是否真的绑定到 `window.prefillPrompt(text)`？

这一点很关键。因为实践里发现，模型很多时候不是“不知道 `prefillPrompt`”，而是“知道这个 API 存在，但没把它接到最终按钮的真实点击路径上”。

## `show_widget`：从一个工具参数变成会话里的活 UI

### Claude / `pi-generative-ui` 的模式

在 Claude 的设计里，`show_widget` 是真正生成 UI 的工具。它的输入就是那几个关键字段：

- `i_have_seen_read_me`
- `title`
- `loading_messages`
- `widget_code`

本质上，这是把“UI 生成”显式放进工具系统，而不是让模型随便往文本里塞 HTML。

在 `pi-generative-ui` 里，这个工具的运行结果是打开一个本地原生窗口或 WebView；而在 `OpenCode` 里，我们把它做成了**会话内联 widget**。

### `OpenCode` 的实现方式

在 `OpenCode` 里，`show_widget` 首先是一个工具定义：

- 它把 `title`、`loading_messages`、`widget_code` 持久化到 metadata
- 然后通过会话 part 系统进入消息流

真正的关键不在工具定义本身，而在 `session processor` 对流式 tool input 的处理。

在 `packages/opencode/src/session/processor.ts` 里，我们专门给 `show_widget` 做了增量解析：

- 流式阶段不断从 raw JSON 里抽 `title`
- 抽 `loading_messages`
- 抽 `widget_code`

于是前端不用等整段工具调用结束，工具参数还在生成时就能看到一个逐步成形的 widget。

这部分和逆向分析 Claude 的结论是对应的：**真正的重点不是最后一次性拿到完整 HTML，而是工具参数在 streaming 过程中就开始可用**。

### 前端渲染：为什么最后落成了 `morphdom + Shadow DOM`

`packages/ui/src/components/widget-tool.tsx` 是整个前端渲染链路的核心。

这里最后形成的设计有几层：

1. 先把 `widget_code` 注入到一个临时容器
2. 把 `<script>` 标签收集出来，先不执行
3. 用 `morphdom` 把当前 DOM 和新 DOM 做增量 diff
4. 等工具完成后，再执行脚本

这么做主要是为了解决两个问题：

- **流式渲染闪烁**
  如果每次都 `innerHTML = new_html`，页面会抖得很厉害
- **脚本执行时机**
  如果脚本太早执行，往往会绑定到还没长出来的节点

所以最终策略和 Claude / `pi-generative-ui` 的结论是一致的：

- `style` 短而先到
- 可见结构尽量早出现
- `script` 最后执行

### 为什么后来一定要上 Shadow DOM

一开始我们是把 widget 直接插到宿主文档里，结果很快出现明显副作用：

- widget 里的 `button { ... }` 把宿主页面按钮也改成了奇怪颜色
- 模型生成的样式污染了聊天区

最后 `widget-tool` 切到了 `Shadow DOM`，把 widget 自己的样式和脚本都包进独立根节点里。这样 UI 至少从视觉上不再互相污染。

但 Shadow DOM 也带来了新的兼容问题：

- 模型经常写 `document.querySelector(...)`
- 在 shadow root 里，这些查询默认找不到 widget 自己的节点

于是后来又补了 document proxy、脚本隔离、脚本 root 绑定等兼容层，让“模型以为自己在一个普通文档里”，但实际操作的是当前 widget 的 shadow root。

### `show_widget` 不是最难的，最难的是“让模型写对”

在这轮实现里，一个很有意思的结论是：

- `show_widget` 作为工具和渲染管道，本身并不算太难
- 难的是让不同模型，尤其是非 Claude 的模型，稳定生成符合这个宿主协议的 widget

也正因为如此，`show_widget` 的 description 后面被不断改写：

- 强调不要 inline `onclick`
- 强调最终按钮必须绑定到 `addEventListener("click", ...)`
- 强调不要只在本地显示 `Sent!`
- 强调最终动作必须把结果写回 composer

从这个角度看，`show_widget` 其实是一半“工具定义”，一半“对模型的可执行契约”。

## `prefillPrompt`：让交互式 UI 反馈到下一步对话

### 这是整个体验里最像 Claude 的部分

真正让 Claude 的 Generative UI 看起来“不是一个装饰控件”，而是“对话的一部分”的，是这个动作：

- 用户在 widget 里点选
- 点最终按钮
- 下一轮 prompt 自动出现在聊天输入框里

而且这个 prompt 不是立刻自动发送，而是先写进 composer，让用户还能看、改、再发送。

这就是我们在 `OpenCode` 里实现 `prefillPrompt` 的目标。

### `OpenCode` 里现在的链路

我们最终在 widget host 里注入了 bridge：

- `window.prefillPrompt(text)`
- 兼容保留了 `window.sendPrompt(text)`
- 中间还尝试过结构化 `submitWidget(...)`

底层实现其实就是：

1. widget 调 `window.prefillPrompt(text)`
2. host dispatch 一个 `opencode:widget-prompt` 自定义事件
3. `packages/app/src/pages/session.tsx` 监听这个事件
4. `prompt.set(...)` 把文本写进主 composer
5. `focusWidget(...)` 把焦点移到输入框末尾

从系统设计看，这条链路本身是已经打通的。

### 为什么说“还没完工”

`prefillPrompt` 功能本身可用，但整个“Generative UI 反馈下一步对话”的能力还没有真正做到可靠。难点并不在宿主 API，而在模型行为。

这是本轮里最麻烦、也最有启发的一部分。

### 几次尝试

#### 第一次尝试：直接提供 `sendPrompt(text)`

最早的版本是对齐 Claude 的命名，给 widget 注入一个 `sendPrompt(text)`。

问题很快出现：

- 有些模型会重新声明 `const sendPrompt = ...`
- 多个 script 标签时容易重复定义
- 模型虽然“知道有这个函数”，但经常不调用

后来我们把 bridge 改成全局属性形式，并逐步把外部提示词统一到 `prefillPrompt(text)`。

#### 第二次尝试：让模型自己组装 prompt

我们希望模型在 widget 内部根据选中的水果、餐食类型等状态，自己生成最终 prompt，然后在最终 CTA 里调用 bridge。

理论上没问题，实际落地里模型反复出现这些坏模式：

- 只更新本地结果区
- 把结果存在 `window.selectedFruits`
- 显示 `Sent!`
- 生成 “Copy Prompt” 按钮
- 按钮点击只做 `navigator.clipboard.writeText(...)`

也就是说，模型常常把“用户已经在 widget 内看到结果”错误地理解成“交互完成了”。

#### 第三次尝试：结构化提交

我们一度尝试过提供更结构化的桥，例如：

```js
window.submitWidget({
  action: "generate_meal",
  state: { fruits: ["Apple", "Grape"] },
  template: "My favorite fruits are {fruits}..."
})
```

这样宿主可以负责把状态转成最终 prompt。

从工程角度看，这其实更可靠。但在实际和模型互动中，又带来另一个问题：**协议选项变多了，模型更容易搞混。**

所以后来文档层面又往回收敛，强调：

- 如果目标是写回下一步对话
- 只认 `window.prefillPrompt(text)`

结构化提交更多变成一种中间尝试，而不是最终对外心智模型。

#### 第四次尝试：不断收紧提示词

这一轮里，`read_me` 和 `show_widget` 的文案被反复加强，主要围绕以下几个误区：

- 不要把 `Sent / Saved / Done / Generated` 当作成功
- 最终按钮必须直接调用 `window.prefillPrompt(text)`
- 最终按钮必须是同一次点击动作
- 不要 inline `onclick="generateMealPlan()"`
- 用 `addEventListener("click", ...)` 绑定最终按钮
- 不要生成 “Copy Prompt” 作为最终 CTA

我们甚至把提示词改成带自检问题的形式：

- 最终按钮是否真的绑定到了 `window.prefillPrompt(text)`？
- 如果没有，就不算完成

### 目前最典型的困难

到目前为止，`prefillPrompt` 这部分最大的困难不是代码，而是“模型对宿主预期的理解”：

1. **模型知道要 prefill，但没把它接到最终按钮的真实点击路径上**
2. **模型知道要继续对话，但仍然默认生成“Copy Prompt”或“Sent!”按钮**
3. **模型本地交互做得很好，但把‘本地完成’误当成‘对话完成’**
4. **模型仍然会写不适合当前执行环境的绑定方式**

比如我们真实遇到过这些错误：

- `generateMealPlan is not defined`
- `copyPrompt is not defined`

根因都不是宿主不支持，而是：

- 按钮用了 inline `onclick`
- 函数却定义在局部脚本作用域里
- 结果点击路径根本没走到 `window.prefillPrompt(text)`

### 所以为什么说“还没完工”

这件事之所以还没完工，不是因为 `prefillPrompt` API 没有，而是因为：

- `OpenCode` 这边已经有可用 bridge
- 也能把文本写回 composer
- 但模型稳定遵守这套协议的概率，还没有高到可以说“已经解决”

换句话说，当前的问题已经从“系统有没有能力”变成了“协议如何让模型更可靠地执行”。

这其实比实现一个 API 更难，也更有意思。

## 一些工程上的额外收获

除了主线功能，这轮里还做了几件很实用但不太显眼的事：

- 给 widget 执行增加了调试信息，方便看当前是否 script-ran
- 在 `session/processor` 里给 `show_widget` 增加服务端日志，方便判断模型到底有没有生成 `prefillPrompt(...)`
- 增加 sanitization warning，当模型输出 `javascript:` URL 时直接提示
- 为 Shadow DOM 场景下的脚本执行、文档查询、样式隔离增加兼容层

这些都不是“主角功能”，但它们让 Generative UI 至少从“能演示”走到了“能调试”。

## 结语：真正难的是把 UI 变成对话的一部分

这次在 `OpenCode` 里做 Generative UI，最初看起来像是在做“内联 HTML 渲染”。
但真正走下来，难点根本不在渲染。

真正难的是这三件事：

1. 让模型在生成 UI 前先加载正确的规则
2. 让一段流式增长的 `widget_code` 在会话里稳定长出来
3. 让 widget 的交互结果真正回到下一轮对话，而不是停留在局部 UI 里自嗨

从这个角度看：

- `read_me` 解决的是模型约束加载问题
- `show_widget` 解决的是流式 UI 渲染问题
- `prefillPrompt` 解决的是“Generative UI 如何回到对话”这个最核心的问题

而这第三件事，到现在仍然是最难的一件。

它还没完全完成，但这次实现至少把问题边界看清楚了：

- 宿主桥已经有了
- 渲染链路已经打通了
- 真正剩下的，是如何把模型从“会生成一个看起来像样的 widget”，训练到“会稳定生成一个能正确接入宿主协议的 widget”

这也是我认为这轮实现里最值得写下来的部分。
