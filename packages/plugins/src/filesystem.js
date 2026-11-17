/**
 * 内置文件系统插件：登记 read、write、edit、list。
 * 所有路径都必须解析到工作区内部；没有审批，调用会立刻执行。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { registerTool } from "@hoshi/tools";
import { resolveInsideWorkspace, resolveWorkspaceRoot } from "./workspace.js";

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 500;
const DEFAULT_READ_LIMIT = 2000;

/**
 * @param {object} [config]
 * @param {string} [config.workspace]
 * @param {number} [config.maxReadBytes]
 * @param {number} [config.maxListEntries]
 * @returns {import("@hoshi/runtime").HoshiPlugin}
 */
export function filesystemPlugin(config = {}) {
  const workspace = resolveWorkspaceRoot(config.workspace);
  const maxReadBytes = config.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxListEntries = config.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;

  return (ctx) => {
    registerTool(ctx, {
      name: "read",
      description: "读取工作区内的 UTF-8 文本文件，返回带行号的内容。可用 offset（从 1 起）和 limit 分页。",
      schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "要读取的文件路径，相对工作区根目录。" },
          offset: { type: "number", description: "起始行号，从 1 开始，默认 1。" },
          limit: { type: "number", description: `最多返回多少行，默认 ${DEFAULT_READ_LIMIT}。` },
        },
        required: ["file_path"],
      },
      async execute(args) {
        const filePath = await resolveInsideWorkspace(workspace, requiredString(args, "file_path"));
        const offset = integerAtLeast(args?.offset, 1, "offset");
        const limit = integerAtLeast(args?.limit, DEFAULT_READ_LIMIT, "limit");
        return readTextFile(filePath, { offset, limit, maxReadBytes });
      },
    });

    registerTool(ctx, {
      name: "write",
      description: "在工作区内创建或覆盖一个 UTF-8 文本文件。",
      schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "要写入的文件路径，相对工作区根目录。" },
          content: { type: "string", description: "完整的文件内容。" },
        },
        required: ["file_path", "content"],
      },
      async execute(args) {
        const filePath = await resolveInsideWorkspace(workspace, requiredString(args, "file_path"));
        const content = requiredStringAllowEmpty(args, "content");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const existed = await exists(filePath);
        await fs.writeFile(filePath, content, "utf8");
        return `${existed ? "updated" : "created"}: ${filePath} (${byteLength(content)} bytes)`;
      },
    });

    registerTool(ctx, {
      name: "edit",
      description: "用一段字面文本替换工作区内已有文件中的内容。默认只替换一处，old_string 必须恰好出现一次；replace_all 为 true 时替换全部。",
      schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "要编辑的文件路径，相对工作区根目录。" },
          old_string: { type: "string", description: "要被替换的原文。" },
          new_string: { type: "string", description: "替换后的文本，空字符串表示删除匹配。" },
          replace_all: { type: "boolean", description: "是否替换全部匹配，默认 false。" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
      async execute(args) {
        const filePath = await resolveInsideWorkspace(workspace, requiredString(args, "file_path"));
        const oldString = requiredStringAllowEmpty(args, "old_string");
        const newString = requiredStringAllowEmpty(args, "new_string");
        const replaceAll = Boolean(args?.replace_all);
        if (oldString === newString) {
          throw new Error("old_string 和 new_string 不能相同");
        }
        const before = await readExistingText(filePath, maxReadBytes);
        const count = countOccurrences(before, oldString);
        if (count === 0) {
          throw new Error(`在 ${filePath} 中找不到 old_string`);
        }
        if (!replaceAll && count !== 1) {
          throw new Error(`old_string 出现了 ${count} 次，请提供更独特的上下文，或把 replace_all 设为 true`);
        }
        const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
        await fs.writeFile(filePath, after, "utf8");
        return `updated: ${filePath} (${replaceAll ? count : 1} replacement${(replaceAll ? count : 1) === 1 ? "" : "s"})`;
      },
    });

    registerTool(ctx, {
      name: "list",
      description: "列出工作区内一个目录的直接子项（不递归）。",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，相对工作区根目录，默认是工作区根目录。" },
        },
      },
      async execute(args) {
        const dirPath = await resolveInsideWorkspace(workspace, optionalString(args, "path") ?? ".");
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const lines = [];
        let truncated = false;
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (lines.length >= maxListEntries) {
            truncated = true;
            break;
          }
          const kind = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
          lines.push(`${kind}\t${entry.name}`);
        }
        const header = truncated
          ? `${dirPath} (${lines.length} entries, truncated)`
          : `${dirPath} (${lines.length} entries)`;
        return [header, ...lines].join("\n");
      },
    });
  };
}

/**
 * @param {string} filePath
 * @param {{ offset: number, limit: number, maxReadBytes: number }} options
 */
async function readTextFile(filePath, options) {
  const text = await readExistingText(filePath, options.maxReadBytes);
  const lines = text.split("\n");
  // 如果文件以换行结束，split 会多出一个空行，保留它更接近编辑器里的行数。
  const start = options.offset;
  if (start > lines.length) {
    return `${filePath} (empty range, total lines ${lines.length})`;
  }
  const slice = lines.slice(start - 1, start - 1 + options.limit);
  const numbered = slice.map((line, index) => {
    const number = String(start + index).padStart(6, " ");
    return `${number}|${line}`;
  });
  const end = start + slice.length - 1;
  const header = `${filePath} (lines ${start}-${end} of ${lines.length})`;
  return [header, ...numbered].join("\n");
}

/**
 * @param {string} filePath
 * @param {number} maxReadBytes
 */
async function readExistingText(filePath, maxReadBytes) {
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    throw new Error(`${filePath} 是目录，请用 list 查看`);
  }
  if (stat.size > maxReadBytes) {
    throw new Error(`${filePath} 超过读取上限 ${maxReadBytes} 字节`);
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) {
    throw new Error(`${filePath} 不是 UTF-8 文本文件`);
  }
  return buffer.toString("utf8");
}

/**
 * @param {string} filePath
 */
async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * @param {string} haystack
 * @param {string} needle
 */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) {
    throw new Error("old_string 不能是空字符串");
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

/**
 * @param {string} text
 */
function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * @param {object} args
 * @param {string} key
 */
function requiredString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`需要 ${key}`);
  }
  return value;
}

/**
 * @param {object} args
 * @param {string} key
 */
function requiredStringAllowEmpty(args, key) {
  const value = args?.[key];
  if (typeof value !== "string") {
    throw new Error(`${key} 必须是字符串`);
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

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} name
 */
function integerAtLeast(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是大于等于 1 的整数`);
  }
  return value;
}
