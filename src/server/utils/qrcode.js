/**
 * 二维码生成工具（带 LRU 缓存）
 */

import QRCode from 'qrcode';

/**
 * 简单的 LRU 缓存实现
 */
class LRUCache {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return null;

        // 访问时移到末尾（最近使用）
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        // 如果已存在，先删除
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // 如果超出容量，删除最旧的（第一个）
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }
}

// 全局二维码缓存
const qrCache = new LRUCache(100);

/**
 * 生成二维码 PNG Buffer（带缓存）
 * @param {string} text - 要编码的文本
 * @param {object} options - 二维码选项
 * @returns {Promise<Buffer>} PNG 图片 Buffer
 */
export async function generateQRCode(text, options = {}) {
    const cacheKey = `${text}:${JSON.stringify(options)}`;

    // 检查缓存
    const cached = qrCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    // 生成二维码
    const defaultOptions = {
        type: 'png',
        width: 200,
        margin: 2,
        color: {
            dark: '#000000',
            light: '#FFFFFF',
        },
        ...options,
    };

    const buffer = await QRCode.toBuffer(text, defaultOptions);

    // 存入缓存
    qrCache.set(cacheKey, buffer);

    return buffer;
}

/**
 * 生成二维码 Data URL（带缓存）
 * @param {string} text - 要编码的文本
 * @param {object} options - 二维码选项
 * @returns {Promise<string>} Data URL
 */
export async function generateQRCodeDataURL(text, options = {}) {
    const cacheKey = `dataurl:${text}:${JSON.stringify(options)}`;

    // 检查缓存
    const cached = qrCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    // 生成二维码
    const defaultOptions = {
        type: 'image/png',
        width: 200,
        margin: 2,
        ...options,
    };

    const dataUrl = await QRCode.toDataURL(text, defaultOptions);

    // 存入缓存
    qrCache.set(cacheKey, dataUrl);

    return dataUrl;
}

/**
 * 获取缓存统计信息
 */
export function getQRCacheStats() {
    return {
        size: qrCache.size,
        maxSize: qrCache.maxSize,
    };
}

/**
 * 清空缓存
 */
export function clearQRCache() {
    qrCache.clear();
}
