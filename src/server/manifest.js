/**
 * iOS manifest.plist 生成模块
 * 
 * 功能：
 * - 动态生成用于 iOS OTA 安装的 manifest.plist
 * - 支持从配置或 IPA 解析获取 Bundle ID
 */

import config from './config.js';

/**
 * 生成 manifest.plist 内容
 * @param {object} options - 配置选项
 * @param {string} options.ipaUrl - IPA 下载 URL（完整 URL）
 * @param {string} options.bundleId - Bundle ID
 * @param {string} options.version - 版本号
 * @param {string} options.build - 构建号
 * @param {string} options.displayName - 显示名称
 * @param {string} options.iconUrl - 图标 URL（可选）
 * @returns {string} manifest.plist 内容
 */
export function generateManifest(options) {
    const {
        ipaUrl,
        bundleId = config.iosBundleId,
        version = '1.0.0',
        build = '1',
        displayName = config.iosDisplayName,
        iconUrl = '',
    } = options;

    // 完整版本字符串
    const fullVersion = `${version}`;

    // 对 IPA URL 进行编码（处理括号等特殊字符）
    const encodedIpaUrl = encodeUrlPath(ipaUrl);

    let manifest = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${escapeXml(encodedIpaUrl)}</string>
                </dict>`;

    // 如果有图标 URL，添加图标资源
    if (iconUrl) {
        manifest += `
                <dict>
                    <key>kind</key>
                    <string>display-image</string>
                    <key>url</key>
                    <string>${escapeXml(iconUrl)}</string>
                </dict>
                <dict>
                    <key>kind</key>
                    <string>full-size-image</string>
                    <key>url</key>
                    <string>${escapeXml(iconUrl)}</string>
                </dict>`;
    }

    manifest += `
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${escapeXml(bundleId)}</string>
                <key>bundle-version</key>
                <string>${escapeXml(fullVersion)}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${escapeXml(displayName)}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;

    return manifest;
}

/**
 * XML 转义
 */
function escapeXml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * 对 URL 中的特殊字符进行编码
 * 保留 URL 结构字符（:, /, ?, #, @, &, =），只编码文件名中的特殊字符
 * 特别处理括号，因为 iOS 可能对未编码的括号敏感
 */
function encodeUrlPath(url) {
    if (!url) return '';
    // 分离协议和路径
    const match = url.match(/^(https?:\/\/[^\/]+)(\/.*)?$/);
    if (!match) return url;

    const [, base, path] = match;
    if (!path) return url;

    // 对路径中的每个部分进行编码
    const encodedPath = path.split('/').map(segment => {
        // 先用 encodeURIComponent 编码
        let encoded = encodeURIComponent(segment);
        // 再额外编码括号（encodeURIComponent 不会编码它们）
        encoded = encoded.replace(/\(/g, '%28').replace(/\)/g, '%29');
        return encoded;
    }).join('/');

    return base + encodedPath;
}

export default { generateManifest };
