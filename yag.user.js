// ==UserScript==
// @name         Yandex Games — Ad Suppression
// @namespace    local.yandex.games
// @version      1.4.0
// @description  Suppress Yandex Games advertising surfaces
// @match        https://yandex.ru/games*
// @match        https://yandex.com/games*
// @match        https://yandex.kz/games*
// @match        https://yandex.by/games*
// @match        https://yandex.uz/games*
// @match        https://yandex.com.tr/games*
// @match        https://playhop.com/*
// @match        https://*.games.s3.yandex.net/*
// @match        https://games-storage.yandex.net/*
// @match        https://*.cdn.games.yandex.net/*
// @match        https://cdn.games.yandex.net/*
// @match        https://games-storage-awst.yandex.net/*
// @run-at       document-start
// @sandbox      raw
// @inject-into  page
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @updateURL    https://raw.githubusercontent.com/Nombah501/yag/main/yag.user.js
// @downloadURL  https://raw.githubusercontent.com/Nombah501/yag/main/yag.user.js
// ==/UserScript==

(function () {
    'use strict';

    var LOG_PREFIX = '[yagames-ad-filter]';
    var ENABLED_KEY = 'enabled';
    var DEBUG_KEY = 'debug';
    var STYLE_ID = 'yagames-ad-filter-style';
    var STATE_EVENT = 'yagames-ad-filter:state';

    var CSS_SELECTORS = [
        '#yandex-adv-sticky-banner-desktop',
        '[id*="yandex-adv-sticky-banner"]',
        '#AdBanner',
        '#AdFox_banner',
        '#yandex_ad',
        '.yandex-sticky-adv-banner',
        '[class*="adv-sticky-banner-manager"]',
        '[class*="sticky-banner-container"]',
        '.play-yandex-rewarded_video',
        '.play-modal_fullscreen'
    ];
    var CSS_TEXT = CSS_SELECTORS.map(function (sel) {
        return sel + ' { display: none !important; pointer-events: none !important; }';
    }).join('\n');

    // ====================================================================
    // PAGE-WORLD HOOK — injected as an inline <script> so it runs in the
    // page's own JavaScript world regardless of the sandbox mode. When CSP
    // blocks the inline script, it is called directly in the userscript
    // world instead (effective under `@sandbox raw` / `@inject-into page`).
    // Idempotent via a window flag; reports installation through the
    // DOM marker `data-yagames-ad-filter`, which is visible to every world.
    // ====================================================================

    function pageHook(initialEnabled, initialDebug) {
        var ROOT_MARKER = 'yagamesAdFilter';

        function markInstalled() {
            try {
                var root = document.documentElement;
                if (root) root.dataset[ROOT_MARKER] = '1';
            } catch (e) { /* marker is best-effort */ }
        }

        if (window.__yagamesAdFilterInstalled) { markInstalled(); return; }
        window.__yagamesAdFilterInstalled = true;
        markInstalled();

        var LOG_PREFIX = '[yagames-ad-filter]';
        var SDK_MARKER = Symbol.for('yagames-ad-filter.sdk');
        var API_MARKER = Symbol.for('yagames-ad-filter.api');
        var POLL_INTERVAL_MS = 50;
        var POLL_TIMEOUT_MS = 30000;
        var IS_HOST = window.top === window;
        var BLOCKED_ACTIONS = ['adv-show-fullscreen', 'adv-show-rewarded-video'];
        var BANNER_OFF = { stickyAdvIsShowing: false, reason: 'ADV_IS_NOT_CONNECTED' };
        var enabled = initialEnabled !== false;
        var debug = initialDebug === true;

        function log(message) {
            if (!debug) return;
            try { console.log(LOG_PREFIX, message); } catch (e) { /* silent */ }
        }

        function warn(message) {
            try { console.warn(LOG_PREFIX, message); } catch (e) { /* silent */ }
        }

        window.addEventListener('yagames-ad-filter:state', function (ev) {
            try {
                var detail = ev && ev.detail;
                // Userscript worlds send JSON strings: objects created in an
                // isolated world are unreadable from the page world (Xray).
                if (typeof detail === 'string') detail = JSON.parse(detail);
                if (!detail) return;
                if (typeof detail.debug === 'boolean') debug = detail.debug;
                if (typeof detail.enabled === 'boolean' && detail.enabled !== enabled) {
                    enabled = detail.enabled;
                    log('state -> ' + (enabled ? 'enabled' : 'disabled'));
                }
            } catch (e) { /* ignore */ }
        });

        // Runs fn(arg) on a microtask; a throwing callback never affects the others.
        function callLater(fn, arg) {
            if (typeof fn !== 'function') return;
            Promise.resolve().then(function () {
                try { fn(arg); } catch (e) { log('callback threw: ' + e); }
            });
        }

        function readCallbacks(options) {
            try {
                if (options && typeof options === 'object' &&
                    options.callbacks && typeof options.callbacks === 'object') {
                    return options.callbacks;
                }
            } catch (e) { /* malformed options treated as empty callbacks */ }
            return {};
        }

        // --- adv stubs --------------------------------------------------------
        // Each stub replaces one sdk.adv method while suppression is enabled.

        var ADV_STUBS = {
            showRewardedVideo: function (cb) {
                callLater(cb.onOpen);
                callLater(cb.onRewarded);
                callLater(cb.onClose, true);
            },
            showFullscreenAdv: function (cb) {
                callLater(cb.onClose, false);
            },
            showBannerAdv: function () { return Promise.resolve(BANNER_OFF); },
            getBannerAdvStatus: function () { return Promise.resolve(BANNER_OFF); },
            hideBannerAdv: function () { return Promise.resolve({ stickyAdvIsShowing: false }); }
        };

        function makeWrapper(name, original, stub) {
            return function () {
                if (!enabled) return Reflect.apply(original, this, arguments);
                log(name + ' intercepted @ ' + location.href);
                return stub(readCallbacks(arguments[0]));
            };
        }

        function wrapAdvMethod(adv, name) {
            try {
                var desc = null;
                try { desc = Object.getOwnPropertyDescriptor(adv, name); } catch (e) { /* probe failed */ }
                if (desc && !desc.configurable && !desc.writable) {
                    warn('cannot hook adv.' + name + ': property locked');
                    return;
                }
                var original = typeof adv[name] === 'function' ? adv[name] : null;
                if (!original) { log('adv.' + name + ' is not a function; skipping'); return; }
                var wrapper = makeWrapper(name, original, ADV_STUBS[name]);
                try {
                    Object.defineProperty(adv, name, { value: wrapper, writable: true, configurable: true });
                } catch (e) {
                    try { adv[name] = wrapper; } catch (e2) {
                        warn('cannot hook adv.' + name + ': assignment rejected');
                        return;
                    }
                }
                log('hooked adv.' + name);
            } catch (e) {
                warn('hook adv.' + name + ' failed: ' + e);
            }
        }

        // --- SDK patching -----------------------------------------------------

        function patchSdk(sdk) {
            try {
                if (!sdk || (typeof sdk !== 'object' && typeof sdk !== 'function')) {
                    log('init resolved to non-object; nothing to patch');
                    return;
                }
                if (sdk[SDK_MARKER]) return;
                var adv = sdk.adv;
                if (!adv || typeof adv !== 'object') {
                    log('sdk.adv missing; no adv surface patched');
                } else {
                    Object.keys(ADV_STUBS).forEach(function (name) { wrapAdvMethod(adv, name); });
                }
                try {
                    Object.defineProperty(sdk, SDK_MARKER, { value: true, enumerable: false, configurable: false });
                } catch (e) { /* marker is best-effort */ }
                log('sdk processed @ ' + location.href + (IS_HOST ? ' (host)' : ' (iframe)'));
            } catch (e) {
                warn('patchSdk failed: ' + e);
            }
        }

        // Returns true once `api` is patched (now or earlier); false means
        // "retry later" — e.g. YaGames was assigned before its init existed.
        function patchApi(api) {
            try {
                if (!api || (typeof api !== 'object' && typeof api !== 'function')) return false;
                if (api[API_MARKER]) return true;
                if (typeof api.init !== 'function') return false;
                var origInit = api.init;
                var wrappedInit = function init() {
                    var result = Reflect.apply(origInit, this, arguments);
                    try {
                        if (result && typeof result.then === 'function') {
                            return Promise.resolve(result).then(function (sdk) {
                                patchSdk(sdk);
                                return sdk;
                            });
                        }
                        patchSdk(result);
                    } catch (e) {
                        warn('post-init patching failed: ' + e);
                    }
                    return result;
                };
                try {
                    Object.defineProperty(api, 'init', { value: wrappedInit, writable: true, configurable: true });
                } catch (e) {
                    try { api.init = wrappedInit; } catch (e2) {
                        warn('cannot wrap YaGames.init; adv callbacks uncovered');
                        return true;
                    }
                }
                try {
                    Object.defineProperty(api, API_MARKER, { value: true, enumerable: false, configurable: false });
                } catch (e) { /* marker is best-effort */ }
                log('YaGames.init wrapped @ ' + location.href + (IS_HOST ? ' (host)' : ' (iframe)'));
                return true;
            } catch (e) {
                warn('patchApi failed: ' + e);
                return true;
            }
        }

        // --- YaGames hook -------------------------------------------------------
        // The accessor catches plain assignment instantly. The poll runs for the
        // full timeout regardless, because the SDK may replace the accessor with
        // Object.defineProperty or add `init` after assigning the object.

        function installYaGamesAccessor() {
            var desc = null;
            try { desc = Object.getOwnPropertyDescriptor(window, 'YaGames'); } catch (e) { /* probe failed */ }
            if (desc && !desc.configurable) return;
            var captured;
            try { captured = desc ? (desc.get ? desc.get.call(window) : desc.value) : undefined; } catch (e) { /* keep undefined */ }
            try {
                Object.defineProperty(window, 'YaGames', {
                    configurable: true,
                    get: function () { return captured; },
                    set: function (value) {
                        captured = value;
                        if (value) patchApi(value);
                    }
                });
                log('YaGames setter installed @ ' + location.href);
            } catch (e) {
                warn('cannot install YaGames setter: ' + e);
            }
        }

        function pollYaGames() {
            var deadline = Date.now() + POLL_TIMEOUT_MS;
            var seenPatched = false;
            var timer = setInterval(function () {
                try {
                    var api = window.YaGames;
                    if (api) seenPatched = patchApi(api) || seenPatched;
                } catch (e) { /* retry next tick */ }
                if (Date.now() >= deadline) {
                    clearInterval(timer);
                    if (!seenPatched) log('YaGames not patched within ' + POLL_TIMEOUT_MS + 'ms');
                }
            }, POLL_INTERVAL_MS);
        }

        function hookYaGames() {
            installYaGamesAccessor();
            try { if (window.YaGames) patchApi(window.YaGames); } catch (e) { /* poll retries */ }
            pollYaGames();
        }

        // --- host-only message shield -------------------------------------------
        // Second layer: the game SDK requests ads from the host page via
        // window.postMessage({ type: 'adv-manager', action: 'adv-show-*' }).
        // If the in-iframe hook was bypassed, drop these messages here so the
        // host never renders fullscreen/rewarded surfaces. The SDK falls into
        // its own error path and resumes the game with onClose(false).

        function installMessageShield() {
            window.addEventListener('message', function (ev) {
                if (!enabled) return;
                try {
                    var data = ev.data;
                    if (data && data.type === 'adv-manager' &&
                        typeof data.action === 'string' &&
                        BLOCKED_ACTIONS.indexOf(data.action) !== -1) {
                        ev.stopImmediatePropagation();
                        log('blocked external ' + data.action);
                    }
                } catch (e) { /* ignore */ }
            }, true);
        }

        if (IS_HOST) installMessageShield();
        hookYaGames();
        log('page-world hook active @ ' + location.href + (IS_HOST ? ' (host)' : ' (iframe)'));
    }

    // ====================================================================
    // USERSCRIPT CONTEXT — GM storage, menu, host CSS, state sync
    // ====================================================================

    var IS_TOP = window.top === window;
    var menuIds = [];

    function readFlag(key, fallback) {
        try {
            var value = GM_getValue(key);
            return value === undefined ? fallback : !!value;
        } catch (e) {
            return fallback;
        }
    }

    function isEnabled() { return readFlag(ENABLED_KEY, true); }
    function isDebug() { return readFlag(DEBUG_KEY, false); }

    function writeFlag(key, value) {
        try { GM_setValue(key, !!value); } catch (e) { /* silent */ }
    }

    function logDebug(message) {
        if (!isDebug()) return;
        try { console.log(LOG_PREFIX, message); } catch (e) { /* silent */ }
    }

    function logWarn(message) {
        try { console.warn(LOG_PREFIX, message); } catch (e) { /* silent */ }
    }

    function pushState() {
        try {
            var detail = JSON.stringify({ enabled: isEnabled(), debug: isDebug() });
            window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: detail }));
        } catch (e) { /* silent */ }
    }

    function onDomAvailable(fn) {
        if (document.readyState === 'loading') {
            try {
                document.addEventListener('DOMContentLoaded', fn, { once: true });
            } catch (e) {
                setTimeout(fn, 0);
            }
        } else {
            setTimeout(fn, 0);
        }
    }

    // --- page-world hook installation -----------------------------------------

    function hookMarked() {
        var root = document.documentElement;
        return !!(root && root.dataset.yagamesAdFilter === '1');
    }

    function runHookHere() {
        try { pageHook(isEnabled(), isDebug()); } catch (e) { logWarn('direct hook failed: ' + e); }
    }

    function installPageHook() {
        var root = document.documentElement;
        if (!root) {
            // No DOM yet: run in this world now (effective when it is the page
            // world) and inject into the page world once the DOM exists.
            runHookHere();
            onDomAvailable(installPageHook);
            return;
        }
        if (hookMarked()) return;
        try {
            var script = document.createElement('script');
            script.textContent = '(' + pageHook.toString() + ')(' +
                JSON.stringify(isEnabled()) + ',' + JSON.stringify(isDebug()) + ');';
            root.appendChild(script);
            if (script.parentNode) script.parentNode.removeChild(script);
        } catch (e) {
            logWarn('inline <script> injection threw: ' + e);
        }
        if (hookMarked()) { logDebug('page-world hook injected'); return; }
        logWarn('inline <script> did not run (CSP?); running hook in userscript world');
        runHookHere();
    }

    // --- host context: CSS fallback + menu ----------------------------------

    function removeHostStyle() {
        try {
            var existing = document.getElementById(STYLE_ID);
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        } catch (e) { /* silent */ }
    }

    function installHostStyle() {
        if (!isEnabled()) return;
        try {
            if (document.getElementById(STYLE_ID)) return;
            if (!document.documentElement) { onDomAvailable(installHostStyle); return; }
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS_TEXT;
            document.documentElement.appendChild(style);
            logDebug('host CSS fallback installed');
        } catch (e) {
            logWarn('host CSS install failed: ' + e);
        }
    }

    function renderMenu() {
        try {
            if (typeof GM_registerMenuCommand !== 'function') return;
            if (typeof GM_unregisterMenuCommand === 'function') {
                menuIds.forEach(function (id) {
                    try { GM_unregisterMenuCommand(id); } catch (e) { /* stale id */ }
                });
                menuIds = [];
            } else if (menuIds.length) {
                return; // cannot relabel without unregister; keep the first registration
            }
            var enabled = isEnabled();
            var debug = isDebug();
            menuIds.push(GM_registerMenuCommand(
                (enabled ? '✅ Ad suppression: ON' : '⛔ Ad suppression: OFF') + ' (click to toggle)',
                function () { writeFlag(ENABLED_KEY, !isEnabled()); applyState(); }
            ));
            menuIds.push(GM_registerMenuCommand(
                (debug ? '🐞 Debug log: ON' : '🐞 Debug log: OFF') + ' (click to toggle)',
                function () { writeFlag(DEBUG_KEY, !isDebug()); applyState(); }
            ));
        } catch (e) {
            logWarn('menu registration failed: ' + e);
        }
    }

    // Idempotent: re-applies stored state to CSS, page hook, and menu.
    function applyState() {
        if (IS_TOP) {
            if (isEnabled()) installHostStyle(); else removeHostStyle();
            renderMenu();
        }
        pushState();
        logDebug('suppression ' + (isEnabled() ? 'enabled' : 'disabled'));
    }

    function watchStorage() {
        try {
            if (typeof GM_addValueChangeListener !== 'function') return;
            GM_addValueChangeListener(ENABLED_KEY, applyState);
            GM_addValueChangeListener(DEBUG_KEY, applyState);
        } catch (e) { /* silent */ }
    }

    // --- bootstrap ----------------------------------------------------------

    installPageHook();
    applyState();
    watchStorage();
})();
