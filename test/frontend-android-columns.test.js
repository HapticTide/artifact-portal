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
    return { portal: new context.ArtifactPortal(), rows };
}

function build(branch, day) {
    const id = `android_${branch}_${day}`;
    return {
        id, dir: id, time: `2026-09-${day}T10:00:00.000Z`,
        platforms: { android: { available: true, branch, version: '1.0.0', build: day } },
    };
}

test('desktop history retains other Android branches and dates', () => {
    const { portal, rows } = portalWithDocument();
    const history = node();
    const otherHeader = node();
    portal.els = { history, androidOtherHeader: otherHeader };
    portal.detectPlatform = () => 'other';
    portal.formatDateGroupTitle = date => date;
    portal.renderVersionItem = item => ({ buildId: item.id });
    portal.allBuilds = [build('test', '18'), build('pre', '18'), build('dev', '17')];

    portal.renderVersionLists();

    const rendered = [];
    function visit(item) {
        if (item.buildId) rendered.push(item.buildId);
        for (const child of item.children || []) visit(child);
    }
    visit(rows);
    assert.deepEqual(rendered.sort(), portal.allBuilds.map(item => item.id).sort());
    assert.equal(rows.children[0].children.length, 2); // dev-only date remains visible
    assert.equal(otherHeader.hidden, false);
    assert.equal(history.classList['has-other-android'], true);
});

test('Android device keeps test and pre latest cards adjacent before iOS', () => {
    const { portal } = portalWithDocument();
    const ios = node();
    const testCard = node();
    const preCard = node();
    const cards = [ios, testCard, preCard];
    const container = {
        insertBefore(item, before) {
            cards.splice(cards.indexOf(item), 1);
            cards.splice(cards.indexOf(before), 0, item);
        },
    };
    ios.parentElement = container;
    portal.els = { iosSection: ios, androidSection: testCard, androidPreSection: preCard };
    portal.detectPlatform = () => 'android';

    portal.reorderPlatformSections();

    assert.deepEqual(cards, [testCard, preCard, ios]);
});
