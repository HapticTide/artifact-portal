import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-portal-database-'));
process.env.BUILDS_DIR = buildsDir;
const { default: buildDatabase } = await import('../src/server/database.js');

after(async () => {
    await rm(buildsDir, { recursive: true, force: true });
});

test('size stats return the latest limited builds in chronological order', () => {
    const builds = Array.from({ length: 35 }, (_, index) => {
        const buildNumber = index + 1;

        return {
            dir: `ios_dev_1.0.0_${buildNumber}`,
            platform: 'ios',
            branch: 'dev',
            version: '1.0.0',
            build: String(buildNumber),
            size: buildNumber * 1024 * 1024,
            time: new Date(Date.UTC(2026, 0, buildNumber)).toISOString(),
            filePath: `/builds/ios/dev/1.0.0/IMWE-1.0.0(${buildNumber}).ipa`,
        };
    });

    buildDatabase.upsertBuilds(builds);

    const stats = buildDatabase.getSizeStats({ limit: 30, platform: 'ios' });

    assert.equal(stats.ios.summary.count, 30);
    assert.equal(stats.ios.data[0].version, '1.0.0(6)');
    assert.equal(stats.ios.data.at(-1).version, '1.0.0(35)');
    assert.equal(stats.ios.summary.latest.version, '1.0.0(35)');
    assert.equal(stats.android, null);
});
