import { basename, join } from 'path';
import {
    androidMappingFilenameForApk,
    androidVersionDirForApk,
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
    // version 目录（版本号.build号）从 APK 文件名解析，与 artifacts.js 扫描逻辑保持一致
    const safeVersion = sanitizeSegment(androidVersionDirForApk(safeFilename), 'unknown');
    const relativePath = join('android', safeBranch, safeVersion, safeFilename);

    return {
        branch: safeBranch,
        version: safeVersion,
        filename: safeFilename,
        relativePath,
        directory: join(buildsDir, 'android', safeBranch, safeVersion),
        absolutePath: join(buildsDir, relativePath),
    };
}

/**
 * 校验 mapping 上传文件名（只允许 .zip）
 * 保留此导出以兼容既有调用方，实际委托给中性模块的路径约定
 */
export function validateAndroidMappingUploadFile(filename) {
    return isAndroidMappingFilename(filename);
}

/**
 * 构造 Android mapping 上传目标路径
 * 存储结构：android/<branch>/<version.build>/<apkBaseName>.mapping.zip
 * mapping 与 APK 同放一个版本目录下，通过文件名一一对应，
 * 扩展名固定 .zip，重复上传必然覆盖
 */
export function buildAndroidMappingUploadTarget({ buildsDir, branch, apkFilename, filename }) {
    if (!validateAndroidUploadFile(apkFilename)) {
        throw new Error('apk 参数必须是合法的 .apk 文件名');
    }

    if (!validateAndroidMappingUploadFile(filename)) {
        throw new Error('mapping 文件只允许 .zip 格式');
    }

    const safeBranch = sanitizeSegment(branch, 'unknown');
    const safeApkFilename = basename(apkFilename);
    // version 目录从 APK 文件名解析，确保与该 APK 落盘的目录一致
    const safeVersion = sanitizeSegment(androidVersionDirForApk(safeApkFilename), 'unknown');
    const safeFilename = androidMappingFilenameForApk(safeApkFilename);
    const relativePath = join('android', safeBranch, safeVersion, safeFilename);

    return {
        branch: safeBranch,
        version: safeVersion,
        apkFilename: safeApkFilename,
        apkRelativePath: join('android', safeBranch, safeVersion, safeApkFilename),
        filename: safeFilename,
        relativePath,
        directory: join(buildsDir, 'android', safeBranch, safeVersion),
        absolutePath: join(buildsDir, relativePath),
    };
}
