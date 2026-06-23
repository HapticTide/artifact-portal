/**
 * 配置管理模块
 * 从环境变量加载配置，提供默认值
 */

import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { networkInterfaces } from 'os';

// 加载 .env 文件
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../../.env') });

/**
 * 获取本机内网 IP 地址
 * 优先级：192.168.x.x > 10.x.x.x > 172.16-31.x.x > 127.0.0.1
 * @returns {string} 内网 IP 地址
 */
function getLocalIP() {
    const nets = networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // 跳过 IPv6 和回环地址
            if (net.family === 'IPv6' || net.internal) {
                continue;
            }

            const ip = net.address;

            // 按优先级分类内网 IP
            if (ip.startsWith('192.168.')) {
                candidates.push({ ip, priority: 1 });
            } else if (ip.startsWith('10.')) {
                candidates.push({ ip, priority: 2 });
            } else if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) {
                candidates.push({ ip, priority: 3 });
            }
        }
    }

    // 按优先级排序，返回最优的
    if (candidates.length > 0) {
        candidates.sort((a, b) => a.priority - b.priority);
        return candidates[0].ip;
    }

    return '127.0.0.1';
}

/**
 * 获取公网基础 URL
 * 如果环境变量未设置，则自动检测内网 IP
 * @returns {string} 公网基础 URL
 */
function getPublicBaseUrl() {
    const envUrl = process.env.PUBLIC_BASE_URL;

    if (envUrl && envUrl.trim()) {
        // 使用配置的 URL
        return envUrl.replace(/\/$/, '');
    }

    // 自动检测内网 IP
    const localIP = getLocalIP();
    const port = parseInt(process.env.PORT) || 8088;

    return `http://${localIP}:${port}`;
}

/**
 * 应用配置对象
 */
export const config = {
    // 服务配置
    port: parseInt(process.env.PORT) || 8088,
    host: process.env.HOST || '0.0.0.0',

    // 应用名称（显示在页面标题）
    appName: process.env.APP_NAME || '构建中心',

    // 应用图标（可以是 URL 或相对路径，留空使用内置图标）
    appIcon: process.env.APP_ICON || '',

    // 公网 URL（用于生成 iOS 安装链接）
    // 未配置时自动检测内网 IP
    publicBaseUrl: getPublicBaseUrl(),

    // 构建目录
    buildsDir: process.env.BUILDS_DIR || './sample/builds',

    // Tauri 桌面应用自动更新静态分发目录（仅当配置时挂载 /updater 路由；空 = 禁用，对移动端门户零影响）
    updaterDir: process.env.UPDATER_DIR || '',

    // 上传配置
    uploadToken: process.env.UPLOAD_TOKEN || '',
    uploadMaxBytes: parseInt(process.env.UPLOAD_MAX_BYTES) || 2 * 1024 * 1024 * 1024,

    // iOS 配置（仅作为 fallback，优先从 IPA 文件名解析）
    iosBundleId: process.env.IOS_BUNDLE_ID || 'com.example.app',
    iosDisplayName: process.env.IOS_DISPLAY_NAME || 'MyApp',

    // iOS plist 代理服务配置
    // 由于 iOS 需要受信任的 HTTPS 证书来下载 manifest.plist，
    // 可以配置一个公网 HTTPS 代理服务来生成 manifest
    // 代理服务接收 host、downloadPath、bundleId、AppName、logo 参数
    iosPlistProxyUrl: process.env.IOS_PLIST_PROXY_URL || '',

    // iOS 安装时显示的 logo URL（可选，用于 plist 代理）
    iosPlistLogo: process.env.IOS_PLIST_LOGO || '',

    // Android 配置
    androidPackageName: process.env.ANDROID_PACKAGE_NAME || 'com.example.app', androidDisplayName: process.env.ANDROID_DISPLAY_NAME || 'MyApp',    // 构建清理策略
    maxBuilds: parseInt(process.env.MAX_BUILDS) || 50,
    maxAgeDays: parseInt(process.env.MAX_AGE_DAYS) || 30,
    diskThresholdGB: parseInt(process.env.DISK_THRESHOLD_GB) || 50,

    // 缓存配置
    cache: {
        buildsTTL: 5000,      // 构建列表缓存 5 秒
        qrCodeMax: 100,       // 二维码缓存最多 100 条
    },

    // 安全配置
    security: {
        allowedExtensions: ['.ipa', '.apk', '.plist', '.zip', '.txt', '.json'],
        maxLookback: 20,      // /latest 最多向前查找 20 个构建
    },
};

// 获取绝对路径
Object.defineProperty(config, 'buildsDirAbsolute', {
    get() {
        const { resolve } = require('path');
        if (this.buildsDir.startsWith('/')) {
            return this.buildsDir;
        }
        return resolve(__dirname, '../..', this.buildsDir);
    },
    enumerable: true,
});

/**
 * 验证配置完整性
 */
export function validateConfig() {
    const warnings = [];
    // 内网部署无需 HTTPS 警告
    return warnings;
}

export default config;
