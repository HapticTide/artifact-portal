import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import config from '../src/server/config.js';
import { artifactManager } from '../src/server/artifacts.js';

/**
 * 在临时构建目录下创建一个空文件用作 fixture
 */
async function createFixture(root, relativePath) {
    const filePath = join(root, relativePath);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, 'fake-apk-content');
    return filePath;
}

/**
 * 临时替换 config.buildsDir 并在测试结束后恢复
 */
function withBuildsDir(dir) {
    const original = config.buildsDir;
    config.buildsDir = dir;
    return () => { config.buildsDir = original; };
}

// --- 新结构测试 ---

test('_scanAndroidBuilds scans new version-directory structure', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'scan-android-'));
    const restore = withBuildsDir(buildsDir);

    try {
        await createFixture(
            buildsDir,
            'android/origin_dev/1.2.0.100/IMWE_v1.2.0.100_01_01_00_00_online-release.apk'
        );
        await createFixture(
            buildsDir,
            'android/origin_dev/1.3.0.200/IMWE_v1.3.0.200_02_15_10_30_online-release.apk'
        );

        artifactManager.invalidateCache();
        const builds = await artifactManager._scanAndroidBuilds();

        assert.equal(builds.length, 2);
        // 按时间倒序
        assert.equal(builds[0].version, '1.3.0');
        assert.equal(builds[0].build, '200');
        assert.equal(builds[0].branch, 'origin_dev');
        assert.equal(builds[1].version, '1.2.0');
        assert.equal(builds[1].build, '100');
    } finally {
        restore();
        await rm(buildsDir, { recursive: true, force: true });
    }
});

test('_scanAndroidBuilds finds mapping.zip alongside APK', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'scan-android-'));
    const restore = withBuildsDir(buildsDir);

    try {
        await createFixture(
            buildsDir,
            'android/main/1.0.0.50/App_v1.0.0.50_03_01_12_00_online-release.apk'
        );
        await createFixture(
            buildsDir,
            'android/main/1.0.0.50/App_v1.0.0.50_03_01_12_00_online-release.mapping.zip'
        );

        artifactManager.invalidateCache();
        const builds = await artifactManager._scanAndroidBuilds();

        assert.equal(builds.length, 1);
        assert.equal(builds[0].mappingPath, 'android/main/1.0.0.50/App_v1.0.0.50_03_01_12_00_online-release.mapping.zip');
    } finally {
        restore();
        await rm(buildsDir, { recursive: true, force: true });
    }
});

// --- 旧扁平结构迁移测试 ---

test('_scanAndroidBuilds migrates legacy flat APKs into version directories', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'scan-android-'));
    const restore = withBuildsDir(buildsDir);

    try {
        // 旧结构：APK 直接放在 branch 目录下
        await createFixture(
            buildsDir,
            'android/origin_dev/IMWE_v1.2.0.100_01_01_00_00_online-release.apk'
        );

        artifactManager.invalidateCache();
        const builds = await artifactManager._scanAndroidBuilds();

        // 扫描后应该能正常识别到该 build
        assert.equal(builds.length, 1);
        assert.equal(builds[0].version, '1.2.0');
        assert.equal(builds[0].build, '100');
        assert.equal(builds[0].branch, 'origin_dev');

        // 文件应已被迁移到版本子目录
        const migratedPath = join(
            buildsDir,
            'android/origin_dev/1.2.0.100/IMWE_v1.2.0.100_01_01_00_00_online-release.apk'
        );
        assert.equal(existsSync(migratedPath), true);

        // 原始位置不应再有该文件
        const originalPath = join(
            buildsDir,
            'android/origin_dev/IMWE_v1.2.0.100_01_01_00_00_online-release.apk'
        );
        assert.equal(existsSync(originalPath), false);
    } finally {
        restore();
        await rm(buildsDir, { recursive: true, force: true });
    }
});

test('_scanAndroidBuilds migrates legacy mapping.txt alongside flat APK', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'scan-android-'));
    const restore = withBuildsDir(buildsDir);

    try {
        // 旧 APK 在 branch 目录下
        await createFixture(
            buildsDir,
            'android/origin_dev/IMWE_v1.2.0.100_01_01_00_00_online-release.apk'
        );
        // 旧 mapping 在 mapping/ 子目录下
        await createFixture(
            buildsDir,
            'android/origin_dev/mapping/IMWE_v1.2.0.100_01_01_00_00_online-release.mapping.txt'
        );

        artifactManager.invalidateCache();
        const builds = await artifactManager._scanAndroidBuilds();

        assert.equal(builds.length, 1);

        // mapping 应被迁移为 .mapping.zip 并放在版本目录中
        const migratedMapping = join(
            buildsDir,
            'android/origin_dev/1.2.0.100/IMWE_v1.2.0.100_01_01_00_00_online-release.mapping.zip'
        );
        assert.equal(existsSync(migratedMapping), true);

        // build 应该能找到 mapping
        assert.equal(
            builds[0].mappingPath,
            'android/origin_dev/1.2.0.100/IMWE_v1.2.0.100_01_01_00_00_online-release.mapping.zip'
        );

        // 旧位置已清理
        const oldMapping = join(
            buildsDir,
            'android/origin_dev/mapping/IMWE_v1.2.0.100_01_01_00_00_online-release.mapping.txt'
        );
        assert.equal(existsSync(oldMapping), false);
    } finally {
        restore();
        await rm(buildsDir, { recursive: true, force: true });
    }
});

test('_scanAndroidBuilds skips flat APKs with unparseable filenames', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'scan-android-'));
    const restore = withBuildsDir(buildsDir);

    try {
        // 无法解析版本号的 APK 文件名
        await createFixture(
            buildsDir,
            'android/origin_dev/random-app.apk'
        );
        // 正常的新结构 APK 应该仍然能扫到
        await createFixture(
            buildsDir,
            'android/origin_dev/1.0.0.1/App_v1.0.0.1_05_01_08_00_online-release.apk'
        );

        artifactManager.invalidateCache();
        const builds = await artifactManager._scanAndroidBuilds();

        // 只扫到新结构的那个，无法解析的被跳过（不迁移也不崩溃）
        assert.equal(builds.length, 1);
        assert.equal(builds[0].version, '1.0.0');
    } finally {
        restore();
        await rm(buildsDir, { recursive: true, force: true });
    }
});

test('_scanAndroidBuilds does not overwrite existing files during migration', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'scan-android-'));
    const restore = withBuildsDir(buildsDir);

    try {
        // 版本目录已存在同名文件（模拟已经迁移过或重新上传）
        await createFixture(
            buildsDir,
            'android/origin_dev/1.2.0.100/IMWE_v1.2.0.100_01_01_00_00_online-release.apk'
        );
        // 旧位置也有一份（不应覆盖新位置的）
        const legacyPath = join(
            buildsDir,
            'android/origin_dev/IMWE_v1.2.0.100_01_01_00_00_online-release.apk'
        );
        await mkdir(join(legacyPath, '..'), { recursive: true });
        await writeFile(legacyPath, 'old-content');

        artifactManager.invalidateCache();
        const builds = await artifactManager._scanAndroidBuilds();

        assert.equal(builds.length, 1);

        // 新结构文件内容未被覆盖
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(
            join(buildsDir, 'android/origin_dev/1.2.0.100/IMWE_v1.2.0.100_01_01_00_00_online-release.apk'),
            'utf8'
        );
        assert.equal(content, 'fake-apk-content');
    } finally {
        restore();
        await rm(buildsDir, { recursive: true, force: true });
    }
});

test('_scanAndroidBuilds returns empty array when android dir does not exist', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'scan-android-'));
    const restore = withBuildsDir(buildsDir);

    try {
        // 不创建 android 目录
        artifactManager.invalidateCache();
        const builds = await artifactManager._scanAndroidBuilds();

        assert.deepEqual(builds, []);
    } finally {
        restore();
        await rm(buildsDir, { recursive: true, force: true });
    }
});

test('_scanAndroidBuilds handles multiple branches with mixed structures', async () => {
    const buildsDir = await mkdtemp(join(tmpdir(), 'scan-android-'));
    const restore = withBuildsDir(buildsDir);

    try {
        // branch1: 新结构
        await createFixture(
            buildsDir,
            'android/main/2.0.0.10/App_v2.0.0.10_06_01_09_00_online-release.apk'
        );
        // branch2: 旧扁平结构
        await createFixture(
            buildsDir,
            'android/feature_x/App_v1.5.0.7_04_20_14_00_online-release.apk'
        );

        artifactManager.invalidateCache();
        const builds = await artifactManager._scanAndroidBuilds();

        assert.equal(builds.length, 2);

        const mainBuild = builds.find(b => b.branch === 'main');
        const featureBuild = builds.find(b => b.branch === 'feature_x');

        assert.ok(mainBuild);
        assert.equal(mainBuild.version, '2.0.0');
        assert.equal(mainBuild.build, '10');

        assert.ok(featureBuild);
        assert.equal(featureBuild.version, '1.5.0');
        assert.equal(featureBuild.build, '7');

        // feature_x 的 APK 应已被迁移
        const migratedPath = join(
            buildsDir,
            'android/feature_x/1.5.0.7/App_v1.5.0.7_04_20_14_00_online-release.apk'
        );
        assert.equal(existsSync(migratedPath), true);
    } finally {
        restore();
        await rm(buildsDir, { recursive: true, force: true });
    }
});
