import test from 'node:test';
import assert from 'node:assert/strict';
import { androidEnvFromPackageName, packageNameFromManifest, readApkPackageName } from '../src/server/androidPackage.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function binaryManifest(packageName) {
    const strings = ['manifest', 'package', packageName];
    const encoded = strings.map(value => {
        const content = Buffer.from(value);
        return Buffer.concat([Buffer.from([content.length, content.length]), content, Buffer.from([0])]);
    });
    const stringData = Buffer.concat(encoded);
    const pool = Buffer.alloc(28 + strings.length * 4 + stringData.length);
    pool.writeUInt16LE(0x0001, 0);
    pool.writeUInt16LE(28, 2);
    pool.writeUInt32LE(pool.length, 4);
    pool.writeUInt32LE(strings.length, 8);
    pool.writeUInt32LE(0x100, 16);
    pool.writeUInt32LE(28 + strings.length * 4, 20);
    let offset = 0;
    encoded.forEach((value, index) => {
        pool.writeUInt32LE(offset, 28 + index * 4);
        offset += value.length;
    });
    stringData.copy(pool, 28 + strings.length * 4);

    const tag = Buffer.alloc(56);
    tag.writeUInt16LE(0x0102, 0);
    tag.writeUInt16LE(36, 2);
    tag.writeUInt32LE(tag.length, 4);
    tag.writeUInt32LE(0xffffffff, 16); // namespace
    tag.writeUInt32LE(0, 20); // manifest
    tag.writeUInt16LE(20, 24); // attribute start relative to attrExt
    tag.writeUInt16LE(20, 26);
    tag.writeUInt16LE(1, 28);
    tag.writeUInt32LE(0xffffffff, 36); // attribute namespace
    tag.writeUInt32LE(1, 40); // package
    tag.writeUInt32LE(2, 44); // value
    tag.writeUInt16LE(8, 48); // typed value size
    tag.writeUInt8(0x03, 51); // string
    tag.writeUInt32LE(2, 52);

    const root = Buffer.alloc(8);
    root.writeUInt16LE(0x0003, 0);
    root.writeUInt16LE(8, 2);
    root.writeUInt32LE(8 + pool.length + tag.length, 4);
    return Buffer.concat([root, pool, tag]);
}

test('Android binary manifest package name determines environment, independent of branch', () => {
    const pre = packageNameFromManifest(binaryManifest('com.imwe.app.pre'));
    const testPackage = packageNameFromManifest(binaryManifest('com.imwe.app.test'));
    assert.equal(pre, 'com.imwe.app.pre');
    assert.equal(androidEnvFromPackageName(pre), 'pre');
    assert.equal(androidEnvFromPackageName(testPackage), 'test');
});

test('plain XML manifest and malformed APK fallback are handled', () => {
    assert.equal(packageNameFromManifest(Buffer.from('<manifest package="com.imwe.app.pre"/>')), 'com.imwe.app.pre');
    assert.equal(packageNameFromManifest(Buffer.from('invalid')), null);
    assert.equal(androidEnvFromPackageName(null), 'test');
});

test('APK ZIP reader extracts the actual package name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'apk-package-'));
    const apk = join(directory, 'sample.apk');
    try {
        await writeFile(join(directory, 'AndroidManifest.xml'), binaryManifest('com.imwe.app.pre'));
        await promisify(execFile)('zip', ['-q', apk, 'AndroidManifest.xml'], { cwd: directory });
        assert.equal(await readApkPackageName(apk), 'com.imwe.app.pre');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
