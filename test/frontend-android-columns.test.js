import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');

function node() {
    return {
        children: [], hidden: false, className: '', textContent: '', innerHTML: '',
        appendChild(child) { this.children.push(child); },
        classList: { toggle(name, enabled) { this[name] = enabled; }, add() {} },
    };
}

function portalWithDocument() {
    const rows = node();
    const document = {
        addEventListener() {},
        getElementById(id) { return id === 'version-rows' ? rows : null; },
        createElement() { return node(); },
        createDocumentFragment() { return node(); },
    };
    const context = vm.createContext({ console, document, navigator: { userAgent: '' }, window: {} });
    vm.runInContext(`${source}\nglobalThis.ArtifactPortal = ArtifactPortal;`, context);
    return { portal: new context.ArtifactPortal(), rows, context };
}

function build(branch, day, env = 'test') {
    const id = `android_${branch}_${env}_${day}`;
    return {
        id, dir: id, time: `2026-09-${day}T10:00:00.000Z`,
        platforms: { android: { available: true, branch, env, version: '1.0.0', build: day } },
    };
}

test('desktop history groups APK environments independently of branches', () => {
    const { portal, rows } = portalWithDocument();
    const history = node();
    portal.els = { history };
    portal.detectPlatform = () => 'other';
    portal.formatDateGroupTitle = date => date;
    portal.renderVersionItem = item => ({ buildId: item.id });
    portal.allBuilds = [build('pre', '18', 'test'), build('test', '18', 'pre'), build('dev', '17')];

    portal.renderVersionLists();

    const rendered = [];
    function visit(item) {
        if (item.buildId) rendered.push(item.buildId);
        for (const child of item.children || []) visit(child);
    }
    visit(rows);
    assert.deepEqual(rendered.sort(), portal.allBuilds.map(item => item.id).sort());
    assert.equal(rows.children[0].children.length, 2); // dev-only date remains visible
    const devRow = rows.children[0].children[1];
    assert.equal(devRow.children[1].children[1].children[0].buildId, 'android_dev_test_17');
    assert.equal(devRow.children[1].children.length, 3);
});

test('desktop test column shows all test environment branches while pre stays separate', () => {
    const { portal, rows } = portalWithDocument();
    portal.els = { history: node() };
    portal.detectPlatform = () => 'other';
    portal.formatDateGroupTitle = date => date;
    portal.renderVersionItem = item => ({ buildId: item.id });
    portal.allBuilds = [build('test', '18'), build('test', '18', 'pre'), build('dev', '17')];

    portal.renderVersionLists();

    const rendered = [];
    function visit(item) {
        if (item.buildId) rendered.push(item.buildId);
        for (const child of item.children || []) visit(child);
    }
    visit(rows);
    assert.deepEqual(rendered.sort(), ['android_dev_test_17', 'android_test_pre_18', 'android_test_test_18']);
});

test('mobile Android branch selector still includes every Git branch', async () => {
    const { portal, context } = portalWithDocument();
    function select() {
        return {
            options: [{ value: '' }], value: '',
            remove(index) { this.options.splice(index, 1); },
            appendChild(option) { this.options.push(option); },
        };
    }
    const mobile = select();
    portal.els = { iosBranchFilter: select(), mobileBranchFilter: mobile };
    portal.mobilePlatform = 'android';
    context.fetch = async () => ({ json: async () => ({ success: true, data: { android: ['test', 'pre', 'dev'] } }) });
    await portal.loadBranches();
    assert.deepEqual(mobile.options.map(option => option.value), ['', 'test', 'pre', 'dev']);
});

test('latest cards always appear in iOS, test, pre order', () => {
    const { portal } = portalWithDocument();
    const ios = node();
    const testCard = node();
    const preCard = node();
    const cards = [testCard, preCard, ios];
    const container = {
        appendChild(item) {
            cards.splice(cards.indexOf(item), 1);
            cards.push(item);
        },
    };
    ios.parentElement = container;
    portal.els = { iosSection: ios, androidSection: testCard, androidPreSection: preCard };
    portal.detectPlatform = () => 'android';

    portal.reorderPlatformSections();

    assert.deepEqual(cards, [ios, testCard, preCard]);
});
