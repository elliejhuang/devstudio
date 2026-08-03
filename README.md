# DevStudio

A dev-only overlay for reviewing a page in place. Click anything to leave a note,
check the layout at real device widths, then hand the whole thing to an AI coding
agent as Markdown.

It exists because the loop between *noticing* something is wrong and *describing*
it precisely enough to fix is where design feedback usually dies — screenshots
lose the selector, and "the spacing under the heading looks off" loses which
heading. DevStudio keeps the note attached to the element and exports both.

## Two modes

**View** — a breakpoint switcher: Phone (390), Narrow (1024), Wide (1440).

Each preview is a real `<iframe>`, not a width-constrained `<div>`. That
distinction is the entire point: media queries answer to the viewport, so
narrowing an element inside a wide window still serves it desktop CSS. You would
be looking at a thin desktop layout and calling it mobile. The framed document
genuinely reports `innerWidth: 390` and lays out accordingly. Widths that don't
fit the real window scale down, with the scale shown in the label.

**Annotate** — an element picker. Click anything to attach a note. Notes
accumulate per element rather than replacing each other, and each one is
separately deletable. Type sliders (font-size, weight, letter-spacing,
line-height) preview a change live on the real element, and appear only when the
element has direct text of its own.

`Esc` switches modes. With a preview or a note panel open it closes that first.

**Copy brief** exports everything as Markdown, grouped by page:

```markdown
## /about
- **section.reach** ("Let's talk! Reach out to…")
  Comment: put these on the same line, the fade looks sloppy
  - font-size: 18px → 21px
```

Paste that into Claude Code, Cursor, or whatever you use.

## Install

### Script tag — any project, any framework

```html
<!-- only in development -->
<script src="/devstudio.js"></script>
```

Copy `dist/devstudio.js` into your public/static directory. It self-mounts on
load, injects its own styles, and needs nothing else. React is bundled in, so it
doesn't care what your project is built with.

### Bookmarklet — any page, including ones you don't control

```js
javascript:(()=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/YOUR-USER/devstudio@main/dist/devstudio.js';document.head.appendChild(s)})()
```

Save that as a bookmark. This is the only form that works against a deployed
site, or on a phone, without a dev server.

### As a dependency

```sh
npm i -D github:YOUR-USER/devstudio
```

```js
if (import.meta.env.DEV) import("devstudio");
```

Guard the import yourself — the package deliberately doesn't try to detect
"development", because the bookmarklet's whole purpose is running somewhere that
looks like production. Loading the file *is* the opt-in.

Astro projects can't use a `client:` directive for this: a static import puts the
whole thing in the production bundle even when the component never renders. Mount
it from a script instead, so the dead branch is eliminated at build time:

```astro
<script>
  if (import.meta.env.DEV) await import("devstudio");
</script>
```

## API

Auto-mounting covers almost everything, but the entry also exports:

```ts
mountDevStudio(): void      // no-op if already mounted
unmountDevStudio(): void    // for a bookmarklet that toggles
isDevStudioMounted(): boolean
```

## Notes

Annotations persist to `localStorage` under `devstudio:annotations`, so they
survive reloads but are per-origin — notes taken on `localhost:4321` won't appear
on a deployed URL.

The overlay skips mounting when the URL carries `?ds-preview=1`, which is the
flag it puts on its own breakpoint iframes. Without that, a preview would render
a second toolbar over itself and could open a third iframe inside that.

## Build

```sh
npm install
npm run build     # → dist/devstudio.js
```

One IIFE, ~66kb gzipped, styles inlined. Single file on purpose: a bookmarklet
has nowhere to put a sidecar stylesheet.
