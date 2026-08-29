// ==UserScript==
// @name         Yandex Games — Ad Suppression
// @namespace    local.yandex.games
// @version      1.3.3
// @description  Suppress Yandex Games advertising surfaces
// @match        https://yandex.ru/games/*
// @match        https://*.games.s3.yandex.net/*
// @match        https://games-storage.yandex.net/*
// @match        https://*.cdn.games.yandex.net/*
// @match        https://cdn.games.yandex.net/*
// @match        https://games-storage-awst.yandex.net/*
// @run-at       document-start
// @sandbox      raw
// @grant        GM_getValue
// @grant        GM_setValue
// @updateURL    https://raw.githubusercontent.com/Nombah501/yag/main/yag.user.js
// @downloadURL  https://raw.githubusercontent.com/Nombah501/yag/main/yag.user.js
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    var LOG_PREFIX = '[yagames-ad-filter]';
    var ENABLED_KEY = 'enabled';
    var MENU_TITLE = 'Yandex Games: toggle ad suppression';
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
    // page's own JavaScript world regardless of the Tampermonkey sandbox
    // mode (raw or isolated). Idempotent via a window flag.
    // ====================================================================

    function pageHook() {
        if (window.__yagamesAdFilterInstalled) return;
        window.__yagamesAdFilterInstalled = true;

        var LOG_PREFIX = '[yagames-ad-filter]';
        var SDK_MARKER = Symbol.for('yagames-ad-filter.sdk');
        var API_MARKER = Symbol.for('yagames-ad-filter.api');
        var POLL_INTERVAL_MS = 50;
        var POLL_TIMEOUT_MS = 30000;
        var IS_HOST = window.top === window;
        var BLOCKED_ACTIONS = ['adv-show-fullscreen', 'adv-show-rewarded-video'];
        var enabled = true;

        window.addEventListener('yagames-ad-filter:state', function (ev) {
            try {
                var detail = ev && ev.detail;
                if (detail && typeof detail.enabled === 'boolean') {
                    enabled = detail.enabled;
                    log('state -> ' + (enabled ? 'enabled' : 'disabled'));
                }
            } catch (e) { /* ignore */ }
        });

        function log(message) {
            try { console.log(LOG_PREFIX, message); } catch (e) { /* silent */ }
        }

        function warn(message) {
            try { console.warn(LOG_PREFIX, message); } catch (e) { /* silent */ }
        }

        function schedule(fn) {
            try {
                if (typeof queueMicrotask === 'function') queueMicrotask(fn);
                else Promise.resolve().then(fn);
            } catch (e) { log('scheduling failed: ' + e); }
        }

        function safeCall(fn) {
            if (typeof fn !== 'function') return;
            schedule(function () {
                try { fn(); } catch (e) { log('callback threw: ' + e); }
            });
        }

        // --- adv wrappers ---------------------------------------------------

        function makeRewardedWrapper(original) {
            return function showRewardedVideo(options) {
                if (!enabled) return Reflect.apply(original, this, arguments);
                log('showRewardedVideo intercepted @ ' + location.href);
                var callbacks = {};
                try {
                    if (options && typeof options === 'object' &&
                        options.callbacks && typeof options.callbacks === 'object') {
                        callbacks = options.callbacks;
                    }
                } catch (e) { /* malformed options treated as empty callbacks */ }
                safeCall(callbacks.onOpen);
                safeCall(callbacks.onRewarded);
                safeCall(function () { callbacks.onClose(true); });
                return undefined;
            };
        }

        function makeFullscreenWrapper(original) {
            return function showFullscreenAdv(options) {
                if (!enabled) return Reflect.apply(original, this, arguments);
                log('showFullscreenAdv intercepted @ ' + location.href);
                var callbacks = {};
                try {
                    if (options && typeof options === 'object' &&
                        options.callbacks && typeof options.callbacks === 'object') {
                        callbacks = options.callbacks;
                    }
                } catch (e) { /* malformed options treated as empty callbacks */ }
                var onClose = callbacks.onClose;
                schedule(function () {
                    if (typeof onClose !== 'function') return;
                    try { onClose(false); } catch (e) { log('onClose threw: ' + e); }
                });
                return undefined;
            };
        }

        function makeShowBannerWrapper(original) {
            return function showBannerAdv() {
                if (!enabled) return Reflect.apply(original, this, arguments);
                log('showBannerAdv intercepted @ ' + location.href);
                return Promise.resolve({ stickyAdvIsShowing: false, reason: 'ADV_IS_NOT_CONNECTED' });
            };
        }

        function makeGetBannerStatusWrapper(original) {
            return function getBannerAdvStatus() {
                if (!enabled) return Reflect.apply(original, this, arguments);
                log('getBannerAdvStatus intercepted @ ' + location.href);
                return Promise.resolve({ stickyAdvIsShowing: false, reason: 'ADV_IS_NOT_CONNECTED' });
            };
        }

        function makeHideBannerWrapper(original) {
            return function hideBannerAdv() {
                if (!enabled) return Reflect.apply(original, this, arguments);
                log('hideBannerAdv intercepted @ ' + location.href);
                return Promise.resolve({ stickyAdvIsShowing: false });
            };
        }

        function wrapAdvMethod(adv, name, makeWrapper) {
            try {
                var desc = null;
                try { desc = Object.getOwnPropertyDescriptor(adv, name); } catch (e) { /* probe failed */ }
                if (desc && !desc.configurable && !desc.writable) {
                    warn('cannot hook adv.' + name + ': property locked');
                    return;
                }
                var original = typeof adv[name] === 'function' ? adv[name] : null;
                if (!original) { warn('adv.' + name + ' is not a function; skipping'); return; }
                var wrapper = makeWrapper(original);
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
                    wrapAdvMethod(adv, 'showRewardedVideo', makeRewardedWrapper);
                    wrapAdvMethod(adv, 'showFullscreenAdv', makeFullscreenWrapper);
                    wrapAdvMethod(adv, 'showBannerAdv', makeShowBannerWrapper);
                    wrapAdvMethod(adv, 'getBannerAdvStatus', makeGetBannerStatusWrapper);
                    wrapAdvMethod(adv, 'hideBannerAdv', makeHideBannerWrapper);
                }
                try {
                    Object.defineProperty(sdk, SDK_MARKER, { value: true, enumerable: false, configurable: false });
                } catch (e) { /* marker is best-effort */ }
                log('sdk processed @ ' + location.href + (IS_HOST ? ' (host)' : ' (iframe)'));
            } catch (e) {
                warn('patchSdk failed: ' + e);
            }
        }

        function patchApi(api) {
            try {
                if (!api || (typeof api !== 'object' && typeof api !== 'function')) return;
                if (api[API_MARKER]) return;
                if (typeof api.init !== 'function') {
                    log('YaGames.init not present at assignment time');
                    return;
                }
                var origInit = api.init;
                var wrappedInit = function init() {
                    var self = this;
                    var args = arguments;
                    var result;
                    try {
                        result = Reflect.apply(origInit, self, args);
                    } catch (e) {
                        warn('original YaGames.init threw: ' + e);
                        throw e;
                    }
                    try {
                        if (result && typeof result.then === 'function') {
                            return Promise.resolve(result).then(function (sdk) {
                                patchSdk(sdk);
                                return sdk;
                            }, function (err) {
                                log('YaGames.init rejected; passing rejection through');
                                throw err;
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
                        return;
                    }
                }
                try {
                    Object.defineProperty(api, API_MARKER, { value: true, enumerable: false, configurable: false });
                } catch (e) { /* marker is best-effort */ }
                log('YaGames.init wrapped @ ' + location.href + (IS_HOST ? ' (host)' : ' (iframe)'));
            } catch (e) {
                warn('patchApi failed: ' + e);
            }
        }

        // --- YaGames hook -------------------------------------------------------

        function defineYaGamesGetterSetter(initialValue) {
            var captured = initialValue;
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
                pollYaGames();
            }
        }

        function pollYaGames() {
            var deadline = Date.now() + POLL_TIMEOUT_MS;
            var timer = setInterval(function () {
                try {
                    var api = window.YaGames;
                    if (api) { clearInterval(timer); patchApi(api); return; }
                    if (Date.now() >= deadline) {
                        clearInterval(timer);
                        warn('YaGames not observed within 30s');
                    }
                } catch (e) {
                    clearInterval(timer);
                    warn('YaGames polling aborted: ' + e);
                }
            }, POLL_INTERVAL_MS);
        }

        function hookYaGames() {
            var desc = null;
            try { desc = Object.getOwnPropertyDescriptor(window, 'YaGames'); } catch (e) { /* probe failed */ }
            if (!desc) { defineYaGamesGetterSetter(undefined); return; }
            if (desc.configurable) {
                var current = null;
                try { current = desc.get ? desc.get.call(window) : desc.value; } catch (e) { /* keep null */ }
                defineYaGamesGetterSetter(current);
                return;
            }
            if (window.YaGames) patchApi(window.YaGames);
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

    function logDebug(message) {
        try { console.log(LOG_PREFIX, message); } catch (e) { /* silent */ }
    }

    function logWarn(message) {
        try { console.warn(LOG_PREFIX, message); } catch (e) { /* silent */ }
    }

    function isEnabled() {
        try {
            var value = GM_getValue(ENABLED_KEY);
            return value === undefined ? true : !!value;
        } catch (e) {
            return true;
        }
    }

    function setEnabled(value) {
        try { GM_setValue(ENABLED_KEY, !!value); } catch (e) { /* silent */ }
    }

    function pushEnabled() {
        try {
            window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: { enabled: isEnabled() } }));
        } catch (e) { /* silent */ }
    }

    function injectPageHook() {
        try {
            if (document.documentElement && document.documentElement.dataset.yagamesAdFilter === '1') return;
            if (!document.documentElement) { onDomAvailable(injectPageHook); return; }
            var script = document.createElement('script');
            script.textContent = '(' + pageHook.toString() + ')();';
            document.documentElement.appendChild(script);
            document.documentElement.dataset.yagamesAdFilter = '1';
            logDebug('page-world hook injected');
        } catch (e) {
            logWarn('page-world injection failed: ' + e);
        }
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

    function registerMenu() {
        try {
            if (typeof GM_registerMenuCommand !== 'function') return;
            GM_registerMenuCommand(MENU_TITLE, function () {
                var next = !isEnabled();
                setEnabled(next);
                if (next) installHostStyle(); else removeHostStyle();
                pushEnabled();
                logDebug('suppression ' + (next ? 'enabled' : 'disabled'));
            });
        } catch (e) {
            logWarn('menu registration failed: ' + e);
        }
    }

    function watchStorage() {
        try {
            if (typeof GM_addValueChangeListener === 'function') {
                GM_addValueChangeListener(ENABLED_KEY, function () { pushEnabled(); });
            }
        } catch (e) { /* silent */ }
    }

    // --- bootstrap ----------------------------------------------------------

    injectPageHook();
    pushEnabled();
    if (window.top === window) {
        installHostStyle();
        registerMenu();
    }
    watchStorage();
})();
