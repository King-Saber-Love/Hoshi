/**
 * 内置 shell 插件：登记名为 shell 的工具，在工作区里执行一条命令。
 * Windows 默认走 cmd.exe，其他系统走 bash（没有 bash 时用 /bin/sh）。
 * 可以配置超时和输出上限；命令本身仍可能访问工作区外的路径，完整隔离要等 sandbox。
 */

import { spawn } from "node:child_process";
import { registerTool } from "@hoshi/tools";
import { resolveInsideWorkspace, resolveWorkspaceRoot } from "./workspace.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * @param {object} [config]
 * @param {string} [config.workspace] 工作区根目录，默认 process.cwd()
 * @param {number} [config.timeoutMs] 默认超时，毫秒
 * @param {number} [config.maxOutputBytes]
 * @param {{ command: string, args?: string[] }} [config.shell] 自定义解释器
 * @returns {import("@hoshi/runtime").HoshiPlugin}
 */
export function shellPlugin(config = {}) {
  const workspace = resolveWorkspaceRoot(config.workspace);
  const defaultTimeout = positiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = positiveNumber(config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, Number.MAX_SAFE_INTEGER);
  const shell = config.shell ?? defaultShell();

  return (ctx) => {
    registerTool(ctx, {
      name: "shell",
      description: "在工作区中执行一条 shell 命令，并返回退出码、标准输出和标准错误。工作目录必须落在工作区内。",
      schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令。" },
          workdir: { type: "string", description: "工作目录，相对工作区根目录。默认是工作区根目录。" },
          timeoutMs: { type: "number", description: `超时毫秒数，默认 ${defaultTimeout}，上限 ${MAX_TIMEOUT_MS}。超时后会结束进程。` },
        },
        required: ["command"],
      },
      async execute(args) {
        const command = requiredString(args, "command");
        const workdir = await resolveInsideWorkspace(workspace, optionalString(args, "workdir") ?? ".");
        const timeoutMs = args && args.timeoutMs !== undefined
          ? positiveNumber(args.timeoutMs, defaultTimeout, MAX_TIMEOUT_MS)
          : defaultTimeout;
        const result = await runCommand({
          shell,
          command,
          cwd: workdir,
          timeoutMs,
          maxOutputBytes,
        });
        return formatShellResult(result);
      },
    });
  };
}

/**
 * @returns {{ command: string, args: string[] }}
 */
export function defaultShell() {
  if (process.platform === "win32") {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  return { command: "/bin/bash", args: ["-c"] };
}

/**
 * @param {object} options
 * @param {{ command: string, args?: string[] }} options.shell
 * @param {string} options.command
 * @param {string} options.cwd
 * @param {number} options.timeoutMs
 * @param {number} options.maxOutputBytes
 */
export function runCommand(options) {
  return new Promise((resolve, reject) => {
    const args = [...(options.shell.args ?? []), options.command];
    const child = spawn(options.shell.command, args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
    });

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Windows 上 shell 是 cmd.exe，只杀父进程会留下还在跑的子进程。
      killProcessTree(child);
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      stdoutChunks.push(buffer);
    });
    child.stderr.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      stderrChunks.push(buffer);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        cwd: options.cwd,
        exitCode,
        signal: signal ?? null,
        timedOut,
        stdout: truncateOutput(Buffer.concat(stdoutChunks), options.maxOutputBytes, stdoutBytes),
        stderr: truncateOutput(Buffer.concat(stderrChunks), options.maxOutputBytes, stderrBytes),
      });
    });
  });
}


/**
 * @param {import("node:child_process").ChildProcess} child
 */
function killProcessTree(child) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 1000).unref?.();
}

/**
 * @param {object} result
 * @returns {string}
 */
function formatShellResult(result) {
  const lines = [
    `exitCode: ${result.exitCode === null ? "null" : result.exitCode}`,
    `cwd: ${result.cwd}`,
    `timedOut: ${result.timedOut ? "true" : "false"}`,
  ];
  if (result.signal) lines.push(`signal: ${result.signal}`);
  lines.push("stdout:", result.stdout.text || "(empty)");
  if (result.stdout.truncated) lines.push("[stdout truncated]");
  lines.push("stderr:", result.stderr.text || "(empty)");
  if (result.stderr.truncated) lines.push("[stderr truncated]");
  return lines.join("\n");
}

/**
 * @param {Buffer} buffer
 * @param {number} maxBytes
 * @param {number} totalBytes
 */
function truncateOutput(buffer, maxBytes, totalBytes) {
  const slice = buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
  return {
    text: slice.toString("utf8"),
    truncated: totalBytes > maxBytes,
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} cap
 */
function positiveNumber(value, fallback, cap) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("超时或输出上限必须是正数");
  }
  return Math.min(value, cap);
}

/**
 * @param {object} args
 * @param {string} key
 */
function requiredString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`shell 需要 ${key}`);
  }
  return value;
}

/**
 * @param {object} args
 * @param {string} key
 */
function optionalString(args, key) {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} 必须是字符串`);
  }
  return value;
}
