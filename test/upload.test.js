import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAndroidUploadTarget,
    buildIosUploadTarget,
    validateAndroidUploadFile,
    validateIosUploadFile,
} from '../src/server/upload.js';

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
