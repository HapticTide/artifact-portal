/**
 * Android 产物的路径与文件名约定
 *
 * 中性模块：scan（artifacts.js）、cleanup、upload、API 共用这里的常量、
 * 版本解析与文件名推导。独立于 upload 模块，避免扫描/读取层反向耦合到上传逻辑。
 *
 * 存储结构：android/<branch>/<version>.<build>/
 *   - 目录名同时包含版本号与构建号（如 1.2.0.123），避免同一版本号下
 *     多次打包（build 递增）时互相覆盖或混在一起。
 *   - APK 与其 mapping 文件放在同一个目录下，不再单独分 mapping 子目录。
 */

import { basename } from 'path';

// mapping 只支持 .zip（R8/ProGuard 混淆映射打包产物，通常包含 mapping.txt 等多个文件）。
// 单一扩展名保证每个 APK 只对应唯一的 mapping 文件名，重复上传必然覆盖，
// 不会出现多扩展名并存、扫描命中旧文件的问题。
export const ANDROID_MAPPING_EXTENSION = '.zip';

/**
 * 是否为合法的 APK 文件名（不含目录分隔符）
 * @param {string} filename
 * @returns {boolean}
 */
function isApkFilename(filename) {
    return typeof filename === 'string'
        && Boolean(filename)
        && basename(filename) === filename
        && filename.toLowerCase().endsWith('.apk');
}

/**
 * 由 APK 文件名推导 mapping 的存储文件名（固定 .zip）
 * IMWE_v1.2.0.123_online-release.apk -> IMWE_v1.2.0.123_online-release.mapping.zip
 * @param {string} apkFilename APK 文件名（不含目录）
 * @returns {string}
 */
export function androidMappingFilenameForApk(apkFilename) {
    if (!isApkFilename(apkFilename)) {
        throw new Error('无效的 APK 文件名');
    }

    const base = apkFilename.slice(0, -'.apk'.length);
    return `${base}.mapping${ANDROID_MAPPING_EXTENSION}`;
}

/**
 * 某个 APK 对应的 mapping 文件名（用于扫描时匹配）
 * 只有一个候选，保证扫描不会出现优先级歧义
 * @param {string} apkFilename
 * @returns {string[]}
 */
export function androidMappingCandidates(apkFilename) {
    return [androidMappingFilenameForApk(apkFilename)];
}

/**
 * 校验 mapping 文件名（只允许 .zip，且不含目录分隔符）
 * @param {string} filename
 * @returns {boolean}
 */
export function isAndroidMappingFilename(filename) {
    return typeof filename === 'string'
        && Boolean(filename)
        && basename(filename) === filename
        && filename.toLowerCase().endsWith(ANDROID_MAPPING_EXTENSION);
}

/**
 * 从 Android APK 文件名解析版本信息
 * 格式：{AppName}_v{version}.{build}_{date}_{time}_online-release.apk
 * 示例：MyApp_v0.6.0.14_01_12_15_31_online-release.apk
 *
 * upload（决定落盘的 version 目录）与 artifacts.js（扫描展示）共用同一份解析逻辑，
 * 避免两处正则不一致导致上传路径和扫描路径互相找不到对方。
 *
 * @param {string} filename APK 文件名（不含目录）
 * @returns {{appName: string, version: string, build: string, time: string|null}|null}
 */
export function parseApkFilename(filename) {
    // 匹配格式：AppName_vVersion.Build_Date_Time_xxx.apk
    const match = filename.match(/^(.+?)_v?(\d+\.\d+\.\d+)\.(\d+)_(\d{2})_(\d{2})_(\d{2})_(\d{2}).*\.apk$/i);
    if (match) {
        const [, appName, version, build, month, day, hour, minute] = match;
        // 构造时间戳（假设当前年份）
        const now = new Date();
        const year = now.getFullYear();
        const time = new Date(year, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));

        return {
            appName,
            version,
            build,
            time: time.toISOString(),
        };
    }

    // 尝试更宽松的匹配
    const looseMatch = filename.match(/v?(\d+\.\d+\.\d+)\.(\d+)/i);
    if (looseMatch) {
        return {
            appName: filename.split('_')[0] || 'App',
            version: looseMatch[1],
            build: looseMatch[2],
            time: null,
        };
    }

    return null;
}

/**
 * 从 APK 文件名解析用于目录落盘的版本目录名（版本号 + build 号）
 * 目录名格式：{version}.{build}，如 1.2.0.123
 * 加上 build 号是为了避免同一版本号下多次打包（build 递增）时目录冲突。
 * 解析失败时回退到 'unknown'。
 * @param {string} filename
 * @returns {string}
 */
export function androidVersionDirForApk(filename) {
    const parsed = parseApkFilename(filename);
    if (!parsed || !parsed.version) {
        return 'unknown';
    }
    return parsed.build ? `${parsed.version}.${parsed.build}` : parsed.version;
}

/**
 * 校验 APK 文件名是否同时携带版本号与 build 号
 *
 * 存储目录名依赖 {version}.{build}（如 1.2.0.123）区分同一版本号下的多次打包。
 * 若文件名缺少 build 号，parseApkFilename 会解析失败（返回 null），
 * androidVersionDirForApk 会静默回退到 'unknown' 目录——
 * 文件依然会上传成功，但扫描/展示逻辑（artifacts.js）会因解析失败而跳过它，
 * 导致该构建在页面上"消失"却查不到原因。
 *
 * 因此必须在上传入口处提前校验并明确拒绝，而不是允许静默落到 unknown 目录。
 *
 * @param {string} filename APK 文件名（不含目录）
 * @returns {boolean}
 */
export function apkFilenameHasVersionBuild(filename) {
    const parsed = parseApkFilename(filename);
    return Boolean(parsed && parsed.version && parsed.build);
}
