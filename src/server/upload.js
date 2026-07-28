import { basename, join } from 'path';

// Android mapping 文件统一存放在 android/<branch>/mapping/ 下
export const ANDROID_MAPPING_DIR = 'mapping';

// mapping 允许的扩展名（需同时在 config.security.allowedExtensions 中，否则无法下载）
const MAPPING_EXTENSIONS = ['.txt', '.zip'];

function sanitizeSegment(value, fallback) {
    const normalized = String(value || '')
        .replace(/^origin\//, '')
        .replace(/[\\/]+/g, '-')
        .replace(/[^\p{L}\p{N}._() -]+/gu, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[.-]+|[.-]+$/g, '')
        .trim();

    return normalized || fallback;
}

export function validateIosUploadFile(filename) {
    if (typeof filename !== 'string' || !filename || basename(filename) !== filename) {
        return false;
    }

    return filename.toLowerCase().endsWith('.ipa');
}

export function validateAndroidUploadFile(filename) {
    if (typeof filename !== 'string' || !filename || basename(filename) !== filename) {
        return false;
    }

    return filename.toLowerCase().endsWith('.apk');
}

export function buildIosUploadTarget({ buildsDir, branch, version, filename }) {
    if (!validateIosUploadFile(filename)) {
        throw new Error('只允许上传 .ipa 文件');
    }

    const safeBranch = sanitizeSegment(branch, 'unknown');
    const safeVersion = sanitizeSegment(version, 'unknown');
    const safeFilename = basename(filename);
    const relativePath = join('ios', safeBranch, safeVersion, safeFilename);

    return {
        branch: safeBranch,
        version: safeVersion,
        filename: safeFilename,
        relativePath,
        directory: join(buildsDir, 'ios', safeBranch, safeVersion),
        absolutePath: join(buildsDir, relativePath),
    };
}

export function buildAndroidUploadTarget({ buildsDir, branch, filename }) {
    if (!validateAndroidUploadFile(filename)) {
        throw new Error('只允许上传 .apk 文件');
    }

    const safeBranch = sanitizeSegment(branch, 'unknown');
    const safeFilename = basename(filename);
    const relativePath = join('android', safeBranch, safeFilename);

    return {
        branch: safeBranch,
        filename: safeFilename,
        relativePath,
        directory: join(buildsDir, 'android', safeBranch),
        absolutePath: join(buildsDir, relativePath),
    };
}

/**
 * 校验 mapping 上传文件名（只允许 .txt / .zip）
 */
export function validateAndroidMappingUploadFile(filename) {
    if (typeof filename !== 'string' || !filename || basename(filename) !== filename) {
        return false;
    }

    const lower = filename.toLowerCase();
    return MAPPING_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * 由 APK 文件名推导 mapping 的存储文件名
 * IMWE_v1.2.0.123_online-release.apk -> IMWE_v1.2.0.123_online-release.mapping.txt
 * @param {string} apkFilename APK 文件名（不含目录）
 * @param {string} [ext] mapping 扩展名（.txt / .zip），默认 .txt
 */
export function androidMappingFilenameForApk(apkFilename, ext = '.txt') {
    if (!validateAndroidUploadFile(apkFilename)) {
        throw new Error('无效的 APK 文件名');
    }

    const base = basename(apkFilename).slice(0, -'.apk'.length);
    return `${base}.mapping${ext}`;
}

/**
 * 列出某个 APK 可能对应的所有 mapping 文件名（用于扫描时匹配）
 */
export function androidMappingCandidates(apkFilename) {
    return MAPPING_EXTENSIONS.map((ext) => androidMappingFilenameForApk(apkFilename, ext));
}

/**
 * 构造 Android mapping 上传目标路径
 * 存储结构：android/<branch>/mapping/<apkBaseName>.mapping.<txt|zip>
 * mapping 与 APK 通过文件名一一对应，无需额外元数据
 */
export function buildAndroidMappingUploadTarget({ buildsDir, branch, apkFilename, filename }) {
    if (!validateAndroidUploadFile(apkFilename)) {
        throw new Error('apk 参数必须是合法的 .apk 文件名');
    }

    if (!validateAndroidMappingUploadFile(filename)) {
        throw new Error('mapping 文件只允许 .txt 或 .zip 格式');
    }

    const safeBranch = sanitizeSegment(branch, 'unknown');
    const safeApkFilename = basename(apkFilename);
    const ext = filename.toLowerCase().endsWith('.zip') ? '.zip' : '.txt';
    const safeFilename = androidMappingFilenameForApk(safeApkFilename, ext);
    const relativePath = join('android', safeBranch, ANDROID_MAPPING_DIR, safeFilename);

    return {
        branch: safeBranch,
        apkFilename: safeApkFilename,
        apkRelativePath: join('android', safeBranch, safeApkFilename),
        filename: safeFilename,
        relativePath,
        directory: join(buildsDir, 'android', safeBranch, ANDROID_MAPPING_DIR),
        absolutePath: join(buildsDir, relativePath),
    };
}
