/**
 * 文件系统工具函数
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * 安全地读取目录内容
 * @param {string} dirPath - 目录路径
 * @returns {Promise<string[]>} 目录名列表
 */
export async function readDirSafe(dirPath) {
    try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    } catch (err) {
        console.warn(`读取目录失败: ${dirPath}`, err.message);
        return [];
    }
}

/**
 * 安全地读取 JSON 文件
 * @param {string} filePath - 文件路径
 * @returns {Promise<object|null>} 解析后的 JSON 对象，失败返回 null
 */
export async function readJsonSafe(filePath) {
    try {
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.warn(`读取 JSON 失败: ${filePath}`, err.message);
        return null;
    }
}

/**
 * 获取文件大小
 * @param {string} filePath - 文件路径
 * @returns {Promise<number|null>} 文件大小（字节），失败返回 null
 */
export async function getFileSize(filePath) {
    try {
        const stats = await stat(filePath);
        return stats.size;
    } catch {
        return null;
    }
}

/**
 * 检查文件是否存在
 * @param {string} filePath - 文件路径
 * @returns {Promise<boolean>}
 */
export async function fileExists(filePath) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * 获取目录磁盘使用量
 * @param {string} dirPath - 目录路径
 * @returns {Promise<number>} 使用量（字节）
 */
export async function getDiskUsage(dirPath) {
    try {
        // 使用 du 命令获取目录大小（macOS/Linux）
        const output = execSync(`du -sk "${dirPath}" 2>/dev/null || echo "0"`, {
            encoding: 'utf-8',
        });
        const sizeKB = parseInt(output.split('\t')[0]) || 0;
        return sizeKB * 1024;
    } catch {
        return 0;
    }
}

/**
 * 验证路径是否安全（防止路径穿越）
 * @param {string} path - 要验证的路径
 * @returns {boolean}
 */
export function isPathSafe(path) {
    if (!path || typeof path !== 'string') return false;

    // 禁止 .. 和绝对路径
    if (path.includes('..')) return false;
    if (path.startsWith('/')) return false;
    if (path.includes('\\')) return false;  // Windows 路径

    // 禁止空字节攻击
    if (path.includes('\0')) return false;

    return true;
}

/**
 * 验证文件扩展名是否在白名单中
 * @param {string} filename - 文件名
 * @param {string[]} allowedExtensions - 允许的扩展名列表
 * @returns {boolean}
 */
export function isExtensionAllowed(filename, allowedExtensions) {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    return allowedExtensions.includes(ext);
}
