# Pi 启动、消息发送与自定义模型改进实施计划

## 目标与现状判断

本次改动覆盖启动生命周期、首条消息投递、凭据入口、自定义模型编辑器和模型级思考能力。当前代码中的关键问题点是：

- `src/shared/default-settings.ts` 默认 `openToHomeOnLaunch: true`；`src/renderer/src/hooks.ts` 在主页模式下直接返回，不调用 `startPi()`。
- `activateWorkspace()` 在 `src/renderer/src/store.ts` 中明确只做导航、不启动 Pi。首次创建工作区或打开主页时，通常没有可供模型选择器查询的运行时。
- `sendPrompt()` 依赖首次发送时懒启动；启动失败时会直接返回。`ChatInput.handleSend()` 又没有等待 `sendPrompt()` 的结果，并会立即清空输入框，因此启动竞态、没有活动工作区、helper 启动失败等情况下会出现“消息像是没有发送”。
- helper 的 `prompt` 是通过 `preflightResult` 先返回相关响应、再异步产生事件的 deferred 流程，需要把接受、拒绝、异常三条路径固定成恰好一次响应并覆盖测试。
- `custom-models-editor.tsx` 目前是密集的内联 provider/model 表单，只暴露 `reasoning` 布尔值；Pi SDK 0.84.4 原生支持模型级 `thinkingLevelMap`。
- 当前桌面协议的思考级别列表漏掉 SDK 已支持的 `max`，但 renderer 的选择器已经显示 `max`，因此选择该级别时会被协议校验拒绝。

## 已锁定的产品决策

- 第 3 项按确认结果执行：移除设置中的整个“提供商凭据”区块及其登录/登出入口和专用 auth IPC 链路。保留 Pi SDK 对现有 `auth.json` 的读取能力；不删除、不迁移已有凭据。
- 第 5 项使用 Pi 原生语义：编辑每个模型的 `thinkingLevelMap`，而不是另造一个桌面专属的“默认思考级别”字段。映射同时表达级别是否支持以及发送给供应商的实际值。
- `openToHomeOnLaunch` 保留为“启动时显示哪个页面”的偏好，不再作为 Pi 是否启动的开关。存在活动工作区时，Pi 在启动流程中自动启动；主页模式下增加可用的模型选择入口。
- 没有活动工作区时不自动伪造一个指向用户主目录的工作区，延续现有避免大范围文件监听的设计。用户选择/打开项目后立即启动该工作区的 Pi，并随后加载模型列表。
- 自定义模型中的 provider `apiKey` 仍作为 `models.json` 的配置字段保留；它不是 SDK 登录区块的一部分。编辑器中改为密码样式并提供显示/隐藏控制，避免明文暴露在页面上。

## 实施阶段

### 1. 统一启动与模型选择流程

1. 在 `src/renderer/src/store.ts` 增加集中式 `ensurePiStarted()` action，返回 `Promise<boolean>`。它负责：检查活动工作区、同步设置 `piStatus: starting`、复用同一个启动中的 Promise、调用现有 `pi.start`、同步运行时状态和会话状态，并在失败时写入可见的 `piError`。
2. 保留 `startPi()` 作为现有生命周期 API，但让它与 `ensurePiStarted()` 共用启动实现。`piStatus === starting` 时所有调用方等待同一启动，不再重复创建 helper；启动失败不得静默吞掉。
3. 修改 `useInitialize()`：加载设置和工作区后，若存在活动工作区就后台调用 `ensurePiStarted()`，不因 `openToHomeOnLaunch` 提前返回。主页仍可尽快渲染，Pi readiness 和历史 hydration 继续异步完成。
4. 修改 `activateWorkspace()`、`openFolderAsWorkspace()`、`ChatProjectPicker`、主页打开项目/新建会话等入口，统一在工作区提交成功后确保活动 Pi 已启动。处理“首次创建工作区后 main 已激活、renderer 因同 ID 直接返回”的路径，不能遗漏启动。
5. 扩展 `ModelSelector` 为可复用的主页/聊天两种布局。主页显示当前模型、provider/model 标识和可搜索列表；没有工作区时显示选择项目的状态，Pi 正在启动时显示加载状态，模型列表为空时显示通过 `models.json` 或环境变量配置模型的提示。选择模型继续复用 `setModel()`，并持久化 `defaultProvider/defaultModel`。
6. 首次启动没有默认模型时只初始化运行时，不自动发送任何消息；用户可以在首条 prompt 前选择模型。默认模型失效时启动不崩溃，模型选择器明确提示重新选择。
7. 重新检查 `sessionLoading`、运行时广播和主页/聊天切换，确保启动中的空会话不会短暂显示错误的“停止”状态，也不会因为后台刷新覆盖用户刚选的模型。

### 2. 修复消息投递和输入框生命周期

1. 将 `AppActions.sendPrompt` 的返回类型改为 `Promise<boolean>`：`true` 表示已通过 Pi 接受，`false` 表示启动或 preflight 失败。保留现有 slash workflow 路由，但也返回明确结果。
2. `sendPrompt()` 在处理普通消息前调用 `ensurePiStarted()`；等待已有启动完成后重新读取最新 store 状态。没有工作区、helper 启动失败、没有可用模型或 provider 凭据错误时，添加一次可读的 system 错误并返回 `false`，不再直接 return。
3. 首条消息在 runtime ready 后再进入本地 bubble/stream 状态；成功提交前先登记 local echo，继续防止 `message_start` 重复渲染。命令调用异常时清理完整的 idle turn state，保留错误信息和可重试的用户消息。
4. 修改 `ChatInput.handleSend()` 为 `await sendPrompt()`：只有返回 `true` 才清空 textarea、附件和自动增长高度；失败时保留草稿与附件。`useChatKeyboard()` 不再在回调外无条件清空输入，按钮发送和 Enter 发送走同一条路径，避免竞态和双重清空。
5. 增加 composer 发送中的轻量互斥/状态保护，防止同一按键事件和按钮点击同时提交首条消息；正在运行时仍保留 steer/follow-up 的既有队列行为。
6. 收紧 `src/main/ipc/pi-handlers.ts` 和 preload 的 prompt options 校验：对图片数组逐项验证 `type/mimeType/data`，`streamingBehavior` 只接受 `steer/followUp`，拒绝 malformed payload，而不是先 cast 后让 helper 静默丢弃。
7. 调整 `src/main/embedded-pi-worker.ts` 的 prompt handler：抽取一次性完成函数，`preflightResult(true)`、`preflightResult(false)` 和异步 throw 各自只发送一个对应 response；接受响应仍在模型完整输出前返回，实际输出继续通过 event 流转发。`PiSdkManager` 在 helper 停止/崩溃/超时时清理该请求，避免 pending promise 永久悬挂。
8. 统一失败文案和恢复动作：启动失败显示重试，缺模型时引导到自定义模型设置，缺凭据时说明可通过 `models.json`/环境变量配置；不因为删除了登录 UI 而把 API 错误变成无上下文的“发送失败”。

### 3. 移除设置中的提供商凭据区块

1. 从 `src/renderer/src/components/settings-panel.tsx` 删除 `ProviderCredentialsSection`、相关状态和“提供商凭据” `SettingsSection`。
2. 删除 `src/renderer/src/components/auth-prompt-modal.tsx` 及 `app.tsx` 中的挂载；从 `store.ts` 删除 `authPrompt/authNotice` 状态和 actions，从 `hooks.ts` 删除 auth event subscriptions。
3. 从 `src/preload/index.ts` 删除 `auth` namespace 及 auth prompt/notify 监听；从 `src/shared/ipc-contracts.ts` 删除 `AUTH_*` channels 和仅被该 UI 使用的 auth result/status 类型。
4. 停止注册 `src/main/ipc/auth-handlers.ts`，删除该模块；从 `src/shared/embedded-agent-protocol.ts` 删除 admin login/logout/prompt message 类型、校验分支和 auth payload（确认没有其他消费者后再删）。
5. 精简 `src/main/embedded-pi-admin.ts` 和 `src/main/embedded-pi-worker.ts` 的 auth 专用依赖、controller、prompt relay 和 admin auth command；保留并回归包安装/删除/更新、npm/git 可用性检查。若包管理器不需要 `ModelRuntime`，一并移除 admin helper 中仅为认证创建的实例。
6. 保留诊断页对 `models.json` provider key 的分类能力、保留 session helper 对 `auth.json` 的正常读取，并确保现有文件不被清空。自定义模型编辑器的 `apiKey` 仍走普通 `models:write`，但不出现在日志、状态或错误详情中。
7. 同步更新 `AGENTS.md`、`README.md`、相关设置文案和 `MEMORY.md`，说明凭据由 Pi 的配置文件/环境提供，桌面端不再提供登录管理入口；不再留下失效的 auth 文档或死代码。

### 4. 自定义模型数据模型和思考级别映射

1. 新增一个共享的模型思考定义（建议 `src/shared/model-thinking.ts`），集中声明 `off/minimal/low/medium/high/xhigh/max`、`ThinkingLevelMap = Partial<Record<level, string | null>>` 以及计算支持级别的纯函数。`embedded-agent-protocol.ts` 重新导出并使用该列表，修复 `max` 的 parent/helper 校验不一致。
2. 在 `src/shared/models-config.ts` 的 `CustomModel` 增加 `thinkingLevelMap` 类型；在 `ModelInfo` 中暴露该字段，同时保留已有 `thinking` 形状作为兼容回退。
3. 扩展 `validateModelsConfig()`：map 必须是普通对象；已知级别的值只能是非空字符串或 `null`；拒绝数组、数字、空自定义值等非法输入，并报告 provider/model/level 的具体位置。未知字段仍按现有策略保留，方便未来 SDK 字段升级。
4. 调整 `mergeModelsConfig()`：编辑器显式提供的 `thinkingLevelMap` 必须覆盖原值；空 map 表示移除该可选字段，而不是因“保留未知字段”又把旧 map 合并回来。继续保留 top-level、provider-level、model-level 未暴露字段。
5. 与 Pi SDK 语义保持一致：
   - `reasoning: false` 时有效级别只有 `off`，但编辑器保留 map 以便重新启用；
   - 标准级别的 map 缺省值使用供应商默认映射；
   - `null` 表示明确不支持；
   - `xhigh/max` 只有配置为字符串时才显示为支持；
   - `off` 可配置供应商关闭思考时使用的实际值。
6. 修改 `ModelSelector`、`ThinkingLevelSelector` 和相关 `ModelInfo` 使用共享支持级别函数，不再对所有模型盲目显示全量级别，也不显示当前模型明确不支持的级别。切换模型后使用 SDK 的 clamp 结果刷新 session state。
7. 修正模型配置保存后的生效策略：正在 working/needs-approval 的 runtime 不重启；空闲 runtime 通过可靠的 model-runtime reload 或保留 sessionPath 的 idle restart 更新模型快照；UI 明确显示当前会话是否需要重启。验证新的 map 最终进入 SDK model 对象，而不是在 renderer 自己拼接请求参数。

### 5. 重做自定义模型编辑器布局

1. 重构 `src/renderer/src/components/custom-models-editor.tsx`，将 provider 编辑器和 model 编辑器拆成可读的局部组件/纯转换 helper。provider 顶部显示名称、API、base URL、模型数量和删除操作；模型列表支持折叠，避免 provider 很多时页面无限展开。
2. 每个模型按信息层次布局：第一行是必填 ID/显示名；第二行是上下文窗口、最大输出、reasoning/vision 能力；第三行是可折叠的“思考级别映射”高级区。桌面使用对齐网格，窄屏自动切换单列，所有输入具有稳定宽度，不因错误文案改变布局。
3. 思考映射区为七个级别提供明确的三态编辑：`默认映射/不支持/自定义值`。自定义值输入供应商实际字符串；对 `xhigh/max` 标注未配置时不会显示；保存前即时显示非法空值和重复 ID。
4. provider `apiKey` 使用 `type=password`，增加仅图标的显示/隐藏按钮和简短的配置说明；不在模型列表、状态栏或错误中回显 key。
5. 保留新增/删除 provider/model、能力勾选、未知字段合并、models.json 损坏时禁用编辑、保存后刷新和重启入口。保存按钮、删除按钮、展开按钮使用现有 lucide 图标和 tooltip，错误/保存中/已保存/需重启状态清晰但不堆叠卡片。
6. 把 `configToRows/rowsToConfig`、map 三态转换、provider/model 校验抽到可单测的 helper；本地展开状态不写入 `models.json`，配置重新加载时按 provider key + model id 稳定恢复或安全重置。

## 测试与验收

### 单元和契约测试

- 扩展 `src/shared/models-config.test.ts`：合法/非法 `thinkingLevelMap`、`null` 与缺省语义、空 map 删除、未知字段保留、provider/model 重命名及重复校验。
- 新增共享思考级别 helper 测试：非 reasoning 模型只有 `off`、标准级别缺省映射、xhigh/max 的显式支持、当前级别 clamp。
- 扩展 `src/shared/embedded-agent-protocol.test.ts`：`max` 的 init/set-thinking round trip、非法级别拒绝、prompt options malformed payload 拒绝。
- 新增/扩展 store prompt 测试：启动中发送会等待而不丢失、并发首条发送只启动一个 Pi、无工作区/启动失败保留草稿、成功发送清空草稿、preflight reject 不留下 stuck streaming、首条消息和 echo 不重复。
- 为 `custom-models-editor` helper 增加转换和三态 map 编辑测试；验证 `reasoning: false` 不破坏已配置 map。
- 为 `PiSdkManager`/worker 的 prompt acceptance 增加 fake helper/session 测试：accept、reject、throw、exit、timeout 均只结束一次 pending request；现有 session/runtime/活动测试继续通过。
- 更新协议/admin 测试，确认 auth message 不再暴露，同时 package admin command 仍可解析和执行；确认 auth secret 不进入日志的既有测试改为验证 `models.json` 写入链路不打印 secret。

### 手工/集成验收场景

1. 已有活动工作区启动应用：主页模式和聊天模式都能看到 Pi 最终变为 running；首条 prompt 前打开模型选择器、搜索并选择 provider/model，消息使用该模型。
2. 全新无工作区启动：应用不伪造 Home 工作区；打开文件夹后自动启动 Pi，模型列表出现，选择模型后首条消息成功发送。
3. 启动尚未完成时立即按 Enter：输入不会消失，Pi ready 后只发送一次；helper 启动失败时输入和附件仍保留，可重试。
4. 无默认模型、模型配置损坏、provider 无可用 key、helper 崩溃和网络失败：页面显示具体可恢复错误，不出现永久 spinner 或无声失败。
5. 正在生成时发送 steer/follow-up、发送图片、输入 slash command：原有队列、附件和命令行为不回归。
6. 设置中不再出现提供商凭据区块或登录弹窗；既有 `auth.json` 不被修改；通过环境变量或 `models.json` 配置的模型仍可被 Pi 使用，包管理页仍可工作。
7. 添加一个自定义 reasoning 模型并配置示例 map（例如 `off: "none"`、`low: "low"`、`high: "high"`、`xhigh: null`），保存后 JSON 结构正确；重启/新建会话后选择器只显示支持级别，SDK 请求使用映射值。
8. 在宽屏、窄窗口和多个 provider/model 下检查编辑器无横向溢出、字段无重叠、删除/折叠/保存反馈稳定，未知 JSON 字段未被覆盖。

### 交付前命令

按项目交付清单执行：

```text
npx tsx --test
npm run typecheck
npm run lint
npm run build
npm run verify:embedded-pi -- --smoke
```

另做一次真实开发/打包应用 smoke：启动、选择工作区、选择模型、发送首条消息、切换思考级别、保存自定义模型并重启。计划阶段未执行上述命令，也未修改工作区文件。
