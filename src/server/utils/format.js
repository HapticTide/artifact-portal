/**
 * 格式化工具函数
 */

/**
 * 格式化文件大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的大小（如 "52.4 MB"）
 */
export function formatFileSize(bytes) {
    if (bytes === null || bytes === undefined || bytes < 0) {
        return '-';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    // 小于 1KB 显示整数，否则保留一位小数
    if (unitIndex === 0) {
        return `${Math.round(size)} ${units[unitIndex]}`;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 格式化相对时间
 * @param {string|Date} dateStr - ISO 日期字符串或 Date 对象
 * @returns {string} 相对时间（如 "2 小时前"）
 */
export function formatRelativeTime(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) {
        return '刚刚';
    } else if (diffMin < 60) {
        return `${diffMin} 分钟前`;
    } else if (diffHour < 24) {
        return `${diffHour} 小时前`;
    } else if (diffDay < 30) {
        return `${diffDay} 天前`;
    } else {
        // 超过 30 天显示具体日期
        return date.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
    }
}

/**
 * 格式化日期时间
 * @param {string|Date} dateStr - ISO 日期字符串或 Date 对象
 * @returns {string} 格式化的日期时间（如 "2026-01-10 18:22"）
 */
export function formatDateTime(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).replace(/\//g, '-');
}

/**
 * 截断 commit hash
 * @param {string} hash - 完整的 commit hash
 * @param {number} length - 截断长度（默认 7）
 * @returns {string}
 */
export function shortenCommit(hash, length = 7) {
    if (!hash || typeof hash !== 'string') return '';
    return hash.slice(0, length);
}

