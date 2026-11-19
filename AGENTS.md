# Webfoundry Agents Guide (`AGENTS.md`)

This guide explains how **projects inside Webfoundry** are structured and how to use its features.

---

## 📌 General Guidelines

* MOST IMPORTANT (DO NOT IGNORE): While the project is open in Webfoundry (check with `wf instances`), never edit `.html` files with text-based tools (echo with redirect, python with read/write commands, apply\_patch, etc.); the IDE holds the page and would overwrite or fight your edit. Use `wf read-html` and the other DOM manipulation commands documented below. When no Webfoundry tab has the project open, you may edit HTML files directly, then run `wf reflect` (see **Editing HTML without Webfoundry**).
* Don't run `wf select-file` before reading or editing HTML: it switches the page the user is looking at and can disrupt their work. Pass `--page pages/x.html` to `wf read-html` and the edit commands instead. Only use `wf select-file` to bring the user's attention to something, or when explicitly asked to.
* No need for `wf select-file` before manipulating non-HTML files
* This file documents everything you need. `webfoundry/*.js` in a project is the generated runtime, so don't read it to learn how things work. To list the theme classes that exist, `grep '@utility adw-' webfoundry/adwaita.tw.css` (likewise `and-` in `material.tw.css`, `win-` in `fluent.tw.css`).
* To test behavior, see **Testing a page** under the wf CLI Reference.
* Webfoundry projects are all UTF-8, so ignore ASCII-only instructions.
* Suggestions for requests on a mostly empty project (no HTML or JS files): Begin by calling `wf create-file` to scaffold pages/index.html and/or controllers/App.js.
* In Webfoundry, a div right under body is the page root, not body itself. Make sure all page content is wrapped inside that root div.
* Always start with HTML first, JavaScript second; back-and-forth until everything is in-place. Don't start JavaScript editing until there's an HTML page to drive from it.
* Always use `let`, never `const`.
* Ignore webfoundry/{scripts,templates}.json, they're fully managed by Webfoundry.
* Never put long JavaScript or script tags in HTML, always put them in a controller and call using wf-onattach or other event handler attributes.
* Event handlers must be JavaScript expressions, never statements (if needed use an IIFE).
* When calling post('ctrl.action') inside an event handler such as wf-onclick, wf-oninput, etc: `await` is allowed (wf-on\*, wf-onattach and wf-ondetach run as async functions) but only needed when sequencing work. Reactive bindings (`{{...}}`, wf-if, wf-map, wf-value, …) are synchronous, so never use `await` there.
* wf-value already wires two-way binding—never add wf-oninput, wf-onchange, or wf-onkeydown on that same element for setting the binding. If you need to react to Enter, wf-onkeydown is OK.
* `_1` is a special variable only available in wf-onattach and wf-ondetach. Other event handlers only have `event`, which is the global `window.event`, so read it before the first `await`. And bindings have no special variables besides globals and wf-map scoped variables.
* When special editing DOM/HTML tools are available, prefer surgical changes like a visual editor user would do instead of selecting the root and changing its entire HTML: Select the inner elements that need replacement and either change their HTMLs one by one or delete them altogether. Change selections and create divs in just the right places before using change HTML on them. When simple class adding/removal/replacement are needed, prefer specialized tools for that instead of change HTML, especially for preparing wrappers for inner content (e.g. setting `flex justify-center items-center` on a container).
* Event handler attributes are always e.g. wf-onclick="post('ctrl.action')". Not wf-on-click="...", not data-onclick="...", not even native onclick="...".
* wf-\* attributes only apply where their native equivalents apply. E.g. wf-value is only valid for \<input>, \<textarea>, etc.
* Before working on how a page looks with `native:` / `desktop:` / `mobile:` / OS (`win:` / `lin:` / `mac:` / `android:`) utilities on Nasty, always `wf set-platform-preview desktop` or `wf set-platform-preview mobile` as appropriate (either mode also activates `native:`), plus `wf set-platform-os <os>` for OS-specific looks. Afterward, leave platform preview on or `wf set-platform-preview off` based on context (see Styling → platform variants).
* Put native-bundle branding under project `icons/` (`icon.png`, `icon-256.png`, optional `icons/android/…`). Do not invent other branding folder names.

---

## 📂 Project Structure

```
project/
 ├─ controllers/   # Controller classes (state + actions)
 ├─ components/    # Reusable components (see Components below)
 ├─ pages/         # HTML files (edited in Webfoundry’s visual editor or directly)
 ├─ media/         # Project media (add subdirs if desired)
 ├─ icons/         # Optional native-bundle branding (icon.png, icon-256.png, android/…)
 ├─ webfoundry/    # Runtime, managed by Webfoundry; don't edit
 ├─ wf.config.js   # Marks the project root for the wf CLI; don't edit
 ├─ wf.uiconfig.json # Page options: tailwind, nerdfonts, betterscroll (booleans)
 └─ AGENTS.md      # This file
```

* **controllers/**: one class per file, default export.
* **pages/**: HTML entrypoints, can contain bindings (`wf-if`, `wf-map`, `wf-on*`, `{{...}}`). HTML files can't be created in the project root.
* **media/**: assets referenced from pages or controllers. The media gallery lists only this directory.
* **icons/**: optional launcher / desktop branding for native export (`icon.png`, `icon-256.png`, `icon.ico` later, `android/` mipmaps). If missing, export falls back to Webfoundry `favicon.ico`.

---

## 🧩 Controllers

Example:

```js
// controllers/App.js
export default class App {
  state = { input: '', items: [], warn: false };

  actions = {
    addItem: () => {
      this.state.items.push({ name: 'foo', value: 42 });
    },
  };
}
```

* **State**: global, e.g. `state.app.input`.
* **Actions**: call via `post('app.addItem')`.
* **Direct state mutation** is allowed, but it doesn't re-render by itself (see Rendering below). Prefer actions, and use `post()` even for one-liners in handlers: `wf-onclick="state.app.n++"` updates the state and leaves the page stale until something else renders.
* **Naming**: the key is the camelCased file name, so `controllers/TodoList.js` is `state.todoList` and `post('todoList.add')`.
* **Instances**: each controller is instantiated once at startup. There's no automatic init hook; run setup from `wf-onattach` on the page root, e.g. `wf-onattach="post('app.init')"`.
* **Rendering**: `post()` re-renders before the action, right after it returns or reaches its first `await`, and again when it finishes. To show progress in the middle of a long async action, or after mutating state outside `post()` (timers, sockets, direct mutation in a handler), call `d.update()`.
* `post()` returns a promise for the action's result and rejects with `Unknown controller: x` or `Unknown controller action: x.y` on bad names.

---

## 🖇 Bindings & Directives

Webfoundry templates support **declarative bindings**:

### Mustache Text

```html
<span>Hello {{state.app.input}}</span>
```

* Escape literal braces as `\{{...}}`.
* `{{markdown: expr}}` renders the Markdown string as a `div.prose`.
* A `<textarea>` whose only content is `{{expr}}` is two-way bound, like `wf-value`.

### Property bindings

```html
<input wf-src="state.app.src">
<input wf-alt="state.app.alt">
<input wf-value="state.app.input">
<input wf-checked="state.app.checked">
<input wf-disabled="state.app.disabled">
<input wf-placeholder="state.app.hint">
<a wf-href="state.app.url">Link</a>
<div wf-innerhtml="state.app.html"></div>
```

* These, with `wf-class`, `wf-if`, `wf-map`, `wf-on*`, `wf-component` and `wf-props` below, are all the `wf-*` attributes there are. There's no `wf-style`, `wf-show` or `wf-text`: use `wf-class`, `wf-if` and `{{...}}`.
* `wf-value` and `wf-checked` write back with `expr = newValue`, so their expression must be assignable.
* `wf-src` values are project paths such as `'media/logo.png'`, resolved from the project root on any page. A static `src` is relative to the page's own directory: `../media/logo.png` from `pages/`, `../../media/logo.png` from `pages/blog/`.

### Dynamic Classes (`wf-class`)

```html
<div class="bg-gray-200" wf-class="{{state.app.on ? 'text-white' : ''}} {{replaces bg-gray-200: state.app.on && 'bg-blue-500'}}"></div>
```

* Each expression must be wrapped in `{{...}}` and returns class names.
* `{{replaces cls: expr}}` also removes one static class, `cls`, from the element.

### Conditional Rendering (`wf-if`)

```html
<div wf-if="state.app.warn">Warning!</div>
```

### List Rendering (`wf-map`)

```html
<div wf-map="x of state.app.items">{{x.name}}: {{x.value}}</div>
```

* The syntax is exactly `name of expr`, with one variable. There's no index variable.
* `wf-if` and `wf-map` can't share an element (it throws). Nest them instead.
* At runtime, `wf-if` and `wf-map` elements and the page root lose the `hidden` attribute and the `hidden` / `invisible` classes, so those are safe for decluttering the visual editor. `id` is removed from `wf-map` items.

### Components

* Put the markup in any `components/*.html` file, as an element with `id="Name"`. Optionally add `components/Name.js` with a default-exported class that takes `props`.
* Use it with `<div wf-component="Name" wf-props='{"title":"Hi"}'></div>`. `wf-props` is JSON.
* Inside the component's markup, `this` is the class instance, e.g. `{{this.props.title}}`.
* `await showModal('Name', props)` opens a component in a `<dialog>` and resolves to `[dialog.returnValue, ...dialog.returnDetail]`. Navigating to another page removes open dialogs.

### Event Handlers (`wf-on*`)

```html
<button wf-onclick="post('app.addItem')">Add</button>
```

* Any DOM event can be bound by replacing `*` with the event name (`wf-oninput`, `wf-onchange`, etc.).
* The attribute value is a JS expression executed when the event fires.

### Special Lifecycle Events

```html
<div wf-onattach="console.log('attached', _1)" wf-ondetach="console.log('detached', _1)"></div>
```

* `wf-onattach`: runs when element is attached to DOM, \_1 is the element.
* `wf-ondetach`: runs when element is removed from DOM, \_1 is the element.
* Use for initialization/cleanup logic.

---

## 🔄 Lifecycle & Rendering

* Pages under `pages/` are loaded and routed automatically by Webfoundry’s App class.
* HTML gets compiled into reactive DOM; `post()` and two-way bindings trigger updates (see Controllers → Rendering).
* Don't re-render by hand beyond `d.update()`; mutate state or call actions instead.
* Routing: `/` is `pages/index.html` and `/foo/bar.html` is `pages/foo/bar.html`. Clean URLs work too: `/foo/bar` is `pages/foo/bar.html` and `/foo/` is `pages/foo/index.html`. Unknown paths render `pages/404.html`, if present. `triggerRouterError(code)` renders `pages/<code>.html`.
* Links: relative `<a href>` values navigate without a reload, relative to the current page's directory, so write `about.html`, not `../pages/about.html`. `#id` scrolls to that element. Hrefs with a scheme (`https:`, `mailto:`) and `download` links keep native behavior. Programmatic navigation is `history.pushState(null, '', url)`. Pass parameters in the query string (`wf-href="'details.html?id=' + t.id"`) and read them with `new URLSearchParams(location.search)`, usually from the `wf-onattach` of the destination page's root.
* The page root (the `div` right under `body`) already fills the viewport: `body` is a full-height flex column and the root is its `flex-1` child. Don't add `min-h-screen` or `h-screen` to the root; it pins the root to one viewport, and a `sticky` header inside it stops sticking after that.
* The page `<title>` comes from each page's `<head>`. `wf` can't select `<head>` elements even though `wf read-html` shows IDs for them, so set titles with `wf set-page-title "About"` (a blank page title uses the project title, set with `wf set-project-title`). Pages created by `wf create-file` start with `<body style="display: none">`, which the runtime reveals once styles are ready; keep it, along with the generated `<head>` scripts.

---

## 🌍 Scope & Expressions

* Bindings and directives can access any controller state: `state.<controller>.<field>`.
* `wf-map` introduces loop variables usable in mustache bindings, other bindings and event handlers inside it, e.g. `wf-onclick="post('tasks.remove', t.id)"`.
* `post()` should only be used in event handlers, not in reactive bindings.

---

## 🎨 Styling

* Tailwind utility classes are always available.
* Google Fonts can be injected via `gfont-[Font_Name]` classes.
* Use `wf-class` for dynamic class binding.
* `dark:` follows the OS setting (`prefers-color-scheme`) only. For an in-app dark mode toggle, put a `dark` class on `<html>` from a controller and style with `in-[.dark]:bg-stone-950` and the like, which also reaches dialogs.
* With `nerdfonts` on in `wf.uiconfig.json` (the default), Nerd Font icons are available as `<i class="nf nf-fa-check"></i>`.

### `native:` / `desktop:` / `mobile:` Tailwind variants

Webfoundry registers composable Tailwind v4 variants named `native:`, `desktop:`, and `mobile:`. Prefix any utility with them (and compose with other variants as usual), for example `native:rounded-2xl`, `desktop:text-pink-500`, `mobile:lg:opacity-50`.

Use **`native:`** for styles shared by all Nasty hosts. Use **`desktop:`** / **`mobile:`** only for host-specific overrides so you do not duplicate common native styles.

OS variants **`win:`** (Windows), **`lin:`** (Linux), **`mac:`** (macOS), and **`android:`** narrow a style to one OS, e.g. `lin:adw-header-bar`, `android:rounded-none`. The OS is independent of the form factor, so stack them for combinations: `lin:mobile:hidden` (Linux phone), `lin:desktop:flex` (Linux desktop). Android is `android:`, never `lin:`.

**Precedence (same CSS property):** `win:` / `lin:` / `mac:` / `android:` (active OS) beats `desktop:` or `mobile:` (active host), which beats `native:`, which beats bare utilities. Stacked variants (`lin:mobile:…`) beat single ones.

**When they apply**

* **Browser / IDE preview (default):** all three inert. The page looks like a normal web app.
* **Browser with Desktop Preview on:** `native:` and `desktop:` apply; `mobile:` does not.
* **Browser with Mobile Preview on:** `native:` and `mobile:` apply; `desktop:` does not.
* **Browser with an OS selected (Windows / Linux / Android):** `native:`, the selected Desktop or Mobile mode, and that OS's variant apply.
* **Exported Nasty / native bundle:** `native:` is always on. `desktop:` is on for desktop hosts; `mobile:` is on for Android. `win:` / `lin:` / `mac:` / `android:` follow the OS.

Do not rewrite class lists for preview. Authored markup keeps the tokens; the host decides whether they take effect.

**Platform Preview buttons (IDE)**

* A platform radiogroup of icons (**Web**, **Windows**, **Linux**, **Android**) followed by the **Desktop Preview** and **Mobile Preview** toggles.
* Placement: designer chrome, immediately to the left of the refresh control on the page toolbar (same cluster as refresh / clone / delete).
* Visibility: the controls appear when the open page’s DOM mirror has at least one class token containing `native:`, `desktop:`, `mobile:`, `win:`, `lin:`, `mac:`, or `android:`.
* Behavior: two global IDE preferences. `platformOs` (`web` | `win` | `lin` | `mac` | `android`, the radiogroup) and `platformPreview` (`off` | `desktop` | `mobile`, the toggles). Web is the plain browser: selecting it turns Desktop/Mobile off. Selecting an OS turns on Desktop (Mobile for Android) if neither is on; turning Desktop/Mobile off returns to Web. Desktop/Mobile with Web selected is the generic native preview (no OS). Active modes set `wf-native-preview`, `wf-desktop-preview` or `wf-mobile-preview`, and `wf-<os>-preview` on the live preview iframe’s `<html>`. Attributes are runtime-only and are not saved into project HTML.

**CLI (agents)**

* `wf is-platform-preview` — prints `off`, `desktop`, or `mobile`.
* `wf set-platform-preview off|desktop|mobile` — set the form factor (same preference as the Desktop/Mobile toggles).
* `wf is-platform-os` — prints `web`, `win`, `lin`, `mac`, or `android`.
* `wf set-platform-os web|win|lin|mac|android` — set the OS (same preference as the platform radiogroup).

**Agent workflow for platform looks**

* Before editing or verifying native / Nasty styling, turn a platform preview on: `wf set-platform-preview desktop` (shared `native:` + desktop overrides) or `wf set-platform-preview mobile` (shared `native:` + mobile overrides). Check first with `wf is-platform-preview` if useful.
* After that work, leave the matching preview on when the user is still reviewing it, or `wf set-platform-preview off` when returning to ordinary web layout work. Prefer restoring the prior mode when you flipped it only for a short pass.

Example:

```html
<div class="rounded-none native:rounded-2xl text-white native:text-neutral-100 desktop:text-pink-500 mobile:text-sky-400">
  …
</div>
```

On the web with platform preview off, you get square corners and white text. With Desktop Preview on (or in a desktop Nasty export), corners round and text is pink. With Mobile Preview on (or on Android), corners round and text is sky.

### Adwaita `adw-*` classes

Webfoundry ships the GNOME Adwaita styles from adwaita-web as `adw-*` utility classes (every upstream class is `adw-` prefixed: `adw-button`, `adw-card`, `adw-suggested-action`, `adw-title-1`, `adw-boxed-list`, …). They are Tailwind utilities, so any variant composes: `md:adw-card`, `mobile:adw-button`, `lin:adw-headerbar`, `hover:adw-dimmed`.

* Combine component classes with their modifiers exactly like upstream: `<button class="adw-button adw-suggested-action">`, `<button class="adw-button adw-flat adw-circular">`. Child rules (e.g. `.adw-icon` inside `.adw-button`) follow from the markup.
* Platform-scoped: prefix only the component classes (`lin:adw-button adw-suggested-action`). Modifier/marker classes (`adw-suggested-action`, `adw-flat`, `adw-circular`, `adw-pill`, `adw-header-bar-title`, …) have no styles of their own and only act where the component class is active, so leave them unprefixed.
* Page base: `adw-page` (upstream `body` rule: font, spacing), `adw-background` (window background and text color); element styles as `adw-h1`…`adw-h6`, `adw-p`, `adw-a`, `adw-hr`, `adw-all` (the `*` reset).
* Themes: add `adw-theme-dark` to `<html>` (on Nasty: to `<body>`) for the dark theme; accents via `adw-accent-blue|teal|green|yellow|orange|red|pink|purple|slate` on `<html>` (web only).
* Symbolic icons: `adw-icon-<name>-symbolic` (e.g. `adw-icon-go-next-symbolic`), drawn with `background-color: currentColor` through a mask; size them with the element (e.g. `size-4 inline-block`). Web only.
* Nasty supports the subset Nasty can express: base styles, `hover:`/`active:`, class/attribute/structural modifiers, descendant/child rules, `max-md`, and dark. Focus rings, `:not()`, pseudo-elements, masks/icons, accents and vendor properties are web-only.

### Material `and-*` classes (Android)

Webfoundry also ships Material Design 3 (from Beer CSS) as `and-*` utilities. Beer styles elements, so every element becomes a class: `and-button`, `and-header`, `and-h1`…`and-h6`, `and-body` (page base: surface background, on-surface text, Material font), plus helpers such as `and-border` (outlined), `and-secondary-container` (tonal), `and-primary-text`, `and-surface`, `and-large`/`and-small`/`and-extra` (sizes), `and-circle`, `and-round`. Dark theme: `and-dark` on `<body>`.

* Scope to Android with `android:` (combine with `mobile:` / `desktop:` as needed): `<button class="android:and-button android:and-border">`.
* Material modifiers usually have styles of their own, so prefix them too (`android:and-border`, `android:and-large`). A platform-prefixed modifier still counts for compound rules (`and-button` + `and-border`) when its variant is active. This works for `adw-*` markers as well (`lin:adw-flat`).

### Fluent `win-*` classes (Windows)

Webfoundry also ships Windows Fluent 2 (from the Kendo UI Fluent theme) as `win-*` utilities, e.g. `win:win-button`. Scope them with `win:`.

### Native export

* Settings → **Export native app** builds a native bundle for the open project.
* Targets: **linux-x64** and **android-arm64** (win-x64 later). Android is always listed; export fails clearly if the runtime APK is missing.
* Linux: AppImage with project overlay. Android: debug-signed APK (sideload / `adb install`); re-sign with a release keystore for store builds; Play often wants AAB later.
* Optional project `icons/` for branding; otherwise Webfoundry `favicon.ico` is used.
* **Theme** pills (one at a time, click again to clear), per target: **Use Adwaita** (`lin:adw-*`), **Use Kendo UI** (`win:win-*`), **Use Beer** (`android:and-*`) force that platform's variant on any build — e.g. Kendo UI on a Linux build; **Use system theme** follows the device OS; none renders like the web preview (`native:` / `desktop:` / `mobile:` only).
* Android dialog shows **orientation** (`auto` | `portrait` | `landscape`) and hides desktop window chrome options.

### Native apps only: `window` and bare globals

These bindings exist **only in exported Nasty / native bundles**. They are not available in the ordinary browser IDE preview. Node ESM has no browser `window` scope; the native adapter injects live imports so the same unqualified names work as in the browser (`state`, `post`, `document`, `window`, …). Prefer bare names; `window.X = …` also updates those live bindings.

**Always injected (shim / WF):** `window`, `document`, `state`, `post`, `d`, `rawctrls`, `showModal`, `selectFile`, `renderComponent`, `renderTemplate`, `wfeval`, `arrayify`, `tap`, `anime`, `triggerRouterError`, `localStorage`, `sessionStorage`, `location`, `history`, `fetch`, `navigator`, `rootPrefix`, `bundleName` (the bundle's file name, e.g. `counter-x86_64.AppImage` or `counter.apk`; also `window.bundleName`; undefined on the web, so test with `typeof bundleName === 'undefined'`), `Node`, `Element`, `HTMLElement`, `Text`, `Comment`, `Document`, `Attr`, `MutationObserver`, `ResizeObserver`, and bare `addEventListener` / `removeEventListener` / `dispatchEvent` / `requestAnimationFrame` / `cancelAnimationFrame` (forwarded to the host window). Bare `scrollTo` is a no-op; bare `alert` throws `Not implemented`.

The host `window` also exposes non-standard Nasty APIs; see **Native apps using Nasty** below.

---

## 📱 Native apps using Nasty

Exported native bundles run on Nasty, not a browser. `window` is a Nasty `Window`: it supports the usual DOM-facing members and adds the non-standard APIs below. **None of these exist in the browser IDE preview.** Guard any use with a feature check (e.g. `'userDataPath' in window`, `typeof window.captureFrame === 'function'`) so pages still work on the web.

Initial values come from the project's Native export settings (baked into `nasty-window.json`). Changing them at runtime from a controller is fine.

### Window chrome and geometry

| API | Type | Notes |
|-----|------|-------|
| `window.title` | `string` (get/set) | Host window title. Prefer `<title>` / `document.title` once the page is attached. |
| `window.width` / `window.height` | `number` or `'Npx'` / `'N%'` (get/set) | Requested size. Numbers are px; `%` is relative to the display. Non-negative only. |
| `window.size()` | `() => { width, height }` | Actual current window size in px (differs from `width`/`height` after user resizes or maximizes). |
| `window.devicePixelRatio()` | `() => number` | **A method, not a property** (unlike the web). Device px per CSS px. |
| `window.resizable` | `'both' \| 'horizontal' \| 'vertical' \| 'none'` (get/set) | Which axes the user may resize. |
| `window.orientation` | `'auto' \| 'portrait' \| 'landscape'` (get/set) | Android screen orientation lock. Not the deprecated web `window.orientation` number. |
| `window.borderless` | `boolean` (get/set) | Removes OS decorations (title bar, frame). Pair with `dragAnywhere` or your own drag area. |
| `window.dragAnywhere` | `boolean \| string` (get/set) | `true`: pressing on any non-interactive spot drags the window. A key name (e.g. `'Alt'`): drag only while holding it. Elements with click listeners, scrollable areas, `contenteditable`, interactive ARIA roles, and fullscreen content never start a drag. |
| `window.maximizable` | `boolean` (get/set) | Enables double-click-to-maximize on drag areas. Defaults to `false`; throws if the body's `max-width`/`max-height` would forbid maximizing. |
| `window.maximized` | `boolean` (get/set) | Read or toggle maximized state. |
| `window.vsync` | `boolean` (get/set) | Present in sync with the display refresh (default `true`). |
| `window.closed` | `boolean` (get) | `true` once the window is closed. |
| `window.close()` | `() => void` | Closes the window and ends the app. |

### App data paths

| API | Type | Notes |
|-----|------|-------|
| `window.appId` | `string \| null` | The app's id. |
| `window.userDataPath` | `string \| null` | Absolute app data directory (`$HOME/.<appId>` by default). Persist app files here with Node `fs`. Nasty itself stores remembered window geometry in `window.json` there. |
| `window.cachePath` | `string \| null` | Absolute cache directory (`<userDataPath>/cache`). Nasty caches downloaded Google Fonts under `fonts/`. |

`localStorage` / `sessionStorage` are in-memory shims in native apps and do not survive restarts; write files under `userDataPath` for real persistence.

### File pickers

Both follow the web File System Access API shape and **reject with an `AbortError` `DOMException` on cancel**.

* `await window.showOpenFilePicker({ multiple?, types?, excludeAcceptAllOption?, startIn?, id? })` → array of `FileSystemFileHandle`. `handle.getFile()` returns a standard `File`.
* `await window.showDirectoryPicker({ mode?, startIn?, id? })` → `FileSystemDirectoryHandle`. Its file-access methods are **not implemented**; use `handle.path` with Node `fs` (or a watcher such as chokidar) instead.
* Nasty extension: every handle has **`handle.path`**, the absolute filesystem path. `startIn` accepts a handle or a path string; `id` remembers the last folder per id.
* `queryPermission()` / `requestPermission()` always resolve `'granted'`.

### Audio output

* `window.audioOutputs` → `[{ id, name, description, isDefault, sampleRate, … }]` (refreshed at most once per second).
* `window.audioOutput` (get/set) → current output device `id`; set to an `id` from `audioOutputs`, or `null` for the system default. Throws `RangeError` for an unknown id. Playing `<video>` audio moves to the new device.

### Frame capture

* `await window.captureFrame(path?, { element?, rect? })` captures the next presented frame. With a `path`, writes a PNG there; with `null`, copies the image to the system clipboard. `element` limits it to that element's on-screen box; `rect` (`{ x, y, width, height }` in CSS px) to any region.
* `await window.copyFrame({ element?, rect? })` is shorthand for `captureFrame(null, …)`.
* Both reject with `AbortError` if the window closes first.

### Animations

* `window.registerKeyframes(name, [{ offset, class }, …])` registers keyframes for Tailwind `animate-[name_duration_…]` classes, with each frame given as Tailwind classes. Register before creating elements that use `name`.

### Window events

`window.addEventListener` receives host events besides the usual DOM ones:

* `close`: the window is closing (user or `close()`). Flush state to disk here.
* `resize`: the window size changed; read `window.size()`.
* `maximize`: maximized state changed; read `window.maximized`.

### Do not call

* `window.drainEvents()`: Nasty already polls and routes native events; draining them yourself loses clicks and scrolling.
* Frame presentation APIs (`present`, `presentDocument`, `presentWithImages`, `presentOrdered`, `presentTransformed`): Nasty presents the attached document itself.
* `window.document = …`: the Webfoundry boot attaches the page document; build UI with standard DOM + Tailwind / `native:` / `desktop:` / `mobile:` classes.

---

## ⚡ Cross-Controller Usage

* It is valid to reference any controller’s state or call any action from anywhere.
* Example:

  ```html
  <div wf-if="state.user.loggedIn">Welcome {{state.user.name}}</div>
  <button wf-onclick="post('settings.toggleTheme')">Switch Theme</button>
  ```

---

## 💾 Persistence

* State is **not persisted automatically**.
* Persistence must be implemented explicitly in controllers or imported modules.

---

## 🧭 Best Practices

* **Mutate state directly** when only UI updates are needed, followed by `d.update()` if it isn't inside an action.
* **Use actions** when updates have side effects or should be explicit.
* Avoid manual DOM manipulation; rely on bindings/directives.
* Do not perform cleanups/optimizations unless explicitly required.

---

## 🛠️ wf CLI Reference

The `wf` command talks to the local Companion server, which forwards to the Webfoundry tab that has the project open. Commands fall into three groups; follow the noted syntax exactly. `wf help` lists them.

### Structure & Scaffolding

* `wf select-file <relative/path>` – switch the IDE to a file, moving the user's view. Only for bringing the user's attention to something, or when explicitly asked to; read and edit with `--page` otherwise.
* `wf create-file <relative/path>` – scaffold new files via Webfoundry templates (single positional path only). `.html` gets the page skeleton and `controllers/*.js` a controller class; anything else starts empty. The active page doesn't change: read and edit the new page with `--page`, or pass `--select` to also open it (same rule as `wf select-file`). If the file exists, the IDE asks the user whether to overwrite, so check first.
* `wf read-html --page pages/x.html` – print a page's snapshot (includes `data-htmlsnap` IDs). Without `--page`, it reads the page open in the IDE.
* `wf change-selection <id ...>` – select elements by data-htmlsnap ID (IDs only); use `wf toggle-selection` to restore the previous selection.
* `wf copy-selected` – copy the current selection.
* `wf paste-first-child|paste-last-child|paste-next-sibling|paste-prev-sibling --target <ids> [--count 1]` – paste relative to the target.
* `wf create-first-child|create-last-child|create-next-sibling|create-prev-sibling --target <ids> [--tag div | --html 'markup'] [--count 1]` – insert new nodes (use the --html option for non-layout nodes to speed things up)
* `wf wrap [--tag div]` / `wf unwrap` / `wf delete-selected` – restructure or clear nodes.
* `wf change-html|change-inner-html --target <ids> --html '<markup>'` – replace outer/inner markup of the target.

### Styling & Attributes

* `wf change-element-tag --tag span`
* `wf change-element-id --id hero_title`
* `wf add-css-classes class...`
* `wf remove-css-classes class...`
* `wf replace-css-classes --old "old classes" --new "new classes"` (for a regex: `--old 'wfregexp:/^bg-/'`)
* `wf replace-text "New copy"`
* `wf set-placeholder "Placeholder text"`
* `wf set-href https://example.com`
* `wf set-src path/to/logo.svg [--expr state.app.logo]` – a static audio or video path also changes the element's tag to match.
* `wf set-input-value value --expr state.form.name` – `<input>` elements only; bind a `<textarea>` with `wf change-html`.
* `wf change-form-method --method post`
* `wf toggle-hidden`
* `wf is-platform-preview` – print `off` / `desktop` / `mobile` for IDE platform preview
* `wf set-platform-preview off|desktop|mobile` – set platform preview form factor (enable before working on `native:` / `desktop:` / `mobile:` looks; either on-mode also activates `native:`; restore or leave on based on context afterward)
* `wf is-platform-os` / `wf set-platform-os web|win|lin|mac|android` – read/set the previewed OS for `win:` / `lin:` / `mac:` / `android:` looks
* `wf is-page-preview` – print the open page's mode: `preview` (the page runs live, as users see it) or `edit` (visual editor)
* `wf set-page-preview preview|edit|toggle` – switch the open page between preview and edit modes (same as the editor's Preview button)
* `wf get-project-title` / `wf set-project-title "My App"` – read/set the project title (same as Project Title in Settings; stored in `index.html`)
* `wf get-page-title [--page pages/x.html]` / `wf set-page-title "About" [--page pages/x.html]` – read/set a page's title (same as Page Title in Settings). `""` clears it, and the page then uses the project title. Not available in preview mode. Setting titles isn't available to collab peers.

### Logic & Events

* `wf set-if-expr "state.app.ready"`
* `wf set-map-expr "item of state.app.items"`
* `wf set-disabled "!form.valid"`
* `wf set-event-handlers "click=post('app.save')"` – replaces all handlers on the selection.
* `wf add-event-handlers "click=post('app.save')"` – adds or overwrites only the named events.
* `wf rm-event-handlers click change`

Use bare event names (`click`, not `onclick`). Quote the pairs, because parentheses are shell syntax.

### Instances, Projects & Cursors

* `wf instances` – list connected Webfoundry instances: id, `local` or `collab`, open project, origin.
* `wf projects` – list the projects visible on each instance, with their storage (`cfs` is on disk, `local` is browser storage) and which one is open.
* `wf open-project <name>` / `wf create-project <name>` – open or create a project. Work on it from its folder under the workspace.
* `wf open [--url <url>]` – open a new Webfoundry instance in the default browser and print its id.
* `wf list-editors` – list open visual editors: path, flags (`active`, `shadow`, `loading`, `preview`), cursors.
* `wf deploy-info` – whether a Netlify API key is stored in the IDE and which Netlify site the project deploys to.
* `wf deploy [--new <name> | --site <name|domain|id>] [--preview]` – deploy the project to Netlify and print its URL. The first deploy needs `--new` (creates `<name>.netlify.app`) or `--site` (an existing site); later deploys reuse that site. `--preview` makes a draft deploy with its own URL and leaves the live site alone. It uses the API key the user stored in the IDE, which you never see: if none is stored, ask the user to deploy once from the editor's Deploy button. Deploy only when the user asks, and prefer `--preview` unless they asked to publish. It can take a few minutes. Collab peers can't deploy.

These flags work on any subcommand:

* `--page <path>` – run an HTML read/edit command on that page without switching to it. The page loads in the background if needed, and needs no `wf select-file`. Selections and undo are per page, and `data-htmlsnap` IDs are only valid for the page they came from. Pass the same `--page` on every command in a sequence.
* `--target <ids>` – **required on every HTML edit command** (create, paste, wrap, unwrap, delete, tag, ID, text, attribute, class, expression, and event handler commands). Comma-separated `data-htmlsnap` IDs from `wf read-html`. The IDs also become your cursor's selection. `wf copy-selected` accepts it too.
* `--cur <id>` – which designer cursor to use. The default is `WF_CURSOR`, else one derived from the agent's session id, else `master`. Each agent has its own cursor, in its own color, so `--cur master` is how you act on what the user has selected. An agent's cursor fades out after 5 seconds without a command that uses it, and is removed after 1 minute, which drops its selection.
* `--instance <id>` (or `WF_INSTANCE`) – the instance to talk to; a unique prefix of its id is enough.
* `--project <name>` – the project to act on instead of the one containing the working directory. It only picks among instances that already have that project open.

Each command reaches exactly one instance. With several matches it fails with `More than one Webfoundry instance matches` and lists them; pick one with `--instance`. Subagents usually share their parent's session id and so its cursor: give each subagent its own `WF_CURSOR` when several edit at once. `--page` isn't available from collab peers yet.

Flag aliases: `--ids` (change-selection), `--classes` (add/remove-css-classes), `--text` (replace-text), `--url` (set-href), `--expr` (expression commands), `--handler` (repeatable, set/add-event-handlers), `--event` (repeatable, rm-event-handlers). Add `-v` after the subcommand for a full stack trace on failure.

### Testing a page

`wf set-page-preview preview` runs the page live in the IDE, but `wf` can't click or type in it. To test interactions, serve the project folder as static files with every unknown path falling back to `/index.html` (that's what `_redirects` declares; e.g. `npx serve -s .`, which redirects `/x.html` to `/x`, and both work) and drive it with a headless browser such as Playwright. Pages render from `webfoundry/templates.json`, which the IDE regenerates a moment after an edit, so wait a second or two after your last `wf` command. There's no IDE-side console access from `wf`. To check native looks in that browser, set on `<html>` the attributes Platform Preview uses, before the page renders (e.g. Playwright's `addInitScript`): `wf-native-preview`, plus `wf-desktop-preview` or `wf-mobile-preview`, plus `wf-lin-preview`, `wf-win-preview` or `wf-android-preview` for an OS.

### Editing HTML without Webfoundry

When no Webfoundry tab has the project open (`wf instances` doesn't list it), the DOM commands can't reach it, and you may edit `.html` files directly. Pages render from `webfoundry/templates.json`, so after editing HTML (or adding or removing `.html` / `.js` files), run:

* `wf reflect` – regenerates `webfoundry/templates.json` and `webfoundry/scripts.json` from the files on disk. It needs no IDE or Companion. It also checks every file under `pages/` and `components/` and exits non-zero listing what to fix.

Keep the structure `wf create-file` scaffolds, which is what `wf reflect` checks:

* `<head>` holds only `<meta>`, `<title>` and the generated runtime loader `<script>`; nothing else (no `<link>`, `<style>` or other scripts; styling is Tailwind classes, logic goes in controllers).
* Nothing sits outside `<head>` and `<body>`, and nothing outside `<html>`.
* In pages, `<body>` keeps `class="flex flex-col [&>div:first-child]:flex-1 …"` and `style="display: none"`, and its only element is the root `div`, which holds all content and doesn't set `h-screen` / `min-h-screen`.

### Usage Notes & Validation Rules

* Run `wf` commands from inside the Webfoundry project root (the folder that contains `wf.config.js`).
* `wf create-file` requires exactly one positional path; all other arguments must be explicit flags (`--select` is the only one it takes).
* `wf read-html` takes only global flags such as `--page`. If it fails with `Designer closed`, pass `--page`.
* `wf change-selection` accepts only data-htmlsnap IDs—do **not** supply file paths or flags such as `--file`.
* HTML edit commands (create, paste, wrap, attribute changes, etc.) act on the elements named by `--target`, even if you changed the selection beforehand. Get IDs from `wf read-html --page pages/x.html`, then run e.g. `wf add-css-classes --page pages/x.html --target <id> --classes flex`.
* `wf change-inner-html` needs exactly one target element. Commands limited to one element type (`set-input-value`, `set-placeholder`, `change-form-method`) silently do nothing on other elements, so check the result with `wf read-html`.
* A flag's value can't begin with `--`; it would be read as another flag.
* Event handler commands expect `event=expression` pairs (e.g. `wf add-event-handlers "click=post('app.handleClick')"`).
* When a command reports missing IDs, refresh your snapshot with `wf read-html` before retrying. IDs don't survive `wf select-file`, `wf change-html`, `wf change-inner-html` (for anything inside the replaced markup) or a preview switch.
* Page preview is distinct from platform preview: page preview runs the page live (bindings, controllers, event handlers), while platform preview only changes which `native:` / `desktop:` / `mobile:` utilities apply. Use `wf set-page-preview preview` to check runtime behavior, then `wf set-page-preview edit` to go back to the visual editor; restore whichever mode the user had when you're done. Switching modes reloads the page, so `data-htmlsnap` IDs change: run `wf read-html` again before selecting elements.
* Chain multiple `wf` commands using && when the commands are closely related, speeding things up and making changes look more atomic.
* The project is identified by the name of the folder containing `wf.config.js`, which must match the project open in the IDE.
* Environment: `WF_ENDPOINT` overrides the Companion URL (default `ws://localhost:8845`). `WF_CLIENT_KEY` overrides the key from `~/.webfoundry/config.env`.
* `wf set-platform-preview off` also returns the previewed OS to `web`.
* Common errors:
  * `wf.config.js not found`: run from inside the project.
  * `WF_CLIENT_KEY not found`: start the Companion once, or set the variable.
  * `Connection timed out.`: the Companion isn't reachable.
  * `No response from the Companion.`: it accepted the command but never answered; retry, and check that the Companion is still running.
  * `Webfoundry project not connected: <name>`: open that project in the IDE with Companion enabled.
  * `Timed out waiting for Webfoundry response`: the IDE took over 10s, often because a dialog is waiting for the user. `wf set-src` and `wf set-input-value` open one when given neither a value nor `--expr`.
  * `Designer closed`: pass `--page pages/x.html`.
  * `This command requires --target`: pass the element IDs from `wf read-html`.
  * `No elements selected.`: pass `--target` (only `wf copy-selected` and `wf toggle-selection` can still hit this).
  * `Can't edit in preview mode.`: run `wf set-page-preview edit`.
* While the project is open in Webfoundry, *NEVER* use text-based HTML edits (`echo` with redirect, `python` read/writes, `apply_patch`, etc.); always rely on the `wf` subcommands. Without an open tab, edit directly and run `wf reflect`.

---

## 📌 Quick Reference

* **Access state**: `state.<controller>.<field>`
* **Call action**: `post('<controller>.<action>', ...args)`
* **Text binding**: `{{expr}}`
* **Two-way binding**: `<input wf-value="...">`
* **Conditionals**: `wf-if="expr"`
* **Lists**: `wf-map="x of expr"`
* **Events**: `wf-on<event>="expr"`
* **Lifecycle hooks**: `wf-onattach`, `wf-ondetach`
* **Pages**: live in `pages/`, nested folders included; create them with `wf create-file` so `<head>` has the script that loads the runtime (`webfoundry/ifdesigner.js`, `webfoundry/head.js`) from the project root

---

## Sprites and transparent PNGs

`remove_background` and `run_js` below are tools of Webfoundry's built-in agent panel. External CLI agents don't have them.

A sprite, a prop, or a UI frame that sits on top of another picture is a cutout. The source picture is the figure or the ornament on one flat backdrop color: no floor, no cast shadow, no furniture, no extra background. A chair painted into the sprite cannot sit in the room. Poses of one character share a baseline. The plate or the room is a separate image and stays opaque. The subject may contain green. That green is not the backdrop.

Put that source file in the project, then call `remove_background`. `input` is the source path. `output` must end in `.png`. `color` is the exact backdrop color as `#rrggbb`, read off the backdrop, not off the costume. The tool removes pixels by distance to that color and feathers the edge. A lime shirt stays when the backdrop is a different green. It writes a transparent PNG.

Use `remove_background` only when the background is a flat key color that should disappear. Leave plates, photos, and pictures whose background is part of the art alone.

In page HTML, an image `src` is `../media/...` (one more `../` per folder under `pages/`). Mounting the page strips one leading `../` from `src` and from every CSS `url(...)` in inline `style` attributes, including `background-image` and `border-image-source`. This is the same one prefix, once:

```html
style="border-image-source: url('../media/ui/dialog-frame.png')"
```

`run_js` runs in the open page iframe. The visual editor has to be open or it throws, and it times out after 20 seconds. `args` is a map of parameter names to values, and `body` is the function body. `run_js({ args: { x: 1, y: 2 }, body: 'return x + y' })` is `await new AsyncFunction('x', 'y', 'return x + y')(1, 2)`. Return the value you want back. `document` is the page.

---

## 🪝 Decoration projects

A Decoration project has no pages. `site.decoration.json` stores the site's origin and its hooks, and selecting that file opens the site in the designer. Creating one is hidden in the UI for now. Requires the Firefox extension in `other/firefox-decorate/`.

* The site's DOM belongs to the site. A selected element can't be changed until a hook targets it, and hooking a parent does not unlock its children.
* Each hook has an ID and can be scoped inside a parent hook, in which case its target is resolved once per parent match.
* Repeated elements are detected when the hook is created, so one hook covers every repeat.
* The hooks form a state object (`state.decoration.data`). A hook with child hooks is an object of its children; any other hook is its element's text (`src` for images, `value` for inputs). A hook matching all its repeats, or sharing its ID with another hook in the same parent, is an array.
* On a hooked element, only added Tailwind classes are editable (`wf add-css-classes` / `wf remove-css-classes`). Its original classes are read-only, and other edits are refused.
* Insert elements through a hooked element with the usual `wf create-*` and `wf paste-*` commands. Ghost is in the Create toolbar menu.
* Inserted elements belong to the project and accept the usual `wf` commands, except ones that would change the site's DOM around the inserted root.
* Inserted elements are plain HTML: `wf-*` bindings and controllers don't run in them.
* Ghost hides the hooked element (`visibility: hidden !important`) and anchors the replacement over it. The element's width drives the replacement, and a taller replacement pushes the page down.
* `wf set-page-preview preview` lets the site respond to clicks, which is how you navigate it; `edit` returns to selecting. Each page load gets new `data-htmlsnap` IDs, so run `wf read-html` again after navigating.

---

## 🧰 Editing this repository's own HTML

This section applies only when working on the Webfoundry repository itself. To change a repo `.html` file, open a new Webfoundry instance and edit through `wf`, never with text tools and never through the user's open tab.

1. Back up the page, `webfoundry/scripts.json` and `webfoundry/templates.json`, and save `git status --short`.
2. Open a new instance with `xdg-open http://localhost:8846/editor.html` or `xdg-open https://www.webfoundry.app/editor.html`. Run `wf instances` before and after to find the new instance's ID.
3. From the repo root, run `wf open-project webfoundry --instance <id>`, then `wf select-file pages/x.html --instance <id>`, and repeat `wf read-html --instance <id>` until the snapshot is there. Edit with the DOM commands and `--target`, using your own `--cur` and the same `--instance`.
4. Wait a few seconds for the save, then diff the page against the backup. Only the intended markup should differ; otherwise restore the backup. Opening the project rewrites `webfoundry/scripts.json`, so restore it and `templates.json` from the backup. Pages are served from `templates.json`, so a new edit shows in the running app only after Webfoundry next regenerates it.

---

## 🐞 Issue tracking (`other/issues.js`)

This section applies only when working on the Webfoundry repository itself. If `other/issues.js` doesn't exist, ignore it.

Issues are front-matter + Markdown files at `issues/<id>.md` in the repository root, wherever the tool is run from. Front-matter fields are `id`, `brief`, `state`, `tags`, and `created`. States are `todo` (the initial state), `wip`, `done`, and `wont-do`.

```sh
other/issues.js add <id> "<brief description>" --bare [--tag <tag>]...
other/issues.js mark <id> <todo|wip|done|wont-do>
other/issues.js comment <id> --author "<name>" --brief "<comment>"
other/issues.js read <id>
other/issues.js list
other/issues.js rm <id>
other/issues.js edit <id>
```

* Agents have no interactive `$EDITOR`, so always pass `--bare` to `add` and `--brief` to `comment`, and don't use `edit`. Without them, the command launches `$EDITOR`, or fails if it isn't set.
* To add a longer description after `add --bare`, edit `issues/<id>.md` directly and leave the front-matter intact.
* IDs may contain letters, digits, `_`, `.`, and `-`, and can't start with `.` or `-`.
* `--author` is mandatory on `comment`. Use your own name, not the user's.
* Always pass the state to `mark`: when omitted, it resets the issue to `todo`.
* `list` prints one `state | id | brief` line per open issue. Open means `todo` or `wip`, so `done` and `wont-do` issues are not listed.
* Every command except `list` prints the resulting issue file to stdout. `rm` prints it one last time, then deletes it.
* `rm` is irrevocable, so only use it when the user asks for it. To close an issue, prefer `mark <id> done` or `mark <id> wont-do`.

---

## Tehboxen: accounts and sessions

* `pages/index.html` is the login / account-creation screen (controllers/Auth.js); `pages/desktop.html` is the OS desktop.
* Players are VFS users with `human: true` (other/accounts.js `createAccount`): own uid/gid (first player gets uid 1000), private home, `sudo` + `world` groups, placed in `places/safehouse`.
* Passwords are PBKDF2-SHA256 hashes in the VFS shadow store (`setPassword` / `verifyPassword`); `node` exposes them as root-only `/etc/shadow` (`/etc/passwd` and `/etc/group` are generated from the users db).
* The session is `localStorage['tehboxen.session']` (other/session.js). Modules read `PLAYER` / `PLAYER_HOME` at import time, so login and logout do a full page load. Never hardcode a player username in host code.

## Tehboxen: `node` command

* `node` in the Terminal (other/node/): each run is a process in its own module Worker (worker.js). The page serves its syscalls (host.js) against the live VFS with the shell user's permissions; nothing is snapshotted, directory listings come from a shared incremental index.
* Blocking calls (`readFileSync`, `execSync`, …) use a SharedArrayBuffer + `Atomics.wait` channel (channel.js), so the page must be cross-origin isolated: in Webfoundry turn on Settings → Hardened isolation; deploys get COOP/COEP from `_headers`. Without isolation `node` exits 1 with an explanation.
* commander parses Node's CLI (`-e`, `-p`, `-c`, `-r`, `--import`, `-C`, `--input-type`, `--env-file`, `--run`, `--unhandled-rejections`, …); its bundle is built once from jsdelivr and cached by the page for later processes.
* other/node/browserify.js is the adapted browserify: Node resolution (`exports`/`imports` conditions, `main`, index files), Babel for ESM / TypeScript → CommonJS, async browser-pack prelude; the bundle runs as an AsyncFunction so top-level await works.
* Networking (`net`, `http`, `dns`, …) throws ENOSYS until fake servers exist (planned: WASM/LLVM toolchain building vulnerable services in the VFS).
* Output streams live to the Terminal when not piped/redirected; Ctrl-C sends SIGINT, `kill` sends SIGTERM (or `-SIG`), and a process that doesn't exit within 1.5 s is terminated.

## Tehboxen: WASI and file locks

* `node:wasi` (other/node/wasi.js) implements WASI preview1 on the blocking syscall channel: files are the live VFS with the user's permissions, preopens are capability roots (paths can't escape them or a directory fd: ENOTCAPABLE), rights are enforced, fds on one file share a buffer. Sockets: none yet (EBADF / ENOTSOCK). Conformance: all 72 wasm32-wasip1 tests of WebAssembly/wasi-testsuite (prod/testsuite-base) pass.
* The shell runs `.wasm` files directly (WASI, with `/` and `.` preopened, like `wasmtime --dir / --dir .`).
* Open fds hold VFS leases (WASI path_open/fd_close and node fs.openSync/closeSync): shared `r` for read-only, exclusive `w` for write / read-write / O_TRUNC. Held until close or process exit (renewed every 10 s; the 30 s TTL only frees them if the page dies). Conflicting opens wait up to the VFS lock timeout, then EBUSY. A process's own I/O reuses its leases (hardlinked names share one lock by inode).
* Node fs calls are never cached in the worker: every call is a syscall against the live VFS. The page keeps a directory index (other/node/host.js) current from VFS change events; the shell's path view is built from it on demand.
* `/tmp` is a real VFS directory, mode 1777.

## Tehboxen: C/C++ toolchain (clang)

* `clang`, `clang++` (`cc`, `c++`, `gcc`, `g++`), `wasm-ld`, `ar`, `nm`, `objdump`, `objcopy`, `strip`, `size`, `ranlib`, `addr2line`, `c++filt`, `llvm-*`: YoWASP's Clang/LLD 22 (target wasm32-unknown-wasip1), run by other/node/clang.js in a node worker ("tool mode").
* We load YoWASP's jco adapter (gen/bundle.js) and assets straight from jsDelivr (pinned version), keep its CLI/clock/stdio parts and replace its in-memory filesystem with VFS descriptors on the blocking syscall channel (permissions + the same open-file locks as WASI). Guest /usr is the read-only resource tree (headers, wasi-libc, libc++); other guest paths are the VFS, resolved against the cwd when the first segment exists there (or nowhere), else the VFS root.
* The driver runs `clang -###` and then each job (like YoWASP's runClang), marks linker outputs executable (WASI has no chmod) and cleans /tmp temporaries.
* C++ exceptions are on by default for clang++ (and with -fexceptions for clang). YoWASP's sysroot has no EH runtime, so those builds use Holepunch's wasi-sdk-style sysroot (npm `wasi-sysroot-wasm32-wasip1`, libc++ 23 with eh/ libc++, libc++abi, libunwind), fetched as its npm tarball and mounted read-only at guest /opt/wasi-sysroot, with `-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false` (standard exnref EH) plus explicit eh/ include and lib paths (clang 22 doesn't pick the multilib itself). `-fno-exceptions` uses YoWASP's sysroot. Needs a browser with Wasm exnref (Firefox 131+, Chrome 137+). Uncaught exceptions print libc++abi's message and exit 134.
* First run downloads ~104 MB (progress on stderr); the page then keeps the compiled modules and resource tarball, so later tool runs start in about a second. Outputs are WASI preview1 binaries: run them with `./prog`.

## Tehboxen: cross-origin isolation in every browser

* `_headers` (COOP same-origin + COEP credentialless) isolates Chrome and desktop Firefox. Browsers without credentialless (Safari/all iOS browsers, Firefox for Android) get isolated by `coi-sw.js`: other/session.js registers it when the page isn't isolated (never inside Webfoundry previews) and reloads once; it adds COOP + COEP require-corp + CORP to same-origin responses and retries cross-origin no-cors loads as CORS.
* Workers must be started with `spawnModuleWorker(url)` (other/node/spawn-worker.js): a blob module that imports the script, so the worker inherits the page's service worker/COEP; plain URL workers get their imports refused under coi-sw.js on WebKit.

## Tehboxen: packages (`pkg`) and ports

* `sudo pkg install vim git clang nodejs npm` (other/pkg.js on other/packages.js): nothing is installed by default. `depends` installs dependencies first (npm → nodejs) and `pkg remove` takes installed dependents along. pkg commands accept unambiguous prefixes plus aliases (`pkg i`, `rm`, `ls`, `show`). node/nodejs/npm/npx and node scripts (shebang or .js) need their packages; WASI programs and the clang tools still run in node workers without them. Packages unpack into the VFS as root (writeMany in parallel batches) with progress bars; `/var/lib/pkg/<name>` holds the version + file list (`pkg list|info|search|remove`). Bump a package's `version` to make boxes reinstall it.
* Running a known command whose package isn't installed prints Ubuntu-style `Command 'vim' not found, but can be installed with: sudo pkg install vim` (exit 127). `git` and the clang toolchain names are gated on their packages; `pkg install clang` prefetches + compiles the YoWASP toolchain on the page and hands the modules to node workers.
* vim/vi/view/ex/vimdiff/rvim/xxd: `/usr/local/bin`, runtime in `/usr/local/share/vim/vim92`; aliases are small sh scripts (our runner doesn't pass argv[0]).
* Host-built WASI artifacts live in `toolchain/`; their recipes in `ports/` (pinned upstream commit + `patches/` + fetch/build/package scripts; `sh ports/build-all.sh`, work dir `.ports-work/`). Never vendor upstream trees; keep our changes as patches there.
* VFS reads/removes need an explicit lease (`vfs.withLock(path, (lease) => vfs.read(path, { lease }), { mode: 'r' })`); errors from a missing lease look like "file not found" if swallowed.

## Tehboxen: terminal for WASI programs

* With a terminal and no piped stdin, a node/WASI process's stdin is the Terminal: `ttyRead`/`ttyPoll`/`ttyMode`/`ttySize` syscalls go to the bash session's line discipline (other/bash.js `attachProcess`): cooked (echo, line editing, Ctrl-D EOF) or raw; Ctrl-C is SIGINT only with ISIG; OPOST off disables newline translation. `isatty()` works (no seek rights on tty stdio); LINES/COLUMNS are exported for programs without TIOCGWINSZ.
* libtehboxen adds `<termios.h>`, `<pwd.h>`/`<grp.h>` (from /etc/passwd, /etc/group), getuid & co. (`tehboxen.ids`), fork/exec/waitpid that fail like a fork-less system, umask/kill, and wraps `stat`/`lstat`/`fstat`/`fstatat` (`--wrap`, added by the driver) so modes and owners come from the VFS (`tehboxen.owner`/`fd_owner`); WASI filestat has neither.

## Tehboxen: threads, bash, libtehboxen

* `-pthread` builds target wasm32-wasip1-threads against toolchain/wasi-threads-sysroot-34.tgz (wasi-sdk 34's threads sysroot + builtins, repackaged: GitHub assets have no CORS), mounted at guest /opt/wasi-threads; linked with shared, imported memory (max 1 GiB).
* Running one: WASI#startThreads (other/node/wasi.js). The process worker is the kernel (fd table, files, exit) and each thread, main included, is a Worker (other/node/wasi-thread.js) on the shared memory; stateful WASI calls are forwarded to the kernel, stateless ones (clocks, random, sleeps) stay in the thread. exit() from any thread ends the process; kill/Ctrl-C terminate all threads.
* toolchain/libtehboxen (built with host clang-17 against wasi-sdk headers): system()/popen()/pclose() over the `tehboxen.system` import (runs the command with the shell), <sys/wait.h>, compat.h (force-included), and a constructor that chdirs wasi-libc to the real cwd (`tehboxen.getcwd`; kept alive by `--export=__tehboxen_init`). The WASM runner orders preopens so "/" wins for tehboxen-built programs.
* `bash` / `sh` / `boxsh` (shell.js cmdBash) run -c strings, scripts, or stdin scripts in a child boxsh; with a terminal and no script they start a nested interactive session. other/bash.js holds the interactive shell (line editing, history, completion, kitty); controllers/Terminal.js is only xterm chrome and closes when bash exits.

## Tehboxen: `npm` / `npx`

* other/npm/: npm 10-style CLI on the page (not in a worker) so installs can bulk-write the VFS (`vfs.writeMany`). Registry: registry.npmjs.org directly (CORS GET with only a safelisted `Accept` header; it 404s preflights, so never add other request headers).
* arborist.js resolves package.json into a hoisted node_modules tree (npm v7+ placement, peer deps installed, dist-tags.latest preferred, package-lock.json versions preferred), skips optional deps for other platforms (we're linux x64 glibc), verifies tarball integrity, links bins into node_modules/.bin, runs lifecycle scripts like vanilla npm (`--ignore-scripts` to skip), writes package-lock.json v3 and node_modules/.package-lock.json.
* Commands: init, install/i/add (-D/-O/-E/--no-save/--omit/--dry-run/--legacy-peer-deps), ci, uninstall, update, ls, view, outdated, run/test/start, exec/npx, version, prefix/root/bin, cache clean, ping. `-g` installs under /usr/local (EACCES unless root, so `sudo npm i -g`).
* The shell runs executables by path or through $PATH (npm scripts get node_modules/.bin): `#!…node` scripts go to `node`, shell scripts run in a subshell with `$1…`, native binaries fail with exit 126 (no native code until the WASM/LLVM toolchain).

## Tehboxen: shell jobs and exit codes

* `cmd &` runs in a subshell as a background job; `$!` is its pid (and the pid of the first process it starts, so it matches `process.pid`). `jobs`, `wait [pid|%n]`, `fg`, `kill [-SIG] pid|%n`; finished jobs print `[n]+  Done` before the next prompt.
* Special parameters: `$?`, `$$`, `$!`, `$#`, `$@`, `$*`, `$1…`, `$_`, `$-`, `$PPID`, `$RANDOM`, `$SECONDS`; `set -- …`, `shift`.
* Multi-operand `cat`/`rm`/`touch`/`mkdir`/`chmod`/`chown`/`chgrp` report each bad operand, keep going and exit 1. Unknown commands exit 127, syntax errors 2, signals 128+n, `exit N` ends the line/script.

## Tehboxen: chat `messages.yaml` is append-only

This project’s Relay / mail threads store an **append-only YAML array** at `messages.yaml` (often hardlinked across participant views).

### Hard rules for agents and scripts

* **Never** rewrite, truncate, or patch an existing `messages.yaml` (no full-array `writeYaml` / `vfs.write` of the whole list, no “read → edit one field → write back”).
* **Only** append new YAML list items via `vfs.append`, `appendYamlItem`, `appendMessage`, or `appendReceipt` (`other/messaging.js`). dbg RPC: `vfs.append`.
* Creating a **new** chat may write an initial empty list once. After that, append only.
* Read receipts are **events in the same file** (`type: receipt`, fields `msg`, `by`, `at`) — not edits to prior message objects, and not a separate receipts file.
* Chat message events use `from: <username>` (never `me`/`them` for user DMs), plus `id`, `time`, `text` / `files`.
* Prefer silence when nothing important happened. A wake that only mood-nudges or noops is success; do not invent messages for every NPC every tick.

See `other/chats.md` for layout and schema.

---

## Tehboxen: vanilla starter world

Fresh VFS boot seeds **only** `places/safehouse` (name + `about`, `picture: ""`, empty presence; new accounts are placed there). **No cover art, no other places, no cast.** Players / world packs design everything else. Do not reintroduce demo hideouts, targets or NPCs into `vfs` boot.

Rich worlds (crews, hideouts, target networks, art) live **only in the live VFS** and are exported as separate world packs. **Never** put world-specific places, cast, or lore into host JS (`other/*.js`, controllers, boot). Host code may only provide generic engines (VFS, places ACL, NPC provision helpers, duration wakes). Author worlds via dbg / scp / in-VFS YAML.

---

## Tehboxen: place access (`allowed_users`)

`places/<id>/place.yaml` may include `allowed_users: [username, …]`.

* **Prop omitted / null** → **public** (anyone may enter).
* **Array present** → only listed usernames may enter (homes, staff rooms, invite-only). Empty array → nobody.
* `moveTo` enforces this (unless `force` for world-authoring repairs).
* Places app `loadGraph({ viewer })` hides places the viewer cannot enter and drops edges into them, so private homes and staff-only rooms do not appear as travel targets.
* File ownership is separate: a place owner (e.g. `lulu` owns the bistro tree) can be the only writer via uid + mode `0644`/`0755` while the place stays world-readable; that does **not** require a group.

---

## Tehboxen: every NPC is a real user

**Every NPC is a full Tehboxen user**, not a YAML-only ghost.

* Create with `provisionNpc({ id, gecos, … })` (`other/npc.js`) — allocates uid/gid, `home/<id>/`, `profile.yaml`, `.relay/`, world-group membership, and a `location` symlink.
* Username = VFS id (`sam`, `maya`, …). Presence lists, Relay peers, mail, shell `user=`, and dbg RPCs all use that id.
* Pets / props (e.g. Sam’s dog Lars) are **not** users unless they need a login; keep them in the owner’s profile / place lore.
* Reserved ids stay reserved: `root`, `nobody`, `grok`, `guest` (plus other/accounts.js RESERVED_NAMES). Player handles are chosen at the login screen.

Never invent an NPC that only exists as a name inside someone else’s profile without `home/<id>/` and a passwd entry.

---

## Tehboxen: character pictures (portraits / avatars)

Do **not** put a global shared gallery of every NPC’s face. Keep art in each user’s home; share only via hardlinks when contacts are added.

### Layout

* `home/<user>/Pictures/portrait.jpg` — main character portrait (and other stills under `Pictures/`).
* `home/<user>/.relay/avatar.jpg` — Relay-facing avatar. Prefer a **hardlink** to `Pictures/portrait.jpg` (same inode) so one update refreshes both.
* Other apps may mirror the same pattern (`~/.mail/avatar.jpg`, …) hardlinked to the portrait.

### Sharing on contact add

* When A adds B (or `createChat` / `addContact` runs), hardlink  
  `home/<B>/.relay/avatar.jpg` → `home/<A>/.relay/<B>/avatar.jpg`  
  (and the symmetric link for B’s view of A).
* Contact `profile.yaml` may set `avatar: avatar.jpg` (relative to the contact dir). UI resolves that path; it must not need to read the peer’s `$HOME`.
* If the peer has no avatar yet, skip the link (no error). Re-run link when the avatar appears.

### Modes and hardlink write-through

* Portrait / avatar files: mode **`0644`**, owned by the subject user. Contacts can **read** the hardlink; they cannot overwrite it (no other-write). They may `rm` the hardlink in their own contact dir (directory write) without deleting the subject’s inode while `nlink > 1`.
* VFS `write` / `writeBlob` on a path that already has an `ino` **updates inode content in place** and notifies every hardlinked path — so changing `~/.relay/avatar.jpg` (or the portrait it shares) updates all contact hardlinks automatically.
* **Do not** `rm` + recreate the canonical avatar if you want links to stay live; that allocates a new inode and orphans old hardlinks. Overwrite in place, or after recreate call `linkPeerAvatar` / `addContact` again for each contact.

### Generation

* Consistent with place art (see place pictures). Variations of one character: image-to-image from `portrait.jpg`, not fresh from-scratch rolls.

---

## Tehboxen: place pictures

World-pack / designed places under `places/<id>/` should have art the Places map can show as the bubble fill. The vanilla `safehouse` starter is allowed to ship with **no** `pictures/` and empty `picture:` so the player can decorate.

### Layout

* `places/<id>/pictures/cover.jpg` — **required for designed places**. Places bubble image. Prefer outdoors establishing shot when the place has a facade.
* `places/<id>/pictures/` — keep a few more stills (outdoor angles, indoor rooms) as material for later image-to-image.
* `places/<id>/place.yaml` `picture:` field should point at the cover (default `places/<id>/pictures/cover.jpg` when omitted and the file exists).

### Generation rules

* One consistent style for all place plates (moody cyberpunk / hacker-den lighting, readable silhouettes).
* **Outdoors:** generate the first exterior from scratch once. Every further outdoor angle/variation must be **image-to-image** from that master (or from another outdoor derived from it). Never re-roll a fresh exterior for the same place — designs drift.
* **Indoors:** same rule within one environment (dining room, kitchen, bedroom, …). First indoor plate may be from scratch *or* style-locked i2i from the outdoor master; further shots of that same room are i2i only.
* **Multi-floor / multi-environment** places (kitchen vs dining floor, basement club, rooftop): each distinct environment may have its own first plate; variations inside that environment stay i2i.
* Prefer picking the strongest outdoor as `cover.jpg` unless the place is indoors-only.

---

## Tehboxen: NPC profiles = natural-language state machines

`home/<npc>/profile.yaml` drives life (after `provisionNpc`). **Do not put hard clock schedules** (`schedule: [{ at: '09:00', … }]`) in profiles.

### Required shape

* Live FSM state is **`runtime.state`** (no `state_machine.initial_state`). Fresh profiles start at `runtime.state: start`.
* Optional **`runtime.state_until`** (ISO timestamp) — wake deadline for open-ended states (`sleeping`, end-of-shift `at_work`, …). Prefer `setNpcState(user, state, { until })`. It does **not** name the next state; when it fires, the agent evaluates NL transitions as usual.
* `start` fans out with natural-language **triggers**. On first enact / cold wake, write the new `runtime.state` (and `state_entered_at` / `state_until` as needed).
* Each state may include:
  * `description` — what being in this state means (NL).
  * `behaviors` — optional NL hints.
  * `transitions[]` — `{ to, trigger }` where `trigger` is natural language the agent interprets. Optional declarative **`on_message: { match, from?, keepUntil? }`** — when an inbound chat text matches `match` (regex string; `(?i)` / `/pat/i` ok; default case-insensitive), `appendMessage` into `home/<npc>/…/messages.yaml` calls `considerMessageTransition` and applies that edge (first match wins). `from` may restrict sender; `keepUntil` defaults true so shift-end deadlines survive short substates.
  * `duration: { min_s, max_s }` — optional short beat window. Omit on `start` / `sleeping`.
  * `flags` — e.g. `phone_attention: true|false`.
* **Duration vs until:** `npc-events` schedules the **sooner** of `duration` and `runtime.state_until`. Short work substates (`cooking`, …) use `duration` and should call `setNpcState(..., { keepUntil: true })` so a shift-end `state_until` still applies when they return to `at_work`. End-of-shift is just another `state_due` — agent picks `leaving_work` / `commute_home` / etc. from triggers.
* Intra-work graphs are first-class: e.g. `order_received` → `cooking` → `deliver_order` → `chit_chat`. Message edges can jump into that graph (e.g. Relay food order → `cooking`).
* `runtime.mood` / `drives` / `energy` / `relations` stay numeric as today.

### Phone / proactive chat

When `flags.phone_attention` is true (default if omitted), an enacting agent **may** preemptively message existing contacts from mood + scene — but must roll a **random chance to stay silent** so messaging compulsion does not fire every wake. When `phone_attention` is false (e.g. `sleeping`, deep `cooking`), the NPC is **offline**: do not initiate Relay and **do not answer** until they wake into a phone-attentive state. `appendMessage` **throws `EPHONE_OFF`** if `from` is an NPC whose current state has `phone_attention: false` (the player can still send). `bin/watch-npc.mjs` defers `npc_message` wakes while offline and flushes unread after a later attentive `state_due`. Relay UI shows `online` / `offline` from this flag.

To wipe a chat history without removing the contact, use `clearDmMessages(a, b)`. `removeDm` deletes the contact relationship entirely.

---

## Tehboxen: NPC automation policy

Lanes — do not mix them:

1. **Player outbound Relay** — `node bin/watch-relay.mjs` (`npm run watch-relay`) tails `.tehboxen-dbg/events.ndjson` and prints `ACTION_REQUIRED: relay|<name>|<folderId>|<text>|<msgKey>|<dm|group>|<player>` when a player (users db `human: true`) sends in `home/<player>/.relay/<folderId>/messages.yaml`. Reply in character as `<folderId>`. Append-only `messages.yaml`.
2. **NPC wakes (Node)** — `node bin/watch-npc.mjs` tails `.tehboxen-dbg/events.ndjson` and prints stdout lines for Grok Build `monitor`:
   * `ACTION_REQUIRED: npc_message|<npc>|<peer>|<text>|<msgKey>|<dm|group>` — an NPC (`user` is not a player) received a message from someone other than the player in `home/<npc>/.relay/<peer>/messages.yaml` (the player→NPC is lane 1; hardlink fan-out wakes on the NPC path only).
   * `ACTION_REQUIRED: npc_state_due|<npc>|<state>|<at>|<token>` — `other/npc-events.js` appended a `state_due` to `var/npc_events.yaml` after a duration wait, **or** an immediate wake when `runtime.state` is `start` (fan-out: agent picks the right life state from local time + NL triggers, then writes `runtime.state`). The watcher also scans for NPCs still in `start` on startup.
3. **Presence monitor** — fires when `places/<id>/presence.yaml` changes. Update mood / FSM / optional move. If **the player is co-located** with NPCs, advance the scene with one short beat; if the player is absent, no chat.
4. **Silent soft sim** (optional, infrequent) — mood/energy only. **Never** send messages. Noop is success.

Start the NPC watcher with dbgserver + preview connected, then:

```text
monitor(command="node bin/watch-npc.mjs", persistent=true)
```

Never run a 1-minute life loop. Agents invent speech only from Relay / NPC wakes, presence co-location beats, duration `state_due` enacts, or explicit user direction.
