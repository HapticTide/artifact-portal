import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAndroidMappingUploadTarget,
    buildAndroidUploadTarget,
    buildIosUploadTarget,
    validateAndroidMappingUploadFile,
    validateAndroidUploadFile,
    validateIosUploadFile,
} from '../src/server/upload.js';
import {
    androidMappingCandidates,
    androidMappingFilenameForApk,
} from '../src/server/androidMapping.js';

test('buildIosUploadTarget creates safe iOS build path', () => {
    const target = buildIosUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/feat/tank/upload portal',
        version: '1.2.0',
        filename: 'IMWE-1.2.0(123).ipa',
    });

    assert.equal(target.relativePath, 'ios/feat-tank-upload-portal/1.2.0/IMWE-1.2.0(123).ipa');
    assert.equal(
        target.absolutePath,
        '/var/lib/artifact-portal/builds/ios/feat-tank-upload-portal/1.2.0/IMWE-1.2.0(123).ipa'
    );
});

test('validateIosUploadFile only accepts ipa files', () => {
    assert.equal(validateIosUploadFile('IMWE-1.2.0(123).ipa'), true);
    assert.equal(validateIosUploadFile('IMWE-1.2.0(123).zip'), false);
    assert.equal(validateIosUploadFile('../IMWE-1.2.0(123).ipa'), false);
});

test('buildAndroidUploadTarget creates safe Android build path', () => {
    const target = buildAndroidUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/feat/tank/upload portal',
        filename: 'IMWE_v1.2.0.123_06_02_10_30_online-release.apk',
    });

    assert.equal(
        target.relativePath,
        'android/feat-tank-upload-portal/IMWE_v1.2.0.123_06_02_10_30_online-release.apk'
    );
    assert.equal(
        target.absolutePath,
        '/var/lib/artifact-portal/builds/android/feat-tank-upload-portal/IMWE_v1.2.0.123_06_02_10_30_online-release.apk'
    );
});

test('validateAndroidUploadFile only accepts apk files', () => {
    assert.equal(validateAndroidUploadFile('IMWE_v1.2.0.123_06_02_10_30_online-release.apk'), true);
    assert.equal(validateAndroidUploadFile('IMWE_v1.2.0.123_06_02_10_30_online-release.zip'), false);
    assert.equal(validateAndroidUploadFile('../IMWE_v1.2.0.123_06_02_10_30_online-release.apk'), false);
});

test('validateAndroidMappingUploadFile only accepts txt files', () => {
    assert.equal(validateAndroidMappingUploadFile('mapping.txt'), true);
    assert.equal(validateAndroidMappingUploadFile('mapping.TXT'), true);
    // .zip 及其他扩展名均被拒绝
    assert.equal(validateAndroidMappingUploadFile('mapping.zip'), false);
    assert.equal(validateAndroidMappingUploadFile('mapping'), false);
    assert.equal(validateAndroidMappingUploadFile('../mapping.txt'), false);
});

test('androidMappingFilenameForApk derives a single txt filename', () => {
    assert.equal(
        androidMappingFilenameForApk('IMWE_v1.2.0.123_online-release.apk'),
        'IMWE_v1.2.0.123_online-release.mapping.txt'
    );
});

test('androidMappingCandidates returns exactly one txt candidate', () => {
    const candidates = androidMappingCandidates('IMWE_v1.2.0.123_online-release.apk');
    assert.deepEqual(candidates, ['IMWE_v1.2.0.123_online-release.mapping.txt']);
});

test('buildAndroidMappingUploadTarget maps txt uploads to a stable path', () => {
    // 无论传入的 mapping 文件名如何，只要是 .txt，落盘路径都由 APK 名决定
    const fromPlain = buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'IMWE_v1.2.0.123_online-release.apk',
        filename: 'mapping.txt',
    });
    const fromRenamed = buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'IMWE_v1.2.0.123_online-release.apk',
        filename: 'r8-mapping.txt',
    });

    const expectedRelative =
        'android/dev/mapping/IMWE_v1.2.0.123_online-release.mapping.txt';

    assert.equal(fromPlain.relativePath, expectedRelative);
    // 两次不同的上传文件名解析到同一路径，保证重复上传必然覆盖
    assert.equal(fromRenamed.relativePath, expectedRelative);
    assert.equal(
        fromPlain.absolutePath,
        '/var/lib/artifact-portal/builds/android/dev/mapping/IMWE_v1.2.0.123_online-release.mapping.txt'
    );
    assert.equal(fromPlain.apkRelativePath, 'android/dev/IMWE_v1.2.0.123_online-release.apk');
});

test('buildAndroidMappingUploadTarget rejects non-txt mapping files', () => {
    assert.throws(() => buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'IMWE_v1.2.0.123_online-release.apk',
        filename: 'mapping.zip',
    }), /只允许 \.txt/);
});

test('buildAndroidMappingUploadTarget rejects invalid apk filename', () => {
    assert.throws(() => buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'not-an-apk.txt',
        filename: 'mapping.txt',
    }), /\.apk/);
});
