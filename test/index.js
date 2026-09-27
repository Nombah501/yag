import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPage, fakeYaGames, recordingCallbacks, flush } from './harness.js';

// Assigns the fake API the way the SDK loader does and returns the initialized SDK.
async function initSdk(page, api, assign = 'window.YaGames = __api') {
    page.global.__api = api;
    page.eval(assign);
    return page.eval('YaGames.init()');
}

test('rewarded video: onOpen -> onRewarded -> onClose(true), original not shown', async () => {
    const page = createPage();
    page.run();
    const { api, calls } = fakeYaGames();
    const sdk = await initSdk(page, api);
    const { callbacks, events } = recordingCallbacks();

    const ret = sdk.adv.showRewardedVideo({ callbacks });
    await flush();

    assert.equal(ret, undefined);
    assert.deepEqual(events, ['onOpen', 'onRewarded', 'onClose:true']);
    assert.deepEqual(calls, []);
});

test('rewarded video: a throwing callback does not stop the rest', async () => {
    const page = createPage();
    page.run();
    const { api } = fakeYaGames();
    const sdk = await initSdk(page, api);
    const { callbacks, events } = recordingCallbacks();
    callbacks.onOpen = () => { throw new Error('boom'); };

    sdk.adv.showRewardedVideo({ callbacks });
    await flush();

    assert.deepEqual(events, ['onRewarded', 'onClose:true']);
});

test('fullscreen adv: only onClose(false), original not shown', async () => {
    const page = createPage();
    page.run();
    const { api, calls } = fakeYaGames();
    const sdk = await initSdk(page, api);
    const { callbacks, events } = recordingCallbacks();

    sdk.adv.showFullscreenAdv({ callbacks });
    await flush();

    assert.deepEqual(events, ['onClose:false']);
    assert.deepEqual(calls, []);
});

test('banner methods resolve to "not showing" without calling originals', async () => {
    const page = createPage();
    page.run();
    const { api, calls } = fakeYaGames();
    const sdk = await initSdk(page, api);

    assert.deepEqual({ ...(await sdk.adv.showBannerAdv()) }, { stickyAdvIsShowing: false, reason: 'ADV_IS_NOT_CONNECTED' });
    assert.deepEqual({ ...(await sdk.adv.getBannerAdvStatus()) }, { stickyAdvIsShowing: false, reason: 'ADV_IS_NOT_CONNECTED' });
    assert.deepEqual({ ...(await sdk.adv.hideBannerAdv()) }, { stickyAdvIsShowing: false });
    assert.deepEqual(calls, []);
});

test('stored enabled=false: every adv method reaches the original', async () => {
    const page = createPage({ store: { enabled: false } });
    page.run();
    const { api, calls } = fakeYaGames();
    const sdk = await initSdk(page, api);
    const { callbacks, events } = recordingCallbacks();

    sdk.adv.showRewardedVideo({ callbacks });
    sdk.adv.showFullscreenAdv({ callbacks });
    assert.deepEqual({ ...(await sdk.adv.showBannerAdv()) }, { stickyAdvIsShowing: true });
    await sdk.adv.getBannerAdvStatus();
    await sdk.adv.hideBannerAdv();
    await flush();

    assert.deepEqual(events, []);
    assert.deepEqual(calls, [
        'orig:showRewardedVideo', 'orig:showFullscreenAdv', 'orig:showBannerAdv',
        'orig:getBannerAdvStatus', 'orig:hideBannerAdv'
    ]);
});

for (const isolated of [false, true]) {
    test(`initial enabled=false is honored when documentElement appears late (isolated=${isolated})`, async () => {
        const page = createPage({ store: { enabled: false }, domReady: false, isolated });
        page.run();
        page.domReady();
        const { api, calls } = fakeYaGames();
        const sdk = await initSdk(page, api);

        sdk.adv.showFullscreenAdv({ callbacks: {} });

        assert.deepEqual(calls, ['orig:showFullscreenAdv']);
        assert.equal(page.document.documentElement.dataset.yagamesAdFilter, '1');
    });
}

test('isolated world: hook is injected into the page world and follows menu toggles', async () => {
    const page = createPage({ isolated: true });
    page.run();
    const { api, calls } = fakeYaGames();
    const sdk = await initSdk(page, api);

    sdk.adv.showFullscreenAdv({ callbacks: {} });
    page.clickMenu('Ad suppression');
    sdk.adv.showFullscreenAdv({ callbacks: {} });

    assert.deepEqual(calls, ['orig:showFullscreenAdv']);
});

test('CSP blocks the inline <script>: hook still installed via direct call', async () => {
    const page = createPage({ inlineScripts: false });
    page.run();
    const { api, calls } = fakeYaGames();
    const sdk = await initSdk(page, api);
    const { callbacks, events } = recordingCallbacks();

    sdk.adv.showFullscreenAdv({ callbacks });
    await flush();

    assert.deepEqual(events, ['onClose:false']);
    assert.deepEqual(calls, []);
    assert.ok(page.logs.some((l) => l.level === 'warn' && /CSP/.test(l.text)));
});

test('YaGames redefined via Object.defineProperty is still patched', async () => {
    const page = createPage();
    page.run();
    const { api, calls } = fakeYaGames();
    page.global.__api = api;
    page.eval("Object.defineProperty(window, 'YaGames', { value: __api, configurable: true, writable: true })");
    page.clock.tick(100);
    const sdk = await page.eval('YaGames.init()');

    sdk.adv.showFullscreenAdv({ callbacks: {} });

    assert.deepEqual(calls, []);
});

test('YaGames assigned before init exists is patched once init is added', async () => {
    const page = createPage();
    page.run();
    const { api, calls } = fakeYaGames();
    page.eval('window.YaGames = {}');
    page.global.__init = api.init;
    page.eval('YaGames.init = __init');
    page.clock.tick(100);
    const sdk = await page.eval('YaGames.init()');

    sdk.adv.showFullscreenAdv({ callbacks: {} });

    assert.deepEqual(calls, []);
});

test('menu shows state and toggling disables suppression at runtime', async () => {
    const page = createPage();
    page.run();
    const { api, calls } = fakeYaGames();
    const sdk = await initSdk(page, api);

    assert.ok(page.menuLabels().some((l) => l.startsWith('✅')));
    page.clickMenu('Ad suppression');
    assert.ok(page.menuLabels().some((l) => l.startsWith('⛔')));
    assert.equal(page.menuLabels().length, 2);
    assert.equal(page.document.getElementById('yagames-ad-filter-style'), null);

    sdk.adv.showFullscreenAdv({ callbacks: {} });
    assert.deepEqual(calls, ['orig:showFullscreenAdv']);
});

test('debug log is off by default and toggled from the menu', async () => {
    const page = createPage();
    page.run();
    const { api } = fakeYaGames();
    const sdk = await initSdk(page, api);
    sdk.adv.showFullscreenAdv({ callbacks: {} });
    assert.deepEqual(page.logs.filter((l) => l.level === 'log'), []);

    page.clickMenu('Debug log');
    assert.ok(page.menuLabels().some((l) => l.includes('Debug log: ON')));
    sdk.adv.showFullscreenAdv({ callbacks: {} });
    assert.ok(page.logs.some((l) => l.level === 'log' && l.text.includes('showFullscreenAdv intercepted')));
});
