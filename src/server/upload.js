import { basename, join } from 'path';

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
