# Pi Desktop

一个为 [Pi 编程智能体](https://pi.dev)打造的桌面 GUI 应用。在一个窗口里聊天、管理项目、浏览文件、运行命令、安装软件包。

![Status](https://img.shields.io/badge/status-alpha-orange) ![License](https://img.shields.io/badge/license-Apache--2.0-blue) ![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-lightgrey)

![Pi Desktop — 主页启动器界面](docs/screenshots/Screenshot_20260824_181929.png)

项目仍处于 Alpha 阶段,难免有粗糙之处。

## 目录

- [功能总览](#功能总览)
- [审查栏](#审查栏)
- [内嵌 Pi 运行时](#内嵌-pi-运行时)
- [权限](#权限)
- [自定义主题](#自定义主题)
- [多代理委员会规划](#多代理委员会规划)
- [快速开始](#快速开始)
- [键盘快捷键](#键盘快捷键)
- [从源码构建](#从源码构建)
- [许可证](#许可证)
- [相关链接](#相关链接)

## 功能总览

### 聊天与渲染

- 流式聊天,支持思考块、工具调用和富文本渲染:内置字体与彩色 emoji、内联 SVG 预览,聊天中提到的文件名可点击并打开预览面板。连续的工具调用会折叠为可展开的分组;文件读取显示为带行号的语法高亮代码,文件编辑显示为 diff
- 会话内查找(`Ctrl/Cmd+F`);只有当你停留在底部时,流式输出才会自动跟随新内容,并提供"跳到最新"按钮
- 输入框支持文件提及(输入 `@` 插入路径引用,供 Pi 读取),`Up`/`Down` 方向键可回溯本会话中已发送的提示词
- 模型切换(`Ctrl+P`)支持分词搜索、思考级别控制和实时 token/费用统计;选择器只列出所选模型真正支持的级别,自定义模型还可以在 **设置 → 自定义模型** 中把每个思考级别映射为供应商特定取值(或标记为不支持)

### 项目与会话

- 多工作区,每个活跃会话拥有独立的代理进程,切走之后任务仍在后台继续;任务控制台和侧边栏活动指示点会展示跨项目的后台工作,并可在会话完成、失败或等待审批时发送桌面通知(可选)
- 只要存在活动工作区,Pi 就会在后台自动启动(应用启动时、打开项目时、切换工作区时)——第一条消息永远不会等冷启动;启动尚未完成时发送的消息会在运行就绪后恰好投递一次。启动失败会保留输入框草稿并提供重试
- 主页仪表盘提供用量统计:消息数、token 数、连续活跃天数、高峰时段,以及按模型细分的用量;主页上的模型选择器可以在会话开始之前就选择(或预选)模型
- 新建任务启动器会在所选项目中开启一个全新的 Pi 会话(可选隔离的 Git worktree),立即发送任务并在后台继续工作;匹配的任务元数据、显式分支和 GitHub PR 链接会复用已存在的本地 worktree
- 会话命名(从 Pi 读取)支持内联重命名、会话标签(在聊天中输入 `#tag-name`)、应用内主题化的删除确认,以及会话分叉/分支树和一键上下文压缩
- 快速切换器(`Ctrl/Cmd+K`)可检索技能、提示模板、内置命令、工作区、会话和文件;在输入框开头输入 `/` 可打开命令面板

### 规划、审查与安全

- [多代理委员会规划](#多代理委员会规划):由 Pi、Claude 和 Codex 共同制定计划并达成共识,Pi 在动手构建之前先呈现协商一致的方案(可选开启)
- 自定义权限规则:按 Pi 工具配置允许/拒绝 glob 规则,在权限模式之上进一步细化;支持按工作区维护规则文件、导入/导出,规则修改即时生效,无需重启 Pi
- 审查栏(可开关)集中展示权限、待审批项、变更文件和会话状态
- 差异审查流水线提供明确的 提交 → 推送 → PR 操作,支持感知上游的 GitHub CLI 创建 PR,以及点击通知精确跳回已完成的会话

### 内置工具

- 文件树(带 git 状态徽章)、代码/图片/PDF/HTML 预览面板、代码编辑器(CodeMirror 6,语法高亮)、diff 查看器和文件搜索
- 终端支持 ANSI 颜色,直接运行你的真实 shell
- 包浏览器连接 pi.dev/packages,本地即时搜索;无需离开应用即可安装和移除包
- 技能浏览器,以及设置中的自定义模型与供应商编辑器(编辑 `~/.pi/agent/models.json`)
- 诊断视图:内嵌 Pi SDK 版本与辅助进程状态、供应商配置、权限,以及近期错误
- 实时预览的设置与主题:7 套内置主题外加跟随系统,还可在应用内创建自定义主题,支持导入、导出或从 URL 安装

## 审查栏

右侧的审查栏让你在与 Pi 聊天时随时看到安全状态与工作区文件状态。通过聊天工具栏开关(默认隐藏,避免与文件/图片预览争抢空间)。

变更文件使用易读的状态徽章:

| 徽章 | 含义 |
| ------- | --------- |
| `NEW` | 未跟踪的新文件 |
| `MOD` | 已跟踪文件被修改 |
| `DEL` | 已跟踪文件被删除 |
| `ADD` | 新文件已暂存到 git |
| `STG` | 已修改文件已暂存 |
| `REN` | 文件被重命名 |

## 内嵌 Pi 运行时

Pi Desktop 以**内嵌 SDK** 的形式携带 Pi 编程智能体(`@earendil-works/pi-coding-agent`,随版本精确锁定)。无需安装 Pi CLI,也不依赖系统 Node:每个活跃会话都运行在独立的 Electron utility 进程上,使用 Electron 自带的 Node 运行时执行 SDK。运行时直接复用 Pi 自己的数据——`auth.json`、`models.json`、`settings.json` 以及 `~/.pi/agent/sessions` 下的会话(可用 `PI_CODING_AGENT_DIR` 覆盖)。

设置中会显示内嵌 SDK 版本。供应商凭据完全由 Pi 自己管理——通过 `models.json`(`apiKey` 字段)、Pi 的 `auth.json` 或环境变量配置即可;桌面端不提供任何登录界面,也绝不会改动已有凭据。可选的 Pi 包安装/更新需要 PATH 中有 `npm`(git 来源还需要 `git`);缺少它们时,基础聊天和已安装的包照常可用,缺失的包会被明确报告而不是自动安装。

旧的 `~/.omp` 数据保留在磁盘上不做改动,但不再列出、恢复或迁移。

## 权限

四种基础模式控制 Pi 可以做什么,可在审查栏或 **设置 → 行为** 中选择:

| 模式 | 行为 |
| ------ | ---------- |
| 规划 / 只读 | 仅启用读取/搜索/列表类工具;文件编辑和 shell 命令被阻止 |
| 编辑前询问 | Pi 在编辑文件和执行 shell 命令前会先询问 |
| 命令前询问 | Pi 在执行 shell 命令前会先询问 |
| 信任模式 | 启用所有工具 |

自定义权限规则按 Pi 工具细化上述模式,在 **设置 → 行为 → 权限规则** 中编辑:

- 一条规则由动作(`allow`/`deny`)、工具名(`bash`、`edit`、`write`、`read`……或 `*` 表示任意)和可选的 glob 模式组成,模式与工具的输入进行匹配:`bash` 匹配 shell 命令,文件工具匹配文件路径。`*` 是唯一的通配符。
- 优先级:deny 优先于 allow,allow 优先于模式默认值。deny 规则在所有模式下都会强制执行;即使处于信任模式,`deny * *.env*` 依然生效。allow 规则会在询问模式下跳过确认提示。
- 规则修改即时生效,作用于下一次工具调用,无需重启 Pi。
- 规则分为两个作用域。**全局 | 此工作区** 标签页分别编辑你的全局规则或活动工作区的 `.pi-desktop/permission-rules.json`。工作区规则文件受工作区信任机制约束:一旦你信任该工作区,它在此工作区内会完全取代全局规则。在此之前(刚打开一个仓库时的默认状态)只有它的*拒绝*规则生效,并叠加在你的全局规则之上;它的*允许*规则会被忽略——因此克隆来的仓库只能收紧你的权限,永远不能放宽。打开包含允许规则的工作区时会提示你信任;也可以在 **此工作区** 标签页中信任/撤销信任。导入/导出以 JSON 文件的形式移动规则列表,工作区文件支持手工编辑或随仓库提交,应用会实时感知变更。
- 一点诚实的说明:规则匹配的是原始字符串,没有路径规范化或命令解析。请把它们视为防误操作的护栏,而不是安全沙箱;即使是已信任的工作区,也请保持允许规则尽可能收窄。

规则示例:

```json
{ "action": "allow", "tool": "bash", "match": "npm test*" }
{ "action": "deny",  "tool": "bash", "match": "rm -rf *" }
{ "action": "deny",  "tool": "*",    "match": "*.env*" }
```

## 自定义主题

Pi Desktop 内置 7 套主题(Dark、Light、Nord、Gruvbox、Breeze Dark、Breeze Light、Breeze Claudius)外加跟随系统,你还可以在 **设置 → 外观** 中创建自己的主题。

在应用中制作主题:点击 **创建主题** 会从当前激活的主题派生一份副本,或点击 **编辑主题** 继续编辑你已创建的主题。选择 7 个种子色(应用背景、表面、文本、强调色、成功、警告、错误)以及深色或浅色类型;应用中的其他颜色都由这些种子派生。编辑时所有改动会在整个窗口实时预览。两个折叠区提供更精细的控制:

- **高级** 允许你逐项覆盖约 30 个派生 token(边框、悬停、滚动条等),而不接受自动派生。
- **语法颜色** 覆盖代码高亮颜色(关键字、字符串、注释等),代码编辑器和 diff 查看器共用。

你创建的主题会与内置主题一起出现在 **主题** 下拉列表中。在编辑器中修改名称即可重命名;选中某个主题后点击 **创建主题**(派生当前激活的主题)即可复制一份;选中自定义主题时,下拉框旁会出现 **删除** 按钮。

分享主题可以使用 **导入** 和 **导出** 以 `.json` 文件形式传递,或在 **从 URL 安装** 中粘贴 `https://` 链接直接安装(拒绝 HTTP,下载有大小上限)。

主题文件采用 `pi-theme/v1` 格式:包含 `$schema`、`name`、`kind`(`"dark"` 或 `"light"`)和 7 个 `seeds` 的 JSON。仅凭这些就足以构成一个完整有效的主题;其余颜色全部通过 CSS `color-mix()` 自动派生:

```json
{
  "$schema": "pi-theme/v1",
  "name": "My Theme",
  "kind": "dark",
  "seeds": {
    "app": "#0a0a0a",
    "surface": "#171717",
    "text": "#f5f5f5",
    "accent": "#2563eb",
    "success": "#34d399",
    "warning": "#facc15",
    "error": "#f87171"
  }
}
```

两个可选的顶层对象允许你固定精确取值而不依赖自动派生:`overrides`(任意派生 token,如 `border`、`scrollbar`、`accent-hover`)和 `syntax`(代码高亮颜色,如 `keyword`、`string`、`comment`)。两者都省略时,主题仅凭 7 个种子色也能正确渲染。

用户主题文件保存在应用用户数据目录的 `themes/` 下(Linux 上为 `~/.config/pi-desktop/themes/`)。

此外还有一个社区主题库 [pi-desktop-themes](https://github.com/FaqFirebase/pi-desktop-themes):把任意主题的 raw 链接粘贴到 **从 URL 安装** 即可安装,也欢迎用 PR 提交你自己的主题。

## 多代理委员会规划

Pi、Claude 和 Codex 各自产出初始计划,互相分享并收敛,由 Pi 在*任何东西被构建之前*呈现协商一致的方案。所有成员只读规划;只有 Pi 会编辑文件。

该功能默认关闭。在 **设置 → "多代理委员会规划"** 中启用;确认对话框会提示这会增加 token 和额度消耗,因为每次请求会运行多个代理。

应用会跨平台自动检测各成员的 CLI,只有检测到的代理才能启用(逐个代理的复选框)。至少要有两个成员可用,否则拒绝运行。即使 Pi 未被勾选为规划者,它也始终负责把各计划合并为最终共识。

每个成员都只读规划:Claude 以 `--permission-mode plan` 运行,Codex 以 `--sandbox read-only` 运行,Pi 则排除写工具。它们只产出计划,从不修改文件。只有 Pi 会实现已批准的结果。

咨询阶段,每个成员在各自的卡片中实时流式输出计划,并附带计时器。

有两种共识模式:

- **一轮辩论**(默认):每个成员看到其他成员的计划并修订一次,然后由 Pi 合并。你可以看着它们收敛。
- **仲裁合并**:更快、更省。Pi 直接综合初始计划,不进行辩论轮。

每个成员都有超时限制(10–600 秒,默认 240)。超时或出错的成员会被剔除,只要产出了至少一份计划,运行就会继续。

使用方法:开启该功能后输入你的请求,并点击输入框中的 **使用委员会规划**。查看每个成员的计划和 Pi 合并后的共识方案。如需修改,在 **请求修改方案…** 中输入反馈,Pi 会修订共识;可反复进行。满意后点击 **执行此方案**,Pi 开始构建。方案就绪后面板会折叠,保持输出可读。

## 快速开始

### 系统要求

- Pi 本体无需安装任何东西:Pi 编程智能体 SDK 已**内嵌**在发行版中,运行在 Electron 自带的 Node 运行时上——见[内嵌 Pi 运行时](#内嵌-pi-运行时)。
- 从源码构建需要 **Node >= 22.19.0**(构建会校验这一点,不满足则直接失败)。

### Linux

从 [Releases](https://github.com/FaqFirebase/pi-desktop/releases) 下载 AppImage:

```bash
chmod +x Pi-Desktop-linux-x64.AppImage
./Pi-Desktop-linux-x64.AppImage
```

### macOS

从 [Releases](https://github.com/FaqFirebase/pi-desktop/releases) 下载 `.dmg`(Apple Silicon / arm64),打开后把 **Pi Desktop** 拖入「应用程序」。

构建**尚未签名,也未公证**。由于下载未经签名,macOS 会将其隔离,首次启动时 Gatekeeper 会显示如下对话框(这是 macOS 的提示,不是我们的建议):

> Pi Desktop is damaged and can't be opened. You should move it to the Trash.

**不要把它移到废纸篓。** 应用并没有损坏;这只是 Gatekeeper 对任何未签名应用的固定说法。macOS 对这种对话框没有提供"仍要打开"按钮,所以请改在终端中清除隔离标记:

```bash
xattr -dr com.apple.quarantine "/Applications/Pi Desktop.app"
```

然后正常打开应用。只需操作一次。

> 如果 macOS 提示应用**"无法打开,因为 Apple 无法检查其是否包含恶意软件"**,你可以不用终端就放行:打开 **系统设置 → 隐私与安全性**,滚动到 **安全性** 部分,点击 Pi Desktop 提示旁边的 **仍要打开**,然后用触控 ID / 密码确认。

> 如果你不想折腾未签名应用的警告,可以从源码构建。自己编译的应用在本地运行不会被 Gatekeeper 拦截,没有签名提示,也无需清除隔离标记。参见下文[从源码构建 → Linux / macOS](#linux--macos)。

### Windows

从 [Releases](https://github.com/FaqFirebase/pi-desktop/releases) 下载:**安装版**(`…-win-x64-setup.exe`,推荐)或**便携版** `…-win-x64.exe`。构建未签名,SmartScreen 可能会警告;选择 **更多信息 → 仍要运行**。如果文件编辑或保存失败,请参见下文[受控文件夹访问](#受控文件夹访问勒索软件防护)的说明。Windows 为社区测试;如遇问题请[提交 bug 报告](https://github.com/FaqFirebase/pi-desktop/issues)。

## 键盘快捷键

| 快捷键 | 功能 |
| ---------- | ------------- |
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `Up/Down` | 回溯历史提示词 |
| `@` | 提及工作区文件 |
| `Escape` | 停止流式输出 |
| `Ctrl/Cmd+K` | 打开命令面板 |
| `/`(消息开头) | 打开命令面板 |
| `Ctrl+P` | 切换模型 |
| `Ctrl/Cmd+F` | 会话内查找 |
| `Ctrl+Shift+F` | 文件搜索 |
| `Ctrl+Shift+P` | 插入已保存的笔记 |
| `Ctrl+N` | 新建会话 |
| `Ctrl+Shift+N` | 新建工作区 |
| `Ctrl+O` | 打开项目 |

## 从源码构建

### Linux / macOS

```bash
git clone https://github.com/FaqFirebase/pi-desktop.git
cd pi-desktop
npm install
npm run dev
```

### Windows

Pi Desktop 使用 `node-pty` 随包发布的 Node-API 二进制,因此在 Windows 上正常检出安装无需 Visual Studio 或 C++ 工具链。

#### 1. 安装前提

请在克隆**之前**安装以下全部内容:

- [Git for Windows](https://git-scm.com/download/win)
- [Node.js LTS](https://nodejs.org),使用官方 Windows 安装器(会将 `node` 和 `npm` 加入 PATH)

只有当 `node-pty` 未为你的平台/架构发布预构建二进制时才需要原生编译器。那种情况下请参照 [`node-pty` 构建前提](https://github.com/microsoft/node-pty#building)。

#### 2. 添加 Windows Defender 排除项(推荐)

Defender 可能会阻止或拖慢包含大量小文件的项目上的 `npm install`。克隆前先添加排除项:

设置 → 隐私和安全性 → Windows 安全中心 → 病毒和威胁防护 → 管理设置 → 排除项 → 添加文件夹 →(选择你将要克隆仓库的位置)

#### 3. 克隆并安装

```powershell
git clone https://github.com/FaqFirebase/pi-desktop.git
cd pi-desktop
npm install
```

postinstall 脚本会校验 `node-pty` 的原生文件和 Electron 二进制。首次安装可能需要几分钟(Electron 下载)。

如果安装后 Electron 二进制缺失,请按[手动下载 Electron 二进制](#手动下载-electron-二进制)的步骤操作。这是 Windows 上 Electron 的 postinstall 解压只留下残缺 `dist` 目录时的已验证回退方案。

#### 4. 运行

```powershell
npm run dev
```

#### Windows 常见错误

| 错误 | 原因 | 解决方法 |
| ------- | ------- | ----- |
| `MSB8040`:缺少 Spectre 库 | 某个配置强制 `node-pty` 从源码重编译 | 移除 npm 配置中的 `build-from-source` 后重新运行 `npm install`;Pi Desktop 的正常安装使用自带的 Node-API 二进制 |
| `electron-vite is not recognized` | `npm install` 未完成 | 重新运行 `npm install` |
| 安装后 Electron 二进制缺失 | Electron 的 postinstall 解压留下残缺或空的 `dist` 目录 | 将仓库目录加入 Defender 排除项后重新 `npm install`;若仍然失败,使用下文的手动下载步骤 |
| 写项目文件时报 `EPERM` / `EACCES` | 受控文件夹访问(勒索软件防护)拦截了对 Documents/Desktop 的写入 | 把仓库和项目放在非受保护目录,或将 Pi Desktop 加入受控文件夹访问的允许名单(见下文) |

#### 受控文件夹访问(勒索软件防护)

Windows **受控文件夹访问**会保护 `Documents`、`Desktop`、`Pictures` 等文件夹,静默拦截它不信任的应用的写入。Pi Desktop 是会编辑文件的编程智能体,如果你的仓库或项目位于受保护文件夹内,就会表现为间歇性的 `EPERM`/`EACCES` 失败(`npm install` 期间、代理编辑代码时或保存文件时)。

最可靠的做法是让代码远离受保护文件夹。把仓库和项目放在不受保护的路径,例如:

```powershell
# 不要用 C:\Users\<you>\Documents\... — 使用不受保护的路径:
git clone https://github.com/FaqFirebase/pi-desktop.git C:\dev\pi-desktop
```

如果必须把代码放在 Documents/Desktop 下,则改为放行应用:

**Windows 安全中心 → 病毒和威胁防护 → 勒索软件防护 → 管理勒索软件防护 → 通过"受控文件夹访问"允许某个应用 → 添加允许的应用**,然后添加已安装的 `Pi Desktop.exe`(开发时还需添加 `node.exe`、`git.exe` 和 `electron.exe`)。

> 便携版 `.exe` 每次启动都会重新解压到临时目录,对它的放行不会保留。如果你依赖放行方案,请使用**安装版**(`Pi-Desktop-<version>-win-x64-setup.exe`)。

#### 手动下载 Electron 二进制

如果 `npm install` 已完成,但应用无法启动、Electron 缺失或损坏,可以直接从 GitHub 下载并解压到位。这是 `node_modules\electron\dist` 内容不完整(例如只有 `locales` 而没有 `electron.exe`)时的已知有效回退方案。

如果 `node_modules/electron/package.json` 中的版本与 `43.0.0` 不同,请替换为实际版本。

```powershell
$ver = "43.0.0"
$url = "https://github.com/electron/electron/releases/download/v$ver/electron-v$ver-win32-x64.zip"
$zip = "$env:TEMP\electron-v$ver-win32-x64.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
if (Test-Path node_modules\electron\dist) { Remove-Item -Recurse -Force node_modules\electron\dist }
Expand-Archive -Path $zip -DestinationPath node_modules\electron\dist -Force
"electron.exe" | Out-File -Encoding ASCII -NoNewline node_modules\electron\path.txt
"v$ver" | Out-File -Encoding ASCII -NoNewline node_modules\electron\dist\version
```

完成后,`npm run dev` 应可正常运行。

> **注意:** Windows 构建由社区测试。如果遇到上表未涵盖的问题,请[提交 bug 报告](https://github.com/FaqFirebase/pi-desktop/issues)。

<details>
<summary>更多截图</summary>

![空会话的中央输入框与项目选择器](docs/screenshots/Screenshot_20260824_182005.png)

![带终端与 diff 查看器的工作区布局](docs/screenshots/Screenshot_20260824_182322.png)

</details>

## 许可证

[Apache 2.0](LICENSE)

## 相关链接

- [pi-desktop.com](https://pi-desktop.com)
- [pi.dev](https://pi.dev)
- [软件包](https://pi.dev/packages)
- [Issues](https://github.com/FaqFirebase/pi-desktop/issues)
