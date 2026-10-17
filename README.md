# dsh-manual-bg

把 DeepSeek Harness（DSH）里正在跑的前台 shell 命令，**点一下转成后台任务**。

DSH 的 `jobs` 服务只有 start / list / read / kill，没有「接管进行中前台调用」的接口，
所以官方工具要么一直等到超时、要么你只能干等。本插件补上这块：

- 一个 `run` 工具（改造自官方 `@deepseek-ai/dsh-tool-pwsh`，sandbox / jobs / 超时语义保持一致）；
- 前台等待时同时竞速「命令跑完」和「用户点按钮」；
- Web 对话里只渲染**一行**：命令行 + 行尾 **↩ 图标按钮**（无文字、不展开、不输出块）；
- 点 ↘ 图标 → host 唤醒该调用的等待器 → 工具立刻返回 `[moved to background job <id>]`，
  命令继续在后台跑，agent 马上能继续下一步；跑完有完成通知，输出可用 `job_output` 读、`job_kill` 停。

## 适用平台

- **Windows + PowerShell**（`run` 工具就是 pwsh 工具的改造版）。
- Linux/macOS 需要把工具描述与执行语义换成 bash；架构不用动（`ctx.shell` 本身就是平台执行器）。

## 安装

### 方式 A：从 GitHub 直装（推荐）

```powershell
dsh plugin --profile web add "github:nu0y4/dsh-manual-bg"
```

> 需要 profile 里能解析 `@deepseek-ai/*` 运行时包（本仓库声明了 `peerDependencies`；
> DSH 自带插件依赖齐全时 pnpm 会直接复用）。

### 方式 B：本地开发（link）

```powershell
# 1) 让树外包能解析 @deepseek-ai/* 运行时（在包内建 node_modules/@deepseek-ai junction）
pwsh -File .\scripts\link-deps.ps1

# 2) 装进 web profile（写入依赖 + dsh.profile.bundles）
dsh plugin --profile web add "link:<本仓库绝对路径>"
```

## 接入预设（让模型真正用上 run 工具）

插件本身只提供能力；要在会话里看到按钮，需要把目标预设里的 shell 工具行换成
`dsh-manual-bg/tool`。

### 方式 1：手改预设（原生模式）

在预设的 `agent.cordis.yml` 里，把：

```yaml
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
```

换成：

```yaml
- id: tool-run
  name: 'dsh-manual-bg/tool'
  disabled: !!js process.platform !== 'win32'
```

### 方式 2：全模式覆盖层（原生 + PTC 一起）

`scripts/gen-all-modes-patch.mjs` 会读 DSH 出厂预设（standard / ptc / minimal / cordis），
把它们的 shell 工具行替换成 `dsh-manual-bg/tool`，生成一个 `--patch` 覆盖层：

```powershell
node .\scripts\gen-all-modes-patch.mjs
# 默认输出：$env:DSH_HOME\profiles\web\all-modes.patch.yml（可用 DSH_HOME 覆盖）
```

然后用 `--patch` 挂载（Web 启动参数）：

```powershell
dsh web --patch <...>\lan-access.patch.yml --patch <...>\all-modes.patch.yml --no-open
```

环境变量：`DSH_WEB_PRESETS_DIR`（dsh-web-app 的 presets 目录）、`DSH_HOME`（输出位置）。

不支持出厂预设升级后的自动迁移：DSH 升级后重跑生成器即可。

## 原理

```
浏览器（client 半边）                         host（Node 进程）
┌──────────────────────────┐                ┌───────────────────────────────┐
│ tool.call.toolview       │   POST         │ manualBackground 服务          │
│  key = "run"             │ ─────────────▶ │  Map<callId, resolve>          │
│  命令行 + 行尾 ↩ 图标     │ /manual-bg/    │  promote(callId) → resolve()   │
└──────────────────────────┘  promote       └──────────────┬────────────────┘
                                                           │ 唤醒
                                          ┌────────────────▼────────────────┐
                                          │ run 工具 execute()              │
                                          │  registry.start(job)            │
                                          │  race(job 完成, 用户 promote)    │
                                          │  完了直接返回 exit/stdout        │
                                          │  用户点了 → 返回 job id           │
                                          └─────────────────────────────────┘
```

- **host**（`lib/index.js`）：提供 `manualBackground` 服务 + `/manual-bg/promote`、
  `/manual-bg/ping` 两条 HTTP 路由。
- **tool**（`lib/tool.js`）：`run` 工具。前台调用先注册成 job，再
  `Promise.race([registry.wait(...), promotePromise])`；按钮命中时返回
  `kind: "promoted"`（`timeoutMs: 0` 作为手动标记），job 继续跑。
- **client**（`lib/client.js`）：手写 DSH ModuleLoader bundle，注册
  `tool.call.toolview`（key=`run`），渲染单行折叠卡片。

## 行为与边界

- 按钮只对本插件提供的 `run` 工具生效（原生 `pwsh`/`bash` 卡片没有按钮）。
- 失败安全：host 服务不可用时，工具行为退化为官方 pwsh 工具（不会崩）。
- `/manual-bg/promote` 只接受 `{callId}`，只做「把已登记的前台等待转后台」，
  不执行命令、不返回数据；`/manual-bg/ping` 返回待转数量，便于排障。
- 后台任务与官方 `job_output` / `job_kill` 完全互通；完成通知走官方 jobs 消费面。

## 开发 / 测试

```powershell
node test/host-service.test.mjs   # host 服务 + HTTP 路由逻辑
node test/client-view.test.mjs    # client bundle（mock ModuleLoader/react）渲染与点击
```

## 已知限制

- pending 等待器按**进程内 callId** 关联，只在一次调用存活期内有效。
- PTC 模式下按钮位于 `run_code` 卡片展开后的**子调用行**上（命令不是独立卡片）。
- 覆盖层整份替换出厂预设的 `config`，Web 编辑器里对这几个预设的修改会被盖掉。
- LAN 开放时（示例中的 `lan-access.patch.yml`）同网段浏览器也能调 promote 路由：
  该动作只能把已在跑的命令转后台，不接受参数，风险可控。

## 致谢 / 归属

`lib/tool.js` 改写自 DeepSeek Harness 官方包
[`@deepseek-ai/dsh-tool-pwsh`](https://github.com/deepseek-ai/deepseek-harness)
（MIT）。其余代码为本项目原创。

## License

MIT
