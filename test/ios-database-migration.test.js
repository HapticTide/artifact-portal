import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-portal-ios-migration-'));
process.env.BUILDS_DIR = buildsDir;

const ipaPath = join(buildsDir, 'ios/dev/1.0.0/IMWE-1.0.0(10).ipa');
await mkdir(dirname(ipaPath), { recursive: true });
await writeFile(ipaPath, 'legacy production');

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
`).run('ios_dev_1.0.0_10', 17, '2026-08-11T10:00:00.000Z', ipaPath);
legacyDatabase.close();

const { default: artifactManager } = await import('../src/server/artifacts.js');
const { default: buildDatabase } = await import('../src/server/database.js');

after(async () => {
    buildDatabase.close();
    await rm(buildsDir, { recursive: true, force: true });
});

test('adding env to legacy ids does not duplicate historical size statistics', async () => {
    await artifactManager.getBuilds({ days: 30 });

    const rows = buildDatabase.getBuilds({ platform: 'ios' });
    const stats = buildDatabase.getSizeStats({ platform: 'ios', limit: 30 });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].dir, 'ios_dev_production_1.0.0_10');
    assert.equal(rows[0].env, 'production');
    assert.equal(buildDatabase.getTotalHistoryCount(), 1);
    assert.equal(stats.ios.summary.count, 1);
});
