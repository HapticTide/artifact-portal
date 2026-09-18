import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactManager } from '../src/server/artifacts.js';

test('simultaneous build requests share one scan and retry after invalidation', async () => {
    const original = {
        ios: artifactManager._scanIosBuilds,
        android: artifactManager._scanAndroidBuilds,
        sync: artifactManager._syncToDatabase,
    };
    let iosScans = 0;
    let androidScans = 0;
    let releases = [];
    artifactManager._scanIosBuilds = async () => {
        iosScans++;
        await new Promise(resolve => releases.push(resolve));
        return [];
    };
    artifactManager._scanAndroidBuilds = async () => { androidScans++; return []; };
    artifactManager._syncToDatabase = () => {};

    try {
        artifactManager.invalidateCache();
        const requests = [artifactManager._ensureCache(), artifactManager._ensureCache()];
        assert.equal(iosScans, 1);

        artifactManager.invalidateCache();
        releases.shift()();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(iosScans, 2);
        releases.shift()();
        await Promise.all(requests);
        assert.equal(androidScans, 2);
        assert.ok(artifactManager._isCacheValid());
    } finally {
        artifactManager._scanIosBuilds = original.ios;
        artifactManager._scanAndroidBuilds = original.android;
        artifactManager._syncToDatabase = original.sync;
        artifactManager.invalidateCache();
    }
});
