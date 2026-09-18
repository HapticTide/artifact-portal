import test from 'node:test';
import assert from 'node:assert/strict';
import { appLabelFromManifest, readApkAppName, androidEnvFromAppName } from '../src/server/androidPackage.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const LABEL_ID = 0x7f010000;

function pool(strings) {
    const values = strings.map(value => {
        const data = Buffer.from(value);
        return Buffer.concat([Buffer.from([value.length, data.length]), data, Buffer.from([0])]);
    });
    const payload = Buffer.concat(values);
    const chunk = Buffer.alloc(28 + values.length * 4 + payload.length);
    chunk.writeUInt16LE(0x0001, 0);
    chunk.writeUInt16LE(28, 2);
    chunk.writeUInt32LE(chunk.length, 4);
    chunk.writeUInt32LE(values.length, 8);
    chunk.writeUInt32LE(0x100, 16);
    chunk.writeUInt32LE(28 + values.length * 4, 20);
    let offset = 0;
    values.forEach((value, index) => {
        chunk.writeUInt32LE(offset, 28 + index * 4);
        offset += value.length;
    });
    payload.copy(chunk, 28 + values.length * 4);
    return chunk;
}

function binaryManifest(label, reference = false) {
    const strings = pool(['application', 'label', reference ? '@string/app_name' : label]);
    const tag = Buffer.alloc(56);
    tag.writeUInt16LE(0x0102, 0);
    tag.writeUInt16LE(16, 2); // Real Android start-element header size
    tag.writeUInt32LE(tag.length, 4);
    tag.writeUInt32LE(0xffffffff, 16);
    tag.writeUInt32LE(0, 20); // application
    tag.writeUInt16LE(20, 24);
    tag.writeUInt16LE(20, 26);
    tag.writeUInt16LE(1, 28);
    tag.writeUInt32LE(0xffffffff, 36);
    tag.writeUInt32LE(1, 40); // label
    tag.writeUInt32LE(2, 44);
    tag.writeUInt16LE(8, 48);
    tag.writeUInt8(reference ? 0x01 : 0x03, 51);
    tag.writeUInt32LE(reference ? LABEL_ID : 2, 52);
    const root = Buffer.alloc(8);
    root.writeUInt16LE(0x0003, 0);
    root.writeUInt16LE(8, 2);
    root.writeUInt32LE(root.length + strings.length + tag.length, 4);
    return Buffer.concat([root, strings, tag]);
}

test('app label determines environment, including a name containing pre', () => {
    assert.equal(appLabelFromManifest(binaryManifest('IMWE Pre')), 'IMWE Pre');
    assert.equal(androidEnvFromAppName('IMWE Pre'), 'pre');
    assert.equal(androidEnvFromAppName('IMWE Test'), 'test');
});

test('resource references are not mistaken for literal app names', () => {
    assert.equal(appLabelFromManifest(binaryManifest('', true)), null);
});

test('plain XML label and malformed APK fallback are handled', () => {
    assert.equal(appLabelFromManifest(Buffer.from('<manifest><application android:label="IMWE Pre"/></manifest>')), 'IMWE Pre');
    assert.equal(appLabelFromManifest(Buffer.from('invalid')), null);
    assert.equal(androidEnvFromAppName(null), 'test');
});

test('APK ZIP reader extracts installed display name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'apk-label-'));
    const apk = join(directory, 'sample.apk');
    try {
        await writeFile(join(directory, 'AndroidManifest.xml'), binaryManifest('IMWE Pre'));
        await promisify(execFile)('zip', ['-q', apk, 'AndroidManifest.xml'], { cwd: directory });
        assert.equal(await readApkAppName(apk), 'IMWE Pre');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
