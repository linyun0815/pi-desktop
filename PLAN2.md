# 首页 Token 统计与自定义模型元数据改进计划

## 摘要

修复首页活动统计只累加 `input/output` 的问题，完整记录并展示 `input`、`output`、`cacheRead`、`cacheWrite` 以及实际费用；同时完善 `models.json` 自定义模型编辑器，使模型价格和基础元数据可以手动维护，也可以参考 `pi-web` 通过 `models.dev` 自动补全，并支持从 Provider 的 `/models` 接口发现模型。

本计划沿用当前 Electron 架构：公共目录请求由主进程执行，Provider 发现由现有 utility-process admin helper 执行；API Key 只用于临时配置解析，不进入发现结果、日志或新的持久化配置。

## 已确定的产品口径

- Token 总数定义为 `input + output + cacheRead + cacheWrite`。`cacheWrite1h` 是 `cacheWrite` 的子集，不单独相加；reasoning token 已包含在 output 中，也不重复计算。
- 首页保留输入、输出、缓存读取、缓存写入四个独立指标，并增加总费用；模型明细同样显示四类 token、总数和费用。
- 历史费用以会话 assistant message 中已记录的 `usage.cost.total` 为准，不按当前 models.json 价格回算旧消息，避免修改价格后历史统计漂移。新填写的价格从后续请求开始影响 Pi 的 usage cost。
- 自动补全来源为 `models.dev` 加 Provider API 发现。
- 自动补全只填充当前仍为空的字段；显式的 `false`、`0`、空数组以外的已有值和用户自定义字段都不覆盖。操作只修改编辑器草稿，必须点击现有保存按钮才写入 models.json。
- Provider 发现使用当前编辑器草稿生成一次性临时 models.json；临时文件在请求结束后清理，API Key 不通过 helper 协议传递，也不出现在响应或日志中。
- models.dev 或 Provider 网络失败时保留手动编辑能力，不阻塞打开和保存编辑器。

## 1. 扩展共享数据模型与兼容策略

修改 `src/shared/ipc-contracts.ts`、`src/shared/models-config.ts`：

- 增加完整的活动统计字段。保留现有 `ActivityStatsDay.tokens`、`tokensByModel`、`ActivityRangeStats.totalTokens` 名称以减少 renderer 破坏性变更，但将它们的注释和计算口径改为四类 token 总和；新增 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`cost/totalCost`。
- 扩展 `ActivityModelUsage`：增加稳定的 `modelKey`、`provider`、`cacheRead`、`cacheWrite`、`total` 和 `cost`，`model` 继续保存原始模型 ID，`name` 继续保存显示名称。
- `modelKey` 使用 provider 与 model ID 的组合，并通过共享 helper 生成，避免同一个模型 ID 在不同 Provider 下互相合并；旧记录缺少 provider 时使用兼容的无 provider key。
- 将自定义模型成本类型拆成可复用的 rate/tier 结构：四个基础费率均表示美元/百万 token，并支持 SDK 的 `tiers` 字段。编辑器本轮直接编辑四个基础费率，已有 tiers 原样保留。
- 增加支持的模型 API 类型常量和类型（OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI），供 preload、主进程和 helper 共用；未知 API 仍可被原样保存，但不能执行自动发现。
- 增加模型元数据建议、目录匹配结果、Provider 发现请求/结果的共享类型。发现结果只包含模型 ID 和可选显示名称，不包含 key、headers、原始 HTTP body 或认证状态。
- 扩展 `validateModelsConfig()`：成本对象必须是对象；存在的费率必须是有限且非负数字；tiers 必须是数组，每项的四个费率和 `inputTokensAbove` 必须合法。编辑器保存时把只填写部分基础费率的成本补齐为四个字段，空成本对象表示移除成本字段。
- 扩展 `mergeModelsConfig()` 的 editor-owned 规则：未提供 `cost` 表示保留原值；提供非空 cost 表示替换并规范化；提供空 cost 对象表示删除原 cost。继续保留未知顶层、Provider、模型字段和 cost 内未暴露字段。

## 2. 修复活动统计的解析、持久化和聚合

修改 `src/main/activity-stats.ts` 与 `src/main/activity-stats.test.ts`：

- 将内部 `DayBucket.models` 改为保存四类 token 和费用，并读取 assistant message 的 `provider`、`model`、`usage.input/output/cacheRead/cacheWrite` 和 `usage.cost`。
- 总 token 始终由四类原始字段相加；费用优先使用有限的 `usage.cost.total`，只有 total 缺失时才使用费用分项之和，不读取当前模型配置来估算历史费用。
- 每日、范围和模型聚合都同时累加四类 token；模型按 `total` 降序排序，费用单独累加。
- 模型名称映射由仅按 model ID 改为优先按 `provider/model` key 查找，同时保留旧的 ID 映射作为 v1 数据和缺少 provider 的回退。
- 将统计存储版本升为 2，并在 `ensureLoaded()` 中兼容 v1：旧模型聚合自动补零缓存和费用字段；仍存在的 session 文件标记为需要重新解析，从 JSONL 恢复真实缓存字段；已删除且只剩旧聚合的数据不丢失，只显示可恢复的零值字段。
- 对损坏或非有限 token/费用值做零值处理，防止单条历史记录使首页出现 `NaN`；重解析仍替换整个 session 聚合，避免重复累计。
- 保持现有增量 mtime 扫描、删除前捕获、退出时同步 flush、保留窗口和多 session root 行为。

## 3. 更新首页和会话状态的展示

修改 `src/renderer/src/components/stats-panel.tsx`，并同步调整 `src/renderer/src/components/status-popover.tsx`：

- 概览指标增加总费用、缓存读取、缓存写入，并保留输入/输出；四类 token 和费用采用响应式网格，在窄窗口下换行而不是压缩溢出。
- 模型页每行显示 Provider、模型名称/ID、输入、输出、缓存读取、缓存写入、总 token、费用；同名模型通过 Provider 区分。
- token 柱状图继续以四类之和作为柱高和 Y 轴口径，tooltip 增加四类分项和费用；模型颜色仍按模型排序一致映射。
- 使用统一的费用格式化 helper：小额显示足够精度，较大金额显示两位小数；零价格模型可显示 `$0.00`，不把零误报成网络错误。
- 状态弹窗的会话 Token 数改用 SDK 已提供的 `sessionStats.tokens.total`，并显示四类分项；现有状态栏费用保持与 SDK session cost 一致。
- 抽取必要的格式化/聚合展示 helper 并单测，确保旧统计响应缺少新增字段时 renderer 以零值兼容渲染。

## 4. 实现 models.dev 目录匹配

新增 `src/main/model-catalog.ts`，必要的纯类型/解析 helper 放入 `src/shared/model-catalog.ts`：

- 从固定的 `https://models.dev/api.json` 获取全量目录，在主进程内解析，不把用户模型 ID或凭据作为查询参数发送；缓存成功结果一小时，并共享并发请求。
- 将目录字段映射为 Pi 原生模型字段：`cost.input/output/cache_read/cache_write` 映射为四个费率，`modalities` 映射为 input，`limit.context/output` 映射为上下文窗口和最大输出，保留 name/reasoning。
- 匹配顺序与 pi-web 一致：优先 provider + model ID 精确匹配，其次按 Provider Base URL 主机匹配，最后按模型 ID 做有支持度门槛的 consensus。元数据和价格分别记录来源与可靠性。
- 只有存在有效 input/output 价格且达到可靠性门槛时才返回价格建议；缺少价格或来源冲突时仍可返回可靠的名称/能力/窗口建议，但不注入不可靠价格。
- 对目录结构、数字、字符串长度和数组大小做边界校验；网络超时、HTTP 错误、JSON 损坏统一返回可展示的结构化失败，不记录响应正文。
- 通过 `force`/重试清除失效缓存；不将目录快照写入用户配置文件。

## 5. 实现 Provider API 模型发现

新增 `src/shared/model-discovery.ts`，扩展 `src/shared/embedded-agent-protocol.ts`、`src/main/embedded-pi-admin.ts`、`src/main/embedded-pi-worker.ts`：

- 增加 `adminDiscoverModels` helper 消息，携带临时 models.json 路径和 Provider ID，不携带 API Key；更新协议校验和协议版本，拒绝缺少路径/Provider 的 malformed 消息。
- `EmbeddedPiAdminManager.discoverModels()` 使用现有 admin helper 请求相关命令并设置约 30 秒超时；helper 崩溃、超时和退出都可靠拒绝 pending 请求。
- worker 在临时配置上创建 `ModelRuntime`，复用 Pi 的 auth.json、环境变量、models.json value resolution 和 compatibility headers；不触发登录 UI，也不返回解析后的凭据。
- 按 API 类型构造模型列表 endpoint：规范化 trailing slash，必要时补 `/v1` 或 `/v1beta`，再补 `/models`；Anthropic/Google 的分页参数使用 SDK/Provider 常见字段。仅允许 http/https、限制响应体和模型数量，限制重定向次数并避免向跨 origin 重定向发送原认证头。
- 解析数组以及常见的 `data/models/results/items` 响应；支持字符串模型项和 `id/model/name/display_name` 对象，去除 `models/` 前缀、去重、排序并截断结果。HTTP body 不进入错误文案或日志。
- 主进程在 `models-config-handlers.ts` 中接收发现请求，校验 Provider ID、Base URL、API 和临时 key 字段；把当前已保存 Provider 的 headers 等未暴露字段与编辑器草稿的 key/baseUrl/api 合并，写入 GUI-owned 临时目录，调用 helper 后在 `finally` 清理。现有 quit cleanup 继续作为异常退出兜底。

## 6. 扩展 IPC 和保存边界

修改 `src/shared/ipc-contracts.ts`、`src/preload/index.ts`、`src/main/ipc/models-config-handlers.ts`：

- 增加 `MODELS_CATALOG_LOOKUP` 和 `MODELS_DISCOVER` 两个 IPC channel，以及对应的 preload bridge 方法。
- catalog lookup 接收 model ID、可选 Provider ID 和 Base URL；discover 接收 Provider ID、Base URL、API 和仅短暂使用的草稿 API Key/null。两者的响应均为结构化、大小受限的结果。
- 在主进程 models write handler 重新执行共享 config 深度校验，并拒绝非法成本值；错误只返回字段定位信息，不回显 apiKey 或原始 JSON 片段。
- 保留现有保存后的 idle runtime reload、busy runtime 延迟生效和 `customModels` 刷新行为，使新价格进入后续 SDK session usage。

## 7. 完善自定义模型编辑器

修改 `src/renderer/src/components/custom-models-editor-helpers.ts`、其测试和 `custom-models-editor.tsx`：

- `configToRows()` 对 null/非对象 Provider 和异常模型数组安全降级，保留有效模型的 cost、tiers、thinking map 及未知字段，不因手工损坏的 Provider 条目让整个编辑器崩溃。
- 增加纯函数 `normalizeCostDraft()`、`fillBlankModelMetadata()` 等 helper。填充规则逐字段判断当前值：空 name、缺失 reasoning/input/contextWindow/maxTokens 和缺失的四个费率才接受建议；显式 `reasoning: false`、`cost` 中的 `0` 和用户已有值全部保留。
- 每个模型增加四个价格输入，标签明确为美元/百万 token；空值表示未配置，零是合法免费价格。保存时对部分填写的成本补齐缺失费率为零；清空全部价格可移除 cost。
- 每个有模型 ID 的行增加图标化“自动填充”操作，显示加载、成功、未匹配、价格不可靠和错误状态；结果只写入当前草稿，不自动保存。请求返回后重新读取当前行再逐字段填充，避免覆盖用户在请求期间的编辑。
- 每个 Provider 增加图标化“发现模型”操作和可搜索的选择列表。用户选择后只添加当前不存在的模型 ID，API 返回的 name 只作为空 name 的建议；新行随后使用缓存的 models.dev 结果批量补全，采用有界并发，目录无匹配时保留空字段。
- 保持已有 provider/model 新增删除、折叠、API Key 密码显示、thinkingLevelMap 三态编辑、未知字段合并、损坏配置禁写和保存后应用提示。发现列表、请求状态和展开状态均为本地 UI 状态，不写入 models.json。
- 对 Provider/model 使用稳定的本地 UI key，避免发现结果插入或删除时错误复用展开状态；窄屏下价格输入和状态提示换行，不产生横向溢出。

## 8. 测试覆盖

- 扩展 `src/main/activity-stats.test.ts`：验证四类 token、总数、每日/范围/模型聚合、费用、同 model ID 不同 Provider、`cacheWrite1h` 不重复、缺失/非法 usage，以及 v1 存储迁移和删除后保留。
- 扩展 `src/shared/models-config.test.ts`：验证四费率和 tiers 的合法/非法值、非负校验、部分 cost 规范化、空 cost 删除和未知字段保留。
- 扩展 `src/renderer/src/components/custom-models-editor-helpers.test.ts`：验证 cost 行转换、空字段填充、显式 false/0 不覆盖、元数据建议和损坏 Provider 的安全降级。
- 新增 model catalog 纯 helper 测试：models.dev 字段解析、snake_case 价格映射、精确/provider/base-url/consensus 匹配、价格冲突、无效数据、缓存和并发复用。所有网络测试注入 fake fetch，不访问真实服务。
- 新增 model discovery helper 测试：四类 API 的 endpoint 构造、响应形状解析、前缀去除、去重、限制和非法响应；验证跨 origin 重定向不会复用认证头。
- 扩展 `src/shared/embedded-agent-protocol.test.ts`：新增 admin discover 双向解析、版本不匹配和 malformed payload 拒绝；确认发现响应类型没有凭据字段。
- 为 admin manager/worker 请求增加 fake helper 测试：成功、超时、退出和异常均只完成一次，临时配置在成功和失败路径都清理。
- 更新必要的 renderer 契约/状态测试，确认 status popover 和 stats panel 使用四类 token；不改动与本需求无关的 subagent 进度 token 口径。

## 9. 验收场景与交付检查

1. 含有 `input=100`、`output=50`、`cacheRead=1000`、`cacheWrite=20` 的 assistant 记录在首页显示总数 `1170`，四个分项和对应 `usage.cost.total`，模型图表/范围切换结果一致。
2. 同一 model ID 通过两个 Provider 使用时，首页分别列出两行，名称和费用不串行；旧 v1 统计文件和已删除 session 不丢失。
3. 新增自定义模型后手填任意一个价格，自动填充只补其余空字段；已有 name、`reasoning:false`、价格 `0` 和自定义窗口不被覆盖。
4. 对公开目录可匹配的模型，自动填充可补全 name、reasoning、input、上下文、最大输出和四费率；无网络或价格冲突时仍可手动保存并明确提示。
5. Provider 草稿使用临时 API Key 调用 `/models`，发现结果只返回 ID/name；models.json、app log、IPC 响应和错误文案均不包含 key，成功/失败后临时文件均删除。
6. 保存后空闲 Pi runtime 应用新 cost，后续 assistant usage 产生正确费用；忙碌 runtime 不被中断，按现有提示在下次启动生效。
7. 宽屏、窄窗口、多 Provider、多模型和长模型 ID 下编辑器无重叠/溢出；损坏的 models.json 仍进入只读禁写状态。

实现完成后按项目清单运行：

```text
npx tsx --test
npm run typecheck
npm run lint
npm run build
npm run verify:embedded-pi -- --smoke
```

另做一次真实应用 smoke：打开自定义模型编辑器，发现并添加一个 Provider 模型，自动补全并保存价格，发送一轮产生缓存的会话，确认首页四类 token/费用和状态弹窗一致。更新 `AGENTS.md`/`MEMORY.md` 记录新的统计口径、models.dev 依赖、临时凭据处理和历史费用不回算规则；保留现有未跟踪的 `PLAN.md`，不改动无关工作区文件。
