/**
 * 内置工具插件。每一个都会通过 @hoshi/tools 注册工具。
 * 使用前需要先 ctx.plugin(tools())，再挂上这些插件。
 */

export { shellPlugin, defaultShell, runCommand } from "./shell.js";
export { filesystemPlugin } from "./filesystem.js";
export { resolveWorkspaceRoot, resolveInsideWorkspace, isInsideWorkspace } from "./workspace.js";
