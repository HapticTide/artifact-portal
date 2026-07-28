import { basename, join } from 'path';
import {
    ANDROID_MAPPING_DIR,
    androidMappingFilenameForApk,
    isAndroidMappingFilename,
} from './androidMapping.js';

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
 * 校验 mapping 上传文件名（只允许 .txt）
 * 保留此导出以兼容既有调用方，实际委托给中性模块的路径约定
 */
export function validateAndroidMappingUploadFile(filename) {
    return isAndroidMappingFilename(filename);
}

/**
 * 构造 Android mapping 上传目标路径
 * 存储结构：android/<branch>/mapping/<apkBaseName>.mapping.txt
 * mapping 与 APK 通过文件名一一对应，扩展名固定 .txt，重复上传必然覆盖
 */
export function buildAndroidMappingUploadTarget({ buildsDir, branch, apkFilename, filename }) {
    if (!validateAndroidUploadFile(apkFilename)) {
        throw new Error('apk 参数必须是合法的 .apk 文件名');
    }

    if (!validateAndroidMappingUploadFile(filename)) {
        throw new Error('mapping 文件只允许 .txt 格式');
    }

    const safeBranch = sanitizeSegment(branch, 'unknown');
    const safeApkFilename = basename(apkFilename);
    const safeFilename = androidMappingFilenameForApk(safeApkFilename);
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
