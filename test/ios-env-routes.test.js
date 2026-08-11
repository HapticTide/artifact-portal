import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-portal-ios-routes-'));
process.env.BUILDS_DIR = buildsDir;

async function createBuild(relativePath, timestamp) {
    const path = join(buildsDir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, relativePath);
    const date = new Date(timestamp);
    await utimes(path, date, date);
}

await createBuild(
    'ios/dev/production/1.0.0/IMWE-1.0.0(10).ipa',
    '2026-08-11T10:00:00Z'
);
await createBuild(
    'ios/dev/pre/1.1.0/IMWE-1.1.0(11).ipa',
    '2026-08-11T11:00:00Z'
);
await createBuild(
    'ios/dev/pre/1.0.0/IMWE-1.0.0(10).ipa',
    '2026-08-11T09:00:00Z'
);
await mkdir(join(buildsDir, 'android'), { recursive: true });

const { default: routes } = await import('../src/server/routes.js');
const { default: buildDatabase } = await import('../src/server/database.js');
const app = express();
app.use(routes);
const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

after(async () => {
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    buildDatabase.close();
    await rm(buildsDir, { recursive: true, force: true });
});

test('latest API filters iOS builds by canonical env', async () => {
    const productionResponse = await fetch(`${baseUrl}/api/builds/latest?env=production`);
    const production = await productionResponse.json();
    assert.equal(productionResponse.status, 200);
    assert.equal(production.data.ios.platforms.ios.env, 'production');
    assert.equal(production.data.ios.platforms.ios.version, '1.0.0');

    const preResponse = await fetch(`${baseUrl}/api/builds/latest?env=sandbox`);
    const pre = await preResponse.json();
    assert.equal(preResponse.status, 200);
    assert.equal(pre.data.ios.platforms.ios.env, 'pre');
    assert.equal(pre.data.ios.platforms.ios.version, '1.1.0');
});

test('latest API defaults an omitted env to production and rejects unknown values', async () => {
    const defaultResponse = await fetch(`${baseUrl}/api/builds/latest`);
    const defaultPayload = await defaultResponse.json();
    assert.equal(defaultResponse.status, 200);
    assert.equal(defaultPayload.data.ios.platforms.ios.env, 'production');

    const invalidResponse = await fetch(`${baseUrl}/api/builds/latest?env=staging`);
    assert.equal(invalidResponse.status, 400);
});

test('/latest forwards env and redirects to the matching iOS identity', async () => {
    const response = await fetch(
        `${baseUrl}/latest?platform=ios&env=production`,
        { redirect: 'manual' }
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/#build=ios_dev_production_1.0.0_10');
});

test('legacy iOS build ids resolve to production across detail and install routes', async () => {
    const legacyId = 'ios_dev_1.0.0_10';

    const detailResponse = await fetch(`${baseUrl}/api/builds/${legacyId}`);
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.equal(detail.data.id, 'ios_dev_production_1.0.0_10');
    assert.equal(detail.data.platforms.ios.env, 'production');

    const manifestResponse = await fetch(`${baseUrl}/api/manifest/${legacyId}`);
    assert.equal(manifestResponse.status, 200);

    const installResponse = await fetch(`${baseUrl}/api/ios-install-url/${legacyId}`);
    const install = await installResponse.json();
    assert.equal(installResponse.status, 200);
    assert.match(install.data.manifestUrl, /ios_dev_production_1\.0\.0_10$/);
});

test('branches API reads the lowercase iOS storage directory on case-sensitive filesystems', async () => {
    const response = await fetch(`${baseUrl}/api/branches`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload.data.ios, ['dev']);
    assert.deepEqual(payload.data.all, ['dev']);
});
