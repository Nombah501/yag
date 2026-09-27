// Minimal fake browser page for yag.user.js: node:vm contexts, a stub DOM,
// fake timers, GM_* storage/menu stubs. No npm dependencies.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

export const SOURCE = readFileSync(new URL('../yag.user.js', import.meta.url), 'utf8');

export const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {object} opts
 * @param {Record<string, unknown>} [opts.store]   initial GM storage
 * @param {boolean} [opts.inlineScripts=true]     false emulates CSP blocking inline <script>
 * @param {boolean} [opts.domReady=true]          false: no documentElement until page.domReady()
 * @param {boolean} [opts.isolated=false]         run the userscript in a separate world
 */
export function createPage({ store = {}, inlineScripts = true, domReady = true, isolated = false } = {}) {
    const logs = [];
    const windowEvents = new EventTarget();
    const documentEvents = new EventTarget();

    // --- fake timers ---------------------------------------------------------
    let now = 0;
    let nextTimerId = 1;
    const timers = new Map();
    const addTimer = (fn, ms, repeat) => {
        const id = nextTimerId++;
        timers.set(id, { fn, ms: Math.max(ms || 0, 1), due: now + Math.max(ms || 0, 1), repeat });
        return id;
    };
    const clearTimer = (id) => { timers.delete(id); };
    const clock = {
        tick(ms) {
            const end = now + ms;
            for (;;) {
                let next = null;
                for (const [id, t] of timers) if (t.due <= end && (!next || t.due < next[1].due)) next = [id, t];
                if (!next) break;
                const [id, t] = next;
                now = t.due;
                if (t.repeat) t.due += t.ms; else timers.delete(id);
                t.fn();
            }
            now = end;
        }
    };

    // --- stub DOM ------------------------------------------------------------
    let pageCtx;
    const makeElement = (tag) => ({
        tagName: String(tag).toUpperCase(),
        id: '',
        textContent: '',
        dataset: {},
        parentNode: null,
        children: [],
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            if (child.tagName === 'SCRIPT' && inlineScripts) vm.runInContext(child.textContent, pageCtx);
            return child;
        },
        removeChild(child) {
            this.children = this.children.filter((c) => c !== child);
            child.parentNode = null;
            return child;
        }
    });
    const document = {
        documentElement: domReady ? makeElement('html') : null,
        readyState: domReady ? 'interactive' : 'loading',
        createElement: makeElement,
        getElementById(id) {
            const root = this.documentElement;
            return (root && root.children.find((c) => c.id === id)) || null;
        },
        addEventListener: documentEvents.addEventListener.bind(documentEvents)
    };

    // --- GM_* stubs ------------------------------------------------------------
    const values = new Map(Object.entries(store));
    const valueListeners = [];
    const menu = new Map();
    let nextMenuId = 1;
    const gm = {
        GM_getValue: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        GM_setValue: (key, value) => {
            const old = values.get(key);
            values.set(key, value);
            for (const l of valueListeners) if (l.key === key) l.fn(key, old, value, false);
        },
        GM_addValueChangeListener: (key, fn) => { valueListeners.push({ key, fn }); },
        GM_registerMenuCommand: (label, fn) => { const id = nextMenuId++; menu.set(id, { label, fn }); return id; },
        GM_unregisterMenuCommand: (id) => { menu.delete(id); }
    };

    const makeWorld = (extra) => {
        const ctx = vm.createContext({
            document,
            location: { href: 'https://yandex.ru/games/app/1' },
            CustomEvent,
            console: {
                log: (...args) => logs.push({ level: 'log', text: args.join(' ') }),
                warn: (...args) => logs.push({ level: 'warn', text: args.join(' ') })
            },
            setTimeout: (fn, ms) => addTimer(fn, ms, false),
            setInterval: (fn, ms) => addTimer(fn, ms, true),
            clearInterval: clearTimer,
            clearTimeout: clearTimer,
            addEventListener: windowEvents.addEventListener.bind(windowEvents),
            removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
            dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
            ...extra
        });
        vm.runInContext('var window = this; var top = this;', ctx);
        return ctx;
    };

    pageCtx = makeWorld({});
    const userscriptCtx = isolated ? makeWorld(gm) : Object.assign(pageCtx, gm);

    return {
        logs,
        clock,
        document,
        values,
        /** page-world global */
        global: pageCtx,
        run() { vm.runInContext(SOURCE, userscriptCtx); },
        eval(code) { return vm.runInContext(code, pageCtx); },
        domReady() {
            document.documentElement = makeElement('html');
            document.readyState = 'interactive';
            documentEvents.dispatchEvent(new Event('DOMContentLoaded'));
        },
        menuLabels() { return [...menu.values()].map((m) => m.label); },
        clickMenu(prefix) {
            const item = [...menu.values()].find((m) => m.label.includes(prefix));
            if (!item) throw new Error('no menu item containing ' + prefix);
            item.fn();
        }
    };
}

/** Fake YaGames API whose adv methods record calls to the originals. */
export function fakeYaGames() {
    const calls = [];
    const adv = {
        showRewardedVideo() { calls.push('orig:showRewardedVideo'); },
        showFullscreenAdv() { calls.push('orig:showFullscreenAdv'); },
        showBannerAdv() { calls.push('orig:showBannerAdv'); return Promise.resolve({ stickyAdvIsShowing: true }); },
        getBannerAdvStatus() { calls.push('orig:getBannerAdvStatus'); return Promise.resolve({ stickyAdvIsShowing: true }); },
        hideBannerAdv() { calls.push('orig:hideBannerAdv'); return Promise.resolve({ stickyAdvIsShowing: true }); }
    };
    const api = { init: () => Promise.resolve({ adv }) };
    return { api, calls };
}

/** Recording ad callbacks: returns { callbacks, events }. */
export function recordingCallbacks() {
    const events = [];
    return {
        events,
        callbacks: {
            onOpen: () => events.push('onOpen'),
            onRewarded: () => events.push('onRewarded'),
            onClose: (arg) => events.push('onClose:' + arg),
            onError: (err) => events.push('onError:' + err)
        }
    };
}
