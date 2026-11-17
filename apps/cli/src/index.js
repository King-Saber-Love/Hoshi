#!/usr/bin/env node

/**
 * Hoshi 的命令行壳。这个进程托管插件运行时，它本身不是插件。
 * 真正的解析和一轮对话在 cli.js 里，方便测试时注入假的标准流和 fetch。
 */

import { runCli } from "./cli.js";

const code = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exit(code);
