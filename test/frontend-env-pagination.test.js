import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');

function createElement(value = '') {
    const listeners = new Map();
    return {
        value,
        hidden: false,
        disabled: false,
        textContent: '',
        dataset: {},
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        dispatch(type) {
            listeners.get(type)?.({ preventDefault() {} });
        },
    };
}

function createPortal(fetchImpl = async () => { throw new Error('unexpected fetch'); }) {
    const document = {
        addEventListener() {},
        querySelectorAll() { return []; },
        getElementById() { return null; },
        documentElement: {
            getAttribute() { return null; },
            setAttribute() {},
        },
    };
    const window = {
        addEventListener() {},
        getSelection() { return null; },
        matchMedia() {
            return { matches: false, addEventListener() {} };
        },
        location: { hash: '', origin: 'http://127.0.0.1' },
    };
    const context = vm.createContext({
        console,
        document,
        fetch: fetchImpl,
        localStorage: { getItem() { return null; }, setItem() {} },
        navigator: { userAgent: '' },
        setTimeout,
        URLSearchParams,
        window,
    });
    vm.runInContext(`${appSource}\nglobalThis.ArtifactPortal = ArtifactPortal;`, context);
    return new context.ArtifactPortal();
}

function installRequiredEventElements(portal) {
    portal.els = {
        themeToggle: createElement(),
        iosInstallBtn: createElement(),
        iosCopyBtn: createElement(),
        androidCopyBtn: createElement(),
        iosEnvFilter: createElement(),
        mobileEnvFilter: createElement(),
    };
}

test('changing either iOS identity filter reloads history from the first page', async () => {
    for (const filterName of ['iosEnvFilter', 'mobileEnvFilter']) {
        const portal = createPortal();
        installRequiredEventElements(portal);
        const loadCalls = [];
        portal.loadBuilds = async append => loadCalls.push(append);
        portal.renderVersionLists = () => {};
        portal.refreshLatestBuild = async () => {};
        portal.bindEvents();

        portal.skipDays = 7;
        portal.els[filterName].value = 'pre';
        portal.els[filterName].dispatch('change');
        await Promise.resolve();

        assert.equal(portal.iosEnv, 'pre');
        assert.deepEqual(loadCalls, [false]);
    }
});

test('history API carries the selected iOS identity so day pagination is env-aware', async () => {
    const requestedUrls = [];
    const portal = createPortal(async url => {
        requestedUrls.push(String(url));
        if (String(url).startsWith('/api/builds/latest')) {
            return {
                ok: true,
                async json() { return { success: true, data: { ios: null, android: null } }; },
            };
        }
        return {
            ok: true,
            async json() {
                return {
                    success: true,
                    data: { builds: [], total: 0, hasMore: false, loadedDays: 0 },
                };
            },
        };
    });
    portal.els = {
        loading: createElement(),
        latestBuild: createElement(),
        history: createElement(),
        emptyState: createElement(),
        statsPanel: createElement(),
        loadMore: createElement(),
    };
    portal.iosEnv = 'pre';
    portal.renderLatestBuild = () => {};
    portal.renderHistory = () => {};
    portal.updateLatestIds = () => {};

    await portal.loadBuilds(false);

    const historyUrl = requestedUrls.find(url => url.startsWith('/api/builds?'));
    assert.ok(historyUrl);
    assert.equal(new URL(historyUrl, 'http://127.0.0.1').searchParams.get('env'), 'pre');
});
