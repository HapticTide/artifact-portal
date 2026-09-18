import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-portal-android-migration-'));
process.env.BUILDS_DIR = buildsDir;
const { default: buildDatabase } = await import('../src/server/database.js');
const databasePath = join(buildsDir, '.data', 'builds.db');
const db = new Database(databasePath);

after(async () => {
    db.close();
    buildDatabase.close();
    await rm(buildsDir, { recursive: true, force: true });
});

function addLegacy(build, filePath) {
    const dir = `android_dev_1.0.0_${build}`;
    db.prepare(`
        INSERT INTO builds (dir, platform, branch, env, version, build, size, time, file_path)
        VALUES (?, 'android', 'dev', 'production', '1.0.0', ?, 123, '2026-09-18T10:00:00Z', ?)
    `).run(dir, build, filePath);
}

test('different APK path keeps the old test history row', () => {
    const oldPath = join(buildsDir, 'android/dev/1.0.0.10/old-test.apk');
    const prePath = join(buildsDir, 'android/dev/1.0.0.10/new-pre.apk');
    addLegacy('10', oldPath);
    buildDatabase.migrateLegacyAndroidBuild({
        dir: 'android_dev_1.0.0_10_pre', branch: 'dev', version: '1.0.0', build: '10', filePath: prePath,
    });
    const row = db.prepare('SELECT dir, env, file_path FROM builds WHERE dir = ?').get('android_dev_1.0.0_10');
    assert.deepEqual({ dir: row.dir, env: row.env, filePath: row.file_path },
        { dir: 'android_dev_1.0.0_10', env: 'production', filePath: oldPath });
});

test('same APK path migrates its existing history row', () => {
    const prePath = join(buildsDir, 'android/dev/1.0.0.11/pre.apk');
    addLegacy('11', prePath);
    buildDatabase.migrateLegacyAndroidBuild({
        dir: 'android_dev_1.0.0_11_pre', branch: 'dev', version: '1.0.0', build: '11', filePath: prePath,
    });
    const row = db.prepare('SELECT dir, env, file_path FROM builds WHERE dir = ?').get('android_dev_1.0.0_11_pre');
    assert.deepEqual({ dir: row.dir, env: row.env, filePath: row.file_path },
        { dir: 'android_dev_1.0.0_11_pre', env: 'pre', filePath: prePath });
});
