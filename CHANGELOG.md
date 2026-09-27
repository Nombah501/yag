# Changelog

## 1.4.0

### Fixed
- Page-world hook no longer silently fails under the site's nonce-based CSP: when the inline `<script>` does not run, the hook is installed directly in the userscript world (effective with `@sandbox raw` / `@inject-into page`). The installed marker is now set by the hook itself, not before it runs.
- Initial "disabled" state is passed to the hook as an argument, so it is honored even when injection is deferred until the DOM exists.
- `YaGames` is patched even if the SDK replaces the accessor via `Object.defineProperty` or assigns the object before adding `init` (polling fallback now always runs for 30 s).
- State sync event carries a JSON string, readable across isolated/page worlds (Firefox Xray).

### Added
- `@match` for `yandex.com`, `yandex.kz`, `yandex.by`, `yandex.uz`, `yandex.com.tr`, `playhop.com`, and `/games` without trailing slash.
- `@inject-into page` for Violentmonkey.
- Menu shows current state (✅ ON / ⛔ OFF) and has a debug-log toggle; debug logging is off by default.
- Offline test harness: `node --test test/` (node:vm, no dependencies).

### Changed
- Adv method wrappers consolidated into one stub table; `@grant` headers grouped.
