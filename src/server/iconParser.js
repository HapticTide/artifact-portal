/**
 * IPA 图标解析模块
 * 
 * 功能：
 * 1. 从 IPA 文件中提取应用图标
 * 2. 支持图标缓存，避免重复解析
 * 3. 自动选择最佳尺寸的图标
 */

import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import yauzl from 'yauzl';
import plist from 'plist';

const openZip = promisify(yauzl.open);

/**
 * iOS 图标文件优先级（优先选择较大尺寸）
 */
const ICON_PRIORITY = [
    'AppIcon60x60@3x.png',
    'AppIcon60x60@2x.png',
    'AppIcon76x76@2x~ipad.png',
    'AppIcon83.5x83.5@2x~ipad.png',
    'Icon-60@3x.png',
    'Icon-60@2x.png',
    'Icon@3x.png',
    'Icon@2x.png'
];

/**
 * 图标解析器类
 */
export class IconParser {
    constructor() {
        // 内存缓存已解析的图标路径
        this._iconCache = new Map();
    }

    /**
     * 获取构建的图标
     * @param {string} buildDir - 构建目录路径
     * @returns {Promise<{path: string, type: string} | null>} 图标信息或 null
     */
    async getIcon(buildDir) {
        // 检查内存缓存
        if (this._iconCache.has(buildDir)) {
            const cachedPath = this._iconCache.get(buildDir);
            if (cachedPath && fs.existsSync(cachedPath)) {
                return { path: cachedPath, type: 'image/png' };
            }
        }

        // 检查是否已有缓存的图标文件
        const cachedIconPath = path.join(buildDir, 'icon.png');
        if (fs.existsSync(cachedIconPath)) {
            this._iconCache.set(buildDir, cachedIconPath);
            return { path: cachedIconPath, type: 'image/png' };
        }

        // 尝试从 IPA 解析
        const ipaIcon = await this._extractIconFromIPA(buildDir);
        if (ipaIcon) {
            this._iconCache.set(buildDir, ipaIcon);
            return { path: ipaIcon, type: 'image/png' };
        }

        // 解析失败
        this._iconCache.set(buildDir, null);
        return null;
    }

    /**
     * 从 IPA 文件提取图标
     * @param {string} ipaDir - IPA 文件所在目录路径
     * @returns {Promise<string | null>} 提取的图标路径或 null
     */
    async _extractIconFromIPA(ipaDir) {
        // 查找 IPA 文件（直接在目录中查找）
        if (!fs.existsSync(ipaDir)) {
            return null;
        }

        const files = fs.readdirSync(ipaDir);
        const ipaFile = files.find(f => f.endsWith('.ipa'));
        if (!ipaFile) {
            return null;
        }

        const ipaPath = path.join(ipaDir, ipaFile);

        try {
            // 打开 IPA (ZIP 格式)
            const zipfile = await openZip(ipaPath, { lazyEntries: true });

            return new Promise((resolve, reject) => {
                let appBundlePath = null;
                let infoPlistEntry = null;
                let iconEntries = [];

                zipfile.on('entry', (entry) => {
                    const fileName = entry.fileName;

                    // 查找 .app 目录
                    const appMatch = fileName.match(/^Payload\/([^/]+\.app)\//);
                    if (appMatch) {
                        appBundlePath = `Payload/${appMatch[1]}`;
                    }

                    // 查找 Info.plist
                    if (fileName.match(/^Payload\/[^/]+\.app\/Info\.plist$/)) {
                        infoPlistEntry = entry;
                    }

                    // 收集可能的图标文件
                    if (fileName.match(/^Payload\/[^/]+\.app\/.*\.png$/) &&
                        (fileName.includes('AppIcon') || fileName.includes('Icon'))) {
                        iconEntries.push(entry);
                    }

                    zipfile.readEntry();
                });

                zipfile.on('end', async () => {
                    try {
                        // 如果没有找到图标，直接返回 null
                        if (iconEntries.length === 0) {
                            resolve(null);
                            return;
                        }

                        // 按优先级排序图标
                        const sortedIcons = this._sortIconsByPriority(iconEntries);

                        if (sortedIcons.length === 0) {
                            resolve(null);
                            return;
                        }

                        // 提取最佳图标
                        const bestIcon = sortedIcons[0];
                        const iconData = await this._readEntryFromZip(ipaPath, bestIcon.fileName);

                        if (iconData) {
                            // 保存到缓存文件
                            const cachedIconPath = path.join(ipaDir, 'icon.png');
                            fs.writeFileSync(cachedIconPath, iconData);
                            resolve(cachedIconPath);
                        } else {
                            resolve(null);
                        }
                    } catch (err) {
                        console.error('[IconParser] 提取图标失败:', err);
                        resolve(null);
                    }
                });

                zipfile.on('error', (err) => {
                    console.error('[IconParser] ZIP 读取错误:', err);
                    resolve(null);
                });

                zipfile.readEntry();
            });
        } catch (err) {
            console.error('[IconParser] IPA 解析失败:', err);
            return null;
        }
    }

    /**
     * 从 ZIP 文件读取指定条目
     * @param {string} zipPath - ZIP 文件路径
     * @param {string} entryName - 条目名称
     * @returns {Promise<Buffer | null>}
     */
    async _readEntryFromZip(zipPath, entryName) {
        return new Promise((resolve, reject) => {
            yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
                if (err) {
                    resolve(null);
                    return;
                }

                zipfile.on('entry', (entry) => {
                    if (entry.fileName === entryName) {
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                resolve(null);
                                return;
                            }

                            const chunks = [];
                            readStream.on('data', (chunk) => chunks.push(chunk));
                            readStream.on('end', () => {
                                resolve(Buffer.concat(chunks));
                            });
                            readStream.on('error', () => resolve(null));
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });

                zipfile.on('end', () => resolve(null));
                zipfile.on('error', () => resolve(null));

                zipfile.readEntry();
            });
        });
    }

    /**
     * 按优先级排序图标条目
     * @param {Array} entries - 图标条目列表
     * @returns {Array} 排序后的条目
     */
    _sortIconsByPriority(entries) {
        return entries.sort((a, b) => {
            const aName = path.basename(a.fileName);
            const bName = path.basename(b.fileName);

            const aIndex = ICON_PRIORITY.findIndex(p => aName.includes(p.replace('.png', '')));
            const bIndex = ICON_PRIORITY.findIndex(p => bName.includes(p.replace('.png', '')));

            // 如果都在优先级列表中，按优先级排序
            if (aIndex !== -1 && bIndex !== -1) {
                return aIndex - bIndex;
            }
            // 在列表中的优先
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;

            // 都不在列表中，按文件名中的数字（分辨率）排序，大的优先
            const aSize = this._extractSizeFromName(aName);
            const bSize = this._extractSizeFromName(bName);
            return bSize - aSize;
        });
    }

    /**
     * 从文件名提取尺寸信息
     * @param {string} name - 文件名
     * @returns {number} 尺寸数值
     */
    _extractSizeFromName(name) {
        // 匹配 60x60@3x, 76x76@2x 等格式
        const match = name.match(/(\d+)(?:x\d+)?@(\d)x/);
        if (match) {
            return parseInt(match[1]) * parseInt(match[2]);
        }
        return 0;
    }

    /**
     * 清除指定构建的图标缓存
     * @param {string} buildDir - 构建目录路径
     */
    clearCache(buildDir) {
        this._iconCache.delete(buildDir);
    }

    /**
     * 清除所有图标缓存
     */
    clearAllCache() {
        this._iconCache.clear();
    }
}

// 导出单例
export const iconParser = new IconParser();
