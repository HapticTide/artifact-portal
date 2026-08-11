import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-portal-ios-scan-'));
process.env.BUILDS_DIR = buildsDir;

const { default: artifactManager } = await import('../src/server/artifacts.js');
const { default: buildDatabase } = await import('../src/server/database.js');

after(async () => {
    buildDatabase.close();
    await rm(buildsDir, { recursive: true, force: true });
});

async function createIpa(relativePath, bundleId) {
    const ipaPath = join(buildsDir, relativePath);
    const stagingDir = await mkdtemp(join(tmpdir(), 'artifact-portal-ipa-'));
    const appDir = join(stagingDir, 'Payload', 'IMWE.app');
    await mkdir(appDir, { recursive: true });
    await mkdir(dirname(ipaPath), { recursive: true });
    await writeFile(join(appDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleDisplayName</key><string>IMWE Pre</string>
</dict></plist>`);

    const result = spawnSync('zip', ['-qr', ipaPath, 'Payload'], {
        cwd: stagingDir,
        encoding: 'utf8',
    });
    await rm(stagingDir, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('legacy two-level layout infers pre identity from IPA bundle id', async () => {
    await createIpa(
        'ios/legacy/1.0.0/IMWE-1.0.0(1).ipa',
        'com.imwe.app.pre'
    );

    const builds = await artifactManager._scanIosBuilds();
    const legacy = builds.find(build => build.branch === 'legacy');

    assert.ok(legacy);
    assert.equal(legacy.env, 'pre');
    assert.equal(legacy.id, 'ios_legacy_pre_1.0.0_1');
});

test('canonical pre directory wins when pre and legacy sandbox contain the same build', async () => {
    const prePath = join(buildsDir, 'ios/dev/pre/1.1.0/IMWE-1.1.0(2).ipa');
    const sandboxPath = join(buildsDir, 'ios/dev/sandbox/1.1.0/IMWE-1.1.0(2).ipa');
    await mkdir(dirname(prePath), { recursive: true });
    await mkdir(dirname(sandboxPath), { recursive: true });
    await writeFile(prePath, 'canonical pre');
    await writeFile(sandboxPath, 'legacy sandbox');

    const builds = await artifactManager._scanIosBuilds();
    const matching = builds.filter(build =>
        build.branch === 'dev' && build.version === '1.1.0' && build.build === '2'
    );

    assert.equal(matching.length, 1);
    assert.equal(matching[0].env, 'pre');
    assert.equal(matching[0].relativePath, 'ios/dev/pre/1.1.0/IMWE-1.1.0(2).ipa');
});
