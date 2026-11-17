/**
 * 把调用方给出的路径解析到工作区内部。
 * 相对路径相对工作区根目录；绝对路径也必须落在根目录里。
 * 会跟随已存在的符号链接，防止通过链接逃出工作区。
 * 这只是路径护栏，不是操作系统级沙箱。
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * @param {string} [root]
 * @returns {string}
 */
export function resolveWorkspaceRoot(root) {
  const value = typeof root === "string" && root.length > 0 ? root : process.cwd();
  return path.resolve(value);
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInsideWorkspace(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 解析一条位于工作区内的路径。目标文件可以尚不存在，但其已存在的祖先必须在工作区内。
 * @param {string} workspace
 * @param {string} [inputPath]
 * @returns {Promise<string>}
 */
export async function resolveInsideWorkspace(workspace, inputPath = ".") {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("路径不能为空");
  }

  const root = await realExistingPath(resolveWorkspaceRoot(workspace));
  const requested = path.resolve(root, inputPath);
  if (!isInsideWorkspace(root, requested)) {
    throw new Error(`路径超出工作区: ${inputPath}`);
  }

  try {
    const real = await fs.realpath(requested);
    if (!isInsideWorkspace(root, real)) {
      throw new Error(`路径超出工作区: ${inputPath}`);
    }
    return real;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const { realParent, remainder } = await splitAtExistingParent(root, requested);
  const reconstructed = remainder ? path.resolve(realParent, remainder) : realParent;
  if (!isInsideWorkspace(root, reconstructed)) {
    throw new Error(`路径超出工作区: ${inputPath}`);
  }
  return reconstructed;
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function realExistingPath(filePath) {
  return fs.realpath(filePath);
}

/**
 * 从目标一路向上，找到已经存在且仍在工作区内的祖先，返回它的 realpath 和剩余相对路径。
 * @param {string} root
 * @param {string} requested
 */
async function splitAtExistingParent(root, requested) {
  let current = requested;
  const segments = [];

  while (true) {
    try {
      const realParent = await fs.realpath(current);
      if (!isInsideWorkspace(root, realParent)) {
        throw new Error(`路径超出工作区: ${requested}`);
      }
      segments.reverse();
      return {
        realParent,
        remainder: segments.length > 0 ? path.join(...segments) : "",
      };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    if (current === root || !isInsideWorkspace(root, current)) {
      throw new Error(`路径超出工作区: ${requested}`);
    }

    segments.push(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`路径超出工作区: ${requested}`);
    }
    current = parent;
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
