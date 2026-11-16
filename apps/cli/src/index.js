#!/usr/bin/env node

/**
 * Hoshi 的命令行壳。这个进程托管插件运行时，它本身不是插件。
 */
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法: hoshi [command]");
    console.log("Hoshi 是一套插件化的 Agent 运行时。");
    return;
  }

  console.log("Hoshi CLI 骨架已就绪，接下来实现运行时和 Agent 循环。");
}

main();
