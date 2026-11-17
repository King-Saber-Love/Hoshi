# Hoshi

Hoshi is a plugin-based agent runtime: session log, tool pipeline, and swappable model adapters — one core, CLI, web, and desktop shells.

Hoshi 是一套插件化的 Agent 运行时。一个 Node 核心，外挂 CLI、Web 和桌面端。模型、工具、MCP、权限审批都以插件形式挂载；会话历史从只追加的事件日志派生。

本项目受 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的架构启发，是独立实现，不是官方产品的 fork。

## 要求

- Node.js 22+（开发环境为 Node 24）
- npm（使用 npm workspaces）

## 开发

```bash
npm install
npm test
```

复制 `.env.example` 为 `.env`，填入 `HOSHI_DEEPSEEK_API_KEY` 后，可以跑一轮对话：

```bash
npm run cli -- "你好"
```

默认会挂上 `shell`、`read`、`write`、`edit`、`list`。其中 `shell`、`write`、`edit` 在执行前会询问；可用 `--yes` 自动批准，或 `--no-approvals` 跳过审批（工具会直接执行）。这只是审批，不是完整沙箱。

## 仓库结构

```text
packages/
  runtime/         插件运行时：Context、注册、inject、事件、生命周期、可撤销 effect
  core/            Agent 循环、turn/step、系统提示与工具 schema 组装
  session/         只追加的事件源会话日志，历史从日志派生
  llm/             模型调用缝：ctx.llm.stream
  llm-deepseek/    DeepSeek Messages：原生 fetch + SSE
  llm-openai/      OpenAI 兼容协议
  tools/           工具管线：pre-execute / execute / post-execute
  mcp/             MCP 客户端（stdio / HTTP）
  approvals/       权限与审批
  profile/         命名插件组合（hoshi.yml）
  plugins/         内置工具插件：shell、文件系统等
apps/
  cli/             命令行壳
  web/             Web 壳
  desktop/         Electron 宿主（壳，不是插件）
tests/             跨包冒烟测试
```

## 许可

MIT
