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
    apkFilenameHasVersionBuild,
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

test('buildAndroidUploadTarget creates safe Android build path with version.build dir', () => {
    const target = buildAndroidUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/feat/tank/upload portal',
        filename: 'IMWE_v1.2.0.123_06_02_10_30_online-release.apk',
    });

    // 目录名同时包含版本号与 build 号，避免同一版本号多次打包互相覆盖
    assert.equal(target.version, '1.2.0.123');
    assert.equal(
        target.relativePath,
        'android/feat-tank-upload-portal/1.2.0.123/IMWE_v1.2.0.123_06_02_10_30_online-release.apk'
    );
    assert.equal(
        target.absolutePath,
        '/var/lib/artifact-portal/builds/android/feat-tank-upload-portal/1.2.0.123/IMWE_v1.2.0.123_06_02_10_30_online-release.apk'
    );
});

test('validateAndroidUploadFile only accepts apk files', () => {
    assert.equal(validateAndroidUploadFile('IMWE_v1.2.0.123_06_02_10_30_online-release.apk'), true);
    assert.equal(validateAndroidUploadFile('IMWE_v1.2.0.123_06_02_10_30_online-release.zip'), false);
    assert.equal(validateAndroidUploadFile('../IMWE_v1.2.0.123_06_02_10_30_online-release.apk'), false);
});

test('apkFilenameHasVersionBuild requires both version and build number', () => {
    // 版本号 + build 号齐全
    assert.equal(
        apkFilenameHasVersionBuild('IMWE_v1.2.0.123_06_02_10_30_online-release.apk'),
        true
    );
    assert.equal(
        apkFilenameHasVersionBuild('MyApp_v0.6.0.14_01_12_15_31_online-release.apk'),
        true
    );
    // 只有版本号，缺少 build 号，必须被拒绝——否则会静默落到 unknown 目录且在页面上"消失"
    assert.equal(apkFilenameHasVersionBuild('MyApp_v1.2.0_release.apk'), false);
    assert.equal(apkFilenameHasVersionBuild('MyApp.apk'), false);
    assert.equal(apkFilenameHasVersionBuild('not-an-apk.txt'), false);
});

test('validateAndroidMappingUploadFile accepts zip and txt files', () => {
    assert.equal(validateAndroidMappingUploadFile('mapping.zip'), true);
    assert.equal(validateAndroidMappingUploadFile('mapping.ZIP'), true);
    // 过渡期兼容旧 CI：.txt 也接受，落盘统一为 .zip
    assert.equal(validateAndroidMappingUploadFile('mapping.txt'), true);
    assert.equal(validateAndroidMappingUploadFile('mapping.TXT'), true);
    // 其他扩展名仍被拒绝
    assert.equal(validateAndroidMappingUploadFile('mapping'), false);
    assert.equal(validateAndroidMappingUploadFile('mapping.json'), false);
    assert.equal(validateAndroidMappingUploadFile('../mapping.zip'), false);
});

test('androidMappingFilenameForApk derives a single zip filename', () => {
    assert.equal(
        androidMappingFilenameForApk('IMWE_v1.2.0.123_online-release.apk'),
        'IMWE_v1.2.0.123_online-release.mapping.zip'
    );
});

test('androidMappingCandidates returns exactly one zip candidate', () => {
    const candidates = androidMappingCandidates('IMWE_v1.2.0.123_online-release.apk');
    assert.deepEqual(candidates, ['IMWE_v1.2.0.123_online-release.mapping.zip']);
});

test('buildAndroidMappingUploadTarget maps zip uploads to a stable path alongside the apk', () => {
    // 无论传入的 mapping 文件名如何，只要是 .zip，落盘路径都由 APK 名决定
    const fromPlain = buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'IMWE_v1.2.0.123_online-release.apk',
        filename: 'mapping.zip',
    });
    const fromRenamed = buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'IMWE_v1.2.0.123_online-release.apk',
        filename: 'r8-mapping.zip',
    });

    const expectedRelative =
        'android/dev/1.2.0.123/IMWE_v1.2.0.123_online-release.mapping.zip';

    assert.equal(fromPlain.relativePath, expectedRelative);
    // 两次不同的上传文件名解析到同一路径，保证重复上传必然覆盖
    assert.equal(fromRenamed.relativePath, expectedRelative);
    assert.equal(
        fromPlain.absolutePath,
        '/var/lib/artifact-portal/builds/android/dev/1.2.0.123/IMWE_v1.2.0.123_online-release.mapping.zip'
    );
    // mapping 与 APK 落在同一个 version.build 目录下
    assert.equal(fromPlain.apkRelativePath, 'android/dev/1.2.0.123/IMWE_v1.2.0.123_online-release.apk');
});

test('buildAndroidMappingUploadTarget accepts .txt and normalizes to .zip on disk', () => {
    const result = buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'IMWE_v1.2.0.123_online-release.apk',
        filename: 'mapping.txt',
    });
    // 即使上传 .txt，落盘仍为 .zip
    assert.equal(
        result.relativePath,
        'android/dev/1.2.0.123/IMWE_v1.2.0.123_online-release.mapping.zip'
    );
});

test('buildAndroidMappingUploadTarget rejects non-zip-or-txt mapping files', () => {
    assert.throws(() => buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'IMWE_v1.2.0.123_online-release.apk',
        filename: 'mapping.json',
    }), /只允许/);
});

test('buildAndroidMappingUploadTarget rejects invalid apk filename', () => {
    assert.throws(() => buildAndroidMappingUploadTarget({
        buildsDir: '/var/lib/artifact-portal/builds',
        branch: 'origin/dev',
        apkFilename: 'not-an-apk.txt',
        filename: 'mapping.zip',
    }), /\.apk/);
});
