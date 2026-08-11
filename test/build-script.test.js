import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function killIfRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // 进程已退出。
    }
}

test('build.sh restart starts a new service after stopping a stubborn old process', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'artifact-portal-build-script-'));
    const fakeBin = join(projectDir, 'bin');
    const pidFile = join(projectDir, '.server.pid');
    const oldPid = 4242;
    let servicePid;

    try {
        await mkdir(fakeBin, { recursive: true });
        await copyFile(new URL('../build.sh', import.meta.url), join(projectDir, 'build.sh'));
        await writeFile(join(projectDir, '.env'), 'PORT=18088\n');
        await writeFile(join(fakeBin, 'node'), `#!/bin/bash
if [ "\${1:-}" = "-v" ]; then
    echo "v20.20.2"
    exit 0
fi
exec /bin/sleep 30
`);
        await writeFile(join(fakeBin, 'sleep'), '#!/bin/bash\nexec /bin/sleep 0.01\n');
        await writeFile(join(fakeBin, 'ps'), `#!/bin/bash
if [ "\${1:-}" = "-p" ]; then
    exit 0
fi
exec /bin/ps "$@"
`);
        await chmod(join(fakeBin, 'node'), 0o755);
        await chmod(join(fakeBin, 'sleep'), 0o755);
        await chmod(join(fakeBin, 'ps'), 0o755);
        await writeFile(pidFile, String(oldPid));

        const result = spawnSync('/bin/bash', ['build.sh', 'restart'], {
            cwd: projectDir,
            env: {
                ...process.env,
                NVM_DIR: join(projectDir, 'missing-nvm'),
                PATH: `${fakeBin}:${process.env.PATH}`,
            },
            encoding: 'utf8',
            timeout: 5_000,
        });

        servicePid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /服务已启动/);
        assert.notEqual(servicePid, oldPid);
    } finally {
        killIfRunning(servicePid);
        await rm(projectDir, { recursive: true, force: true });
    }
});
