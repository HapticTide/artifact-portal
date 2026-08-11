import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-portal-ios-migration-collision-'));
process.env.BUILDS_DIR = buildsDir;

async function createBuild(relativePath, timestamp) {
    const path = join(buildsDir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, relativePath);
    const date = new Date(timestamp);
    await utimes(path, date, date);
    return path;
}

const productionPath = await createBuild(
    'ios/dev/production/1.0.0/IMWE-1.0.0(10).ipa',
    '2026-08-11T10:00:00Z'
);
await createBuild(
    'ios/dev/pre/1.0.0/IMWE-1.0.0(10).ipa',
    '2026-08-11T11:00:00Z'
);

const dataDir = join(buildsDir, '.data');
await mkdir(dataDir, { recursive: true });
const legacyDatabase = new Database(join(dataDir, 'builds.db'));
legacyDatabase.exec(`
    CREATE TABLE builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dir TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        branch TEXT NOT NULL,
        version TEXT NOT NULL,
        build TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        time TEXT NOT NULL,
        file_path TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
`);
legacyDatabase.prepare(`
    INSERT INTO builds (dir, platform, branch, version, build, size, time, file_path)
    VALUES (?, 'ios', 'dev', '1.0.0', '10', ?, ?, ?)
`).run('ios_dev_1.0.0_10', 17, '2026-08-11T10:00:00.000Z', productionPath);
legacyDatabase.close();

const { default: artifactManager } = await import('../src/server/artifacts.js');
const { default: buildDatabase } = await import('../src/server/database.js');

after(async () => {
    buildDatabase.close();
    await rm(buildsDir, { recursive: true, force: true });
});

test('legacy id stays with production when pre and production share version and build', async () => {
    await artifactManager.getBuilds({ days: 30 });

    const rows = buildDatabase.getBuilds({ platform: 'ios' });
    const production = rows.find(row => row.env === 'production');
    const pre = rows.find(row => row.env === 'pre');

    assert.equal(rows.length, 2);
    assert.equal(production.id, 1);
    assert.equal(production.dir, 'ios_dev_production_1.0.0_10');
    assert.equal(pre.dir, 'ios_dev_pre_1.0.0_10');
    assert.equal(buildDatabase.getTotalHistoryCount(), 2);
});
