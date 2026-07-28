/**
 * Android mapping 文件的路径约定
 *
 * 中性模块：scan（artifacts.js）、cleanup、upload、API 共用这里的常量与文件名推导。
 * 独立于 upload 模块，避免扫描/读取层反向耦合到上传逻辑。
 */

import { basename } from 'path';

// mapping 文件统一存放在 android/<branch>/mapping/ 下
export const ANDROID_MAPPING_DIR = 'mapping';

// mapping 只支持 .txt。
// 单一扩展名保证每个 APK 只对应唯一的 mapping 文件名，重复上传必然覆盖，
// 不会出现多扩展名并存、扫描命中旧文件的问题。
export const ANDROID_MAPPING_EXTENSION = '.txt';

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
 * 由 APK 文件名推导 mapping 的存储文件名（固定 .txt）
 * IMWE_v1.2.0.123_online-release.apk -> IMWE_v1.2.0.123_online-release.mapping.txt
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
 * 校验 mapping 文件名（只允许 .txt，且不含目录分隔符）
 * @param {string} filename
 * @returns {boolean}
 */
export function isAndroidMappingFilename(filename) {
    return typeof filename === 'string'
        && Boolean(filename)
        && basename(filename) === filename
        && filename.toLowerCase().endsWith(ANDROID_MAPPING_EXTENSION);
}
