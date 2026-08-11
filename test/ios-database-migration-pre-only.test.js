import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-portal-ios-migration-pre-only-'));
process.env.BUILDS_DIR = buildsDir;

const prePath = join(buildsDir, 'ios/dev/pre/1.0.0/IMWE-1.0.0(10).ipa');
await mkdir(dirname(prePath), { recursive: true });
await writeFile(prePath, 'new pre artifact');

const databasePath = join(buildsDir, '.data', 'builds.db');
await mkdir(dirname(databasePath), { recursive: true });
const legacyDatabase = new Database(databasePath);
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
`).run(
    'ios_dev_1.0.0_10',
    17,
    '2026-08-10T10:00:00.000Z',
    join(buildsDir, 'ios/dev/1.0.0/IMWE-1.0.0(10).ipa')
);
legacyDatabase.close();

const { default: artifactManager } = await import('../src/server/artifacts.js');
const { default: buildDatabase } = await import('../src/server/database.js');

after(async () => {
    buildDatabase.close();
    await rm(buildsDir, { recursive: true, force: true });
});

test('pre-only artifact does not reattribute a legacy production history row', async () => {
    await artifactManager.getBuilds({ days: 30 });

    const verificationDatabase = new Database(databasePath, { readonly: true });
    const rows = verificationDatabase.prepare(`
        SELECT id, dir, env, deleted FROM builds ORDER BY id
    `).all();
    verificationDatabase.close();

    assert.equal(rows.length, 2);
    assert.deepEqual(
        { dir: rows[0].dir, env: rows[0].env, deleted: rows[0].deleted },
        { dir: 'ios_dev_1.0.0_10', env: 'production', deleted: 1 }
    );
    assert.deepEqual(
        { dir: rows[1].dir, env: rows[1].env, deleted: rows[1].deleted },
        { dir: 'ios_dev_pre_1.0.0_10', env: 'pre', deleted: 0 }
    );
});
