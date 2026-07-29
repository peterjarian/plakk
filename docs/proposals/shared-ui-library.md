# Shared UI Library for Desktop and Web

Status: Accepted; foundation implemented

## Decision summary

Keep one private `@plakk/ui` package for the React DOM interface shared by the
Electron renderer and the web app. Organize it around two levels of reusable UI
artifacts:

1. **Primitives** own reusable behavior, accessibility, and Plakk styling.
2. **Components** compose primitives into reusable interface elements.

Reusable product components live in `@plakk/ui`; pages, routing, data loading,
Effect runtimes, IPC, browser APIs, Electron window behavior, and global
provider assembly remain app-owned. Product components are intentionally
opinionated: they own stable Plakk copy, semantics, layout, and styling. They
expose only the seams backed by a real host difference.

Do not split out a second "web UI" or "desktop UI" package. Both current
surfaces render React into the DOM—Electron renderers follow web standards
([Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model#the-renderer-process))—so
that would duplicate the design system without introducing a real platform
seam.

## Why

[components.build](https://www.components.build/) defines a useful artifact
taxonomy: an unstyled primitive owns behavior and accessibility; a component
adds reusable visual design; and a block is an opinionated composition for a
concrete product use case. Blocks accept data through props and expose domain
logic through handlers rather than hiding fetches behind the UI
([definitions](https://www.components.build/definitions)).

That model fits Plakk if we draw the seam at host-neutral React DOM rendering:

```text
                         @plakk/ui
                 primitives → components
                          ↑
                props, slots, events
                          ↑
             ┌────────────────┴────────────────┐
             │                                 │
      apps/desktop renderer                apps/web
      blocks + native adapters       blocks + web adapters
```

The `@plakk/ui` module becomes deep when callers can obtain consistent
semantics, keyboard behavior, focus handling, tokens, and Plakk presentation
through a small props interface. It becomes shallow when it merely renames a
`div`, or when callers must understand its internal DOM and host assumptions to
use it correctly.

## Goals

- Render the same Plakk UI in desktop and web where two real callers share the
  same user intention.
- Make UI artifacts accessible, composable, typed, themeable, and safe for web
  server rendering.
- Keep product presentation consistent while allowing hosts to vary navigation,
  persistence, clipboard, file acquisition, external-link handling, and window
  chrome.
- Give every shared artifact an intentional public interface and an observable
  test surface.
- Keep changes close to the existing desktop loop; share only behavior that
  desktop and web actually use.

## Non-goals

- Sharing Electron main/preload code or browser/server runtime code through the
  UI package.
- Making `@plakk/ui` framework-agnostic or React Native compatible. It is a
  React DOM package.
- Publishing a public npm package, registry, or standalone design system site
  now.
- Moving complete pages, routes, loaders, or app shells into `@plakk/ui`.
- Adding a platform interface for every browser call in anticipation of future
  hosts.

## Pre-implementation ownership audit

The repo already has the correct top-level owners:

- `packages/ui` owns shared product surface code.
- `packages/shared` owns product values that cross packages or processes.
- `packages/client-runtime` owns the local client model and behavior.
- `apps/desktop` owns Electron lifecycle, IPC, native sources, and desktop
  renderer assembly.
- `apps/web` owns web routing, server rendering, request lifecycle, and browser
  assembly.

Several current details weaken that separation:

1. `packages/ui/src/styles/globals.css` explicitly scans
   `apps/desktop/src/renderer` and defines the Electron-only `drag-region`
   utility. The shared package therefore knows one consumer and the web app
   cannot adopt it cleanly.
2. `AppHeader` always includes `drag-region`, so reusable product presentation
   also owns native window behavior.
3. `SnippetRowItem` is declared by a rendered artifact, while
   `apps/desktop/src/renderer/hooks/useSnippets.ts` imports it to build renderer
   state. This reverses ownership: data projection depends on its current view.
4. `SnippetRowItem` is derived from the transport-oriented `ApiSnippet` even
   though the client already has a canonical local `Snippet` model.
5. Wildcard package exports expose the folder layout as the public interface.
   Renaming or reorganizing an internal file is therefore a consumer change.
6. The desktop app imports shared global CSS, while the web app independently
   imports bare Tailwind CSS. The two surfaces do not yet share tokens, reset,
   or theme behavior.

These are ownership problems rather than reasons to replace the existing
Base UI, shadcn, Tailwind, or CSS-variable choices.

## Proposed package shape

Start with folders, not more packages:

```text
packages/ui/
├── src/
│   ├── primitives/
│   │   ├── button.tsx
│   │   ├── dialog.tsx
│   │   └── ...
│   ├── components/
│   │   ├── app-header.tsx
│   │   ├── settings-section.tsx
│   │   └── ...
│   ├── icons/
│   ├── lib/
│   └── styles/
│       └── tokens.css
├── components.json
└── package.json
```

This taxonomy describes reuse, not visual complexity:

- A **primitive** is a styled wrapper over Base UI or a native element and owns
  one reusable interaction concern.
- A **component** is reusable Plakk visual structure without product workflow
  or host integration.
- A **product component** knows Plakk terminology and presentation rules. It
  lives in `@plakk/ui` when it is a reusable part of a screen, such as the
  snippet composer, snippet list, or settings composition.
- A **page** belongs to an app because it coordinates routes, runtime state,
  commands, errors, and host capabilities.

Avoid a generic `platform` prop or a universal `HostAdapter` object. Those
interfaces would expose every possible variation to every artifact. Prefer a
callback or tightly constrained child at the exact point where behavior varies.
Do not expose product copy or arbitrary internal pieces as configuration merely
because compound components make that possible. For example,
`SnippetComposer.Submit` always renders “Add”; hosts may supply the native file
control to `SnippetComposer.Attachment`, but do not rename or restyle the
attachment affordance.

```tsx
<AppHeader
  user={account}
  storageAction={<StorageAction status={storageStatus} />}
  onSettingsClick={() => navigate({ to: "/settings" })}
  onSignOutClick={() => signOut()}
/>
```

The desktop caller may implement the callbacks with IPC-backed navigation; the
web caller may use TanStack Router. `AppHeader` owns the Plakk brand and account
menu—including “Settings” and “Sign out”—while the host owns how those
intentions are carried out.

## Interface rules

### Primitives and components

- Wrap one meaningful element or accessible primitive where practical.
- Extend and forward the underlying element's props and ref.
- Export a named `<ArtifactName>Props` type.
- Merge `className` last so callers can predictably customize styling.
- Use variants for a small closed set of supported appearances.
- Use composition, named slots, or compound subcomponents instead of growing
  bags of optional presentation props.
- Expose visual state through stable `data-state`, `data-slot`, and related
  attributes rather than state-specific class props.
- Support controlled and uncontrolled state where both modes represent real
  use cases.

These rules follow the components.build guidance on
[composition](https://www.components.build/composition),
[types](https://www.components.build/types),
[state](https://www.components.build/state), and
[data attributes](https://www.components.build/data-attributes).

Do not add polymorphism by default. `asChild` or a `render` prop is justified
when two real callers need different underlying elements while preserving the
same semantics. A button must not become a link merely to avoid styling an
anchor.

### Product blocks

Product components are deliberately narrower than primitives. They expose
compound parts for meaningful screen composition, but they do not make stable
product decisions configurable. Their labels, layout, and visual variants stay
library-owned. A host-specific control may be injected only where the platform
must perform genuinely different work; the product component styles and labels
that control.

They may depend on canonical presentation value types from `@plakk/shared`, but
must not:

- import app modules;
- call `window.ipc`, `fetch`, router hooks, or auth hooks;
- own Effect runtime execution;
- fetch or mutate product data;
- manufacture a second domain model for renderer convenience;
- depend on client-runtime services;
- read browser globals at module evaluation time.

Product components receive immutable data and intention-level callbacks. Async
progress and errors remain explicit input state; a component does not infer
command success.

For snippets, first move the canonical surface projection out of
`SnippetRow.tsx`. Prefer one of these existing owners:

- `@plakk/client-runtime` when the projection is a stable client read model
  shared by all surfaces; or
- the app when the projection is genuinely specific to that page.

Keep the block app-owned until the web implementation has the same needs.
`@plakk/ui` may eventually define `SnippetRowProps`, but it should never own
the Local Snippet model that the rest of a renderer consumes.

### Host-owned composition

Each app owns:

- root providers and their lifecycle;
- route/page modules;
- loading data and invoking commands;
- navigation and external links;
- clipboard and file acquisition;
- URL/object URL lifetime;
- Electron drag regions and native window controls;
- server/client boundaries and hydration;
- choosing and persisting the active theme.

A small shared `UiProvider` is acceptable only if both apps need the same
provider composition, such as tooltip defaults. It must not absorb auth, client
runtime, routing, or theme persistence.

## Styling and theming

Use semantic CSS custom properties as the public theme interface. Components
should consume meanings such as `background`, `foreground`, `muted`, and
`destructive`, not raw palette positions. This separates usage from the theme's
actual values, as recommended by
[components.build's design-token guidance](https://www.components.build/design-tokens).

Split shared CSS responsibility:

- `tokens.css` declares Plakk's semantic token names and light/dark values.
- Each app owns a Tailwind entry point that imports Tailwind and the shared
  tokens, scans both `packages/ui/src` and its own source, and applies the
  minimal shared reset.
- No shared stylesheet names a consumer app.
- Desktop-only utilities such as `-webkit-app-region` live in the desktop
  renderer stylesheet or a desktop-owned wrapper.

Continue using `cn` and CVA for predictable caller overrides and documented
variants. The components.build styling model likewise recommends default
classes first and caller classes last
([styling](https://www.components.build/styling)).

The theme selector should be host-neutral: a documented class or data attribute
on `<html>`. Desktop can synchronize that selector with native appearance; web
can set it during document rendering and update it from web preferences.

## Accessibility and server-rendering baseline

Accessibility belongs inside the reusable artifact, not in each host:

- use native semantics before ARIA;
- specify keyboard behavior for composite widgets;
- manage focus entry, trapping, teardown, and return;
- preserve accessible names when rendering icons;
- make loading and failure state perceivable without color alone.

This is a baseline requirement in the
[components.build accessibility guidance](https://www.components.build/accessibility).
Base UI should continue to own the difficult interaction mechanics where it
already supplies them.

All shared artifacts must also be safe to render through the web app's server
path:

- no `window`, `document`, `navigator`, `URL`, or storage access during module
  evaluation or render;
- deterministic initial markup;
- portals and layout measurement only through effects or primitive-supported
  lifecycle;
- browser-only resources passed in as values, such as a thumbnail URL.

Event handlers may use DOM event state when the behavior is genuinely common
to both hosts. For example, keyboard movement inside a rendered list is shared
UI behavior; creating and revoking image object URLs is host behavior.

## Public exports

Replace broad wildcard exports with explicit subpath exports for adopted
artifacts:

```json
{
  "exports": {
    "./tokens.css": "./src/styles/tokens.css",
    "./primitives/button": "./src/primitives/button.tsx",
    "./primitives/dialog": "./src/primitives/dialog.tsx",
    "./components/account-menu": "./src/components/account-menu.tsx"
  }
}
```

Explicit exports make the package interface intentional and allow internals to
move without changing callers. Do not add a single root barrel: importing one
button should not make a server or bundler traverse every UI artifact.

Keep the package private and source-distributed inside the workspace for now.
There is no need for a separate build or public npm distribution until another
repository becomes a real consumer.

## Verification

Test through the public interface:

- primitive interaction tests cover semantics, keyboard behavior, focus, state
  attributes, and controlled/uncontrolled behavior;
- component tests cover rendered intentions, composition slots, and action
  callbacks;
- SSR smoke tests render every public artifact without browser globals;
- one desktop page and one web page exercise the same product block;
- targeted accessibility checks cover the critical interactive primitives;
- visual examples cover light/dark tokens and supported variants.

Avoid snapshotting entire class strings. Assert semantics, stable data
attributes, accessible names, state, and callback outcomes. Internal tests that
duplicate Base UI's own behavior do not add value.

Repository completion remains gated by `vp check` and `vp run typecheck`.
User-visible desktop behavior should also pass the real Electron end-to-end
flow when a migration changes it.

## Migration plan

### Phase 1: make the stylesheet host-neutral

1. Extract the semantic tokens from the current shared global stylesheet.
2. Move `drag-region` to `apps/desktop`.
3. Remove the desktop source path from shared CSS.
4. Add `@plakk/ui` and a matching `components.json` to `apps/web`.
5. Give both apps an app-owned Tailwind entry point that scans itself and
   `packages/ui/src`.
6. Prove identical tokens in a minimal web route before moving product UI.

### Phase 2: make the package interface intentional

1. Classify existing artifacts as primitives, components, or app-owned product
   blocks.
2. Add explicit exports and update imports.
3. Export prop types and normalize prop/ref/class forwarding.
4. Add SSR smoke coverage for exported artifacts.

This phase is primarily mechanical; avoid redesigning every visual artifact at
once.

### Phase 3: remove reverse model ownership

1. Move the shared Local Snippet surface/read type to its product owner.
2. Make desktop and web project their runtime state into that canonical value
   or into page-local props.
3. Keep `SnippetRow` limited to rendering state and emitting intentions.
4. Delete `SnippetRowItem` once no non-UI code imports it.

### Phase 4: prove sharing with a vertical slice

Use the Snippet list as the first candidate shared slice because it already
contains product presentation, actions, loading/failure states, and keyboard
behavior:

1. Compose the same `@plakk/ui` product components into each app-owned page.
2. Supply desktop callbacks through IPC and web callbacks through the web
   client/router.
3. Keep each page's loading, command, and error orchestration app-owned.
4. Add cross-host behavior fixtures as web workflows adopt the components.

## Acceptance criteria

- `@plakk/ui` contains no imports from `apps/*` and no Electron/native globals.
- Shared CSS contains no consumer source paths or desktop-only utilities.
- Both desktop and web import the same semantic tokens and base component
  styles.
- No runtime hook or domain module imports a type from a rendered UI artifact.
- Product components accept data and intention-level callbacks without fetching
  or mutating, and expose no configuration for stable product copy.
- Public artifacts have explicit exports and exported prop types.
- Public artifacts render in the web server path without browser-global errors.
- Shared interactive behavior has semantic and keyboard-focused tests.
- `vp check` and `vp run typecheck` pass.

## Implemented foundation

The initial implementation completed the ownership and package work needed
before sharing a web product block:

- `@plakk/ui` exposes explicit `primitives/*`, `components/*`, icon, utility,
  and foundation-style subpaths.
- Desktop and web own separate Tailwind entry points and scan their own source
  plus `packages/ui/src`.
- Electron drag regions and scrollbar utilities are desktop-owned.
- `AppHeader`, `SnippetComposer`, and `SnippetList` own stable product copy and
  presentation while accepting host actions and narrowly scoped native
  controls.
- `SnippetComposer`, `SnippetList`, and settings composition use namespaced
  compound APIs.
- Public primitive and component prop types are exported.
- The desktop renderer no longer imports its Snippet read model from a rendered
  UI artifact.
- Web is configured as an `@plakk/ui` and shadcn monorepo consumer.

## Consequences

The design system and reusable product presentation gain one owner, while
platform variation stays visible at app composition sites. Web adoption becomes
an adapter and page-assembly problem rather than a fork of the desktop UI.

The cost is that host pages will retain some orchestration and callback wiring.
That duplication is intentional until repeated behavior proves another real
seam. We should share user intentions and presentation, not conceal different
runtime models behind a large hypothetical platform abstraction.

## Research basis

The supporting source review, repository observations, and derived
recommendations are recorded in
[components-build-shared-ui.md](../research/components-build-shared-ui.md).
