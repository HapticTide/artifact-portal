import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const projectRoot = new URL('..', import.meta.url).pathname;
const cleanupScript = join(projectRoot, 'scripts', 'cleanup-builds.sh');

async function createBuildFile(root, relativePath, timestamp) {
    const filePath = join(root, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, 'artifact');
    const date = new Date(timestamp);
    await utimes(filePath, date, date);
    return filePath;
}

function runCleanup(buildsDir, options = {}) {
    return spawnSync('bash', [cleanupScript], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            BUILDS_DIR: buildsDir,
            MAX_BUILDS: String(options.maxBuilds ?? 2),
            MAX_AGE_DAYS: String(options.maxAgeDays ?? 9999),
            DRY_RUN: String(options.dryRun ?? true),
            NO_COLOR: 'true',
        },
    });
}

test('cleanup script previews old artifacts in current upload layout', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-cleanup-'));

    try {
        const oldest = await createBuildFile(
            buildsDir,
            'ios/dev/1.2.0/IMWE-1.2.0(100).ipa',
            '2026-01-01T00:00:00Z'
        );
        const newest = await createBuildFile(
            buildsDir,
            'ios/dev/1.2.0/IMWE-1.2.0(102).ipa',
            '2026-01-03T00:00:00Z'
        );
        await createBuildFile(
            buildsDir,
            'ios/dev/1.2.0/IMWE-1.2.0(101).ipa',
            '2026-01-02T00:00:00Z'
        );

        const result = runCleanup(buildsDir, { dryRun: true, maxBuilds: 2 });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /DRY_RUN.*IMWE-1\.2\.0\(100\)\.ipa/);
        assert.doesNotMatch(result.stdout, /IMWE-1\.2\.0\(102\)\.ipa/);
        assert.equal((await stat(oldest)).isFile(), true);
        assert.equal((await stat(newest)).isFile(), true);
    } finally {
        await rm(buildsDir, { recursive: true, force: true });
    }
});

test('cleanup script deletes old artifacts when dry run is disabled', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-cleanup-'));

    try {
        const oldest = await createBuildFile(
            buildsDir,
            'android/test/IMWE_v1.2.0.100_01_01_00_00_online-release.apk',
            '2026-01-01T00:00:00Z'
        );
        const newest = await createBuildFile(
            buildsDir,
            'android/test/IMWE_v1.2.0.102_01_03_00_00_online-release.apk',
            '2026-01-03T00:00:00Z'
        );
        await createBuildFile(
            buildsDir,
            'android/test/IMWE_v1.2.0.101_01_02_00_00_online-release.apk',
            '2026-01-02T00:00:00Z'
        );

        const result = runCleanup(buildsDir, { dryRun: false, maxBuilds: 2 });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        await assert.rejects(stat(oldest), /ENOENT/);
        assert.equal((await stat(newest)).isFile(), true);
    } finally {
        await rm(buildsDir, { recursive: true, force: true });
    }
});
