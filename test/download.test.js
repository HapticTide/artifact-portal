import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

const buildsDir = await mkdtemp(join(tmpdir(), 'artifact-portal-download-'));
process.env.BUILDS_DIR = buildsDir;
const { default: routes } = await import('../src/server/routes.js');

after(async () => {
    await rm(buildsDir, { recursive: true, force: true });
});

async function createTestArtifact() {
    const artifactDir = join(buildsDir, 'ios', 'dev', '1.2.0');
    const artifactPath = join(artifactDir, 'IMWE-1.2.0(632).ipa');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(artifactPath, Buffer.from('0123456789abcdef'));
}

async function listen(app) {
    return await new Promise((resolve) => {
        const instance = app.listen(0, () => resolve(instance));
    });
}

async function close(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

test('download endpoint returns partial content for range requests', async () => {
    await createTestArtifact();

    const app = express();
    app.use(routes);

    const server = await listen(app);

    try {
        const { port } = server.address();
        const response = await fetch(
            `http://127.0.0.1:${port}/download/ios/dev/1.2.0/IMWE-1.2.0(632).ipa`,
            {
                headers: {
                    Range: 'bytes=0-3',
                },
            }
        );

        assert.equal(response.status, 206);
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('content-range'), 'bytes 0-3/16');
        assert.equal(response.headers.get('content-length'), '4');
        assert.equal(await response.text(), '0123');
    } finally {
        await close(server);
    }
});

test('download endpoint rejects malformed range requests', async () => {
    await createTestArtifact();

    const app = express();
    app.use(routes);

    const server = await listen(app);

    try {
        const { port } = server.address();
        const response = await fetch(
            `http://127.0.0.1:${port}/download/ios/dev/1.2.0/IMWE-1.2.0(632).ipa`,
            {
                headers: {
                    Range: 'bytes=-',
                },
            }
        );

        assert.equal(response.status, 416);
        assert.equal(response.headers.get('content-range'), 'bytes */16');
    } finally {
        await close(server);
    }
});
