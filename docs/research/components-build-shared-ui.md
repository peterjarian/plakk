# Shared desktop/web UI informed by components.build

Date: 2026-07-29

Repository observations in this note describe the checkout before the shared UI
foundation was implemented later that day.

## Question

How should Plakk structure `@plakk/ui` so that desktop and web can use the
same clean React components?

This is a research note, not an architectural decision. The first section
records claims from primary sources and observations from the current
repository. The second section derives recommendations for Plakk.

## Sourced findings

### The desktop renderer and web app share the right execution model

Electron says renderer-process code behaves according to web standards and
that window UI should use the same tools and paradigms as web UI
([Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model#the-renderer-process)).
Therefore, Plakk does not need separate desktop and web implementations of
ordinary React/DOM components. Native Electron capabilities still belong
outside the shared component implementation.

### components.build defines useful artifact boundaries

The specification distinguishes:

- a **primitive**: unstyled behavior and accessibility;
- a **component**: a styled reusable UI unit;
- a **pattern**: documentation of a recurring UI/UX solution;
- a **block**: an opinionated, production-ready composition for a concrete use
  case;
- a **page/template**: route or application structure;
- a **utility**: non-visual composition support.

It says blocks should accept data through props and should not hide fetching
without a documented adapter
([components.build definitions](https://www.components.build/definitions)).
This vocabulary is more useful for Plakk than treating every `.tsx` file as the
same kind of reusable component.

The spec's core principles are composition, accessibility by default,
customizability/theming, low dependency weight, transparent source, and
documentation
([components.build principles](https://www.components.build/principles)).
Its composition guidance favors cooperating subcomponents over a single
component with many data, layout, and behavior props
([components.build composition](https://www.components.build/composition)).

### The public API should expose DOM semantics and state, not platform services

components.build recommends that an exported component ideally wrap one
HTML/JSX element, extend that element's native attributes, and split structured
DOM into independently customizable parts
([components.build types](https://www.components.build/types)). It also
recommends `data-state` for visual state and `data-slot` for identifying parts,
rather than adding state-specific class props
([components.build data attributes](https://www.components.build/data-attributes)).

For state ownership, components.build recommends controlled and uncontrolled
modes where both are meaningful
([components.build state](https://www.components.build/state)). React's own
guidance describes controlled components as flexible because the parent owns
important state, and recommends one source of truth for each state
([React: Sharing State Between Components](https://react.dev/learn/sharing-state-between-components)).

### Base UI is already the correct behavioral foundation

Base UI describes itself as an unstyled, accessible, composable React library:
it does not bundle CSS or prescribe a styling engine, and consumers can access
each component node
([Base UI overview](https://base-ui.com/react/overview/about)). Its primitives
handle ARIA, keyboard navigation, pointer interactions, and focus management,
while the application remains responsible for visible focus, contrast, labels,
and testing
([Base UI accessibility](https://base-ui.com/react/overview/accessibility)).

That aligns with `packages/ui`, which already builds dialog, select, menu,
switch, checkbox, and tooltip components on `@base-ui/react`
([package dependencies](../../packages/ui/package.json),
[current primitives](../../packages/ui/src/primitives)).

### Semantic tokens and explicit source scanning make one theme portable

components.build recommends semantic CSS variables that separate role from
literal appearance, such as background/foreground and
primary/primary-foreground pairs
([components.build design tokens](https://www.components.build/design-tokens)).
It recommends merging default and consumer Tailwind classes so consumers can
override styles without specificity fights
([components.build styling](https://www.components.build/styling)).

Tailwind v4 scans source as text, requires complete class names, and supports
explicit `@source` paths for shared libraries and monorepos
([Tailwind source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files)).
At the time of research, Plakk's shared stylesheet scanned
`apps/desktop/src/renderer` explicitly but did not scan the web application
source.

### shadcn supports the package shape Plakk already started

shadcn's monorepo guide places reusable UI in `packages/ui`, app-owned
compositions in each app, and uses workspace exports for shared imports. It
also requires a `components.json` in each consuming workspace so the CLI can
route primitives to the UI package and blocks to the app
([shadcn monorepo guide](https://ui.shadcn.com/docs/monorepo)).

Plakk already has `packages/ui/components.json` and subpath exports, but
`apps/web` has neither an `@plakk/ui` dependency nor its own `components.json`
([UI package](../../packages/ui/package.json),
[web package](../../apps/web/package.json)).

## Pre-implementation Plakk boundary problems

These are repository observations, not claims from components.build:

1. `@plakk/ui` currently mixes reusable primitives with product-aware
   components. `AppHeader` imports the shared `User` domain type, and
   `SnippetRow` imports API/local-storage domain types and Effect date utilities
   ([AppHeader](../../packages/ui/src/components/AppHeader.tsx),
   [SnippetRow](../../packages/ui/src/components/SnippetRow.tsx)).
2. Desktop ownership leaks into the shared theme. `AppHeader` always applies
   `drag-region`, while `globals.css` implements it with
   `-webkit-app-region`
   ([AppHeader](../../packages/ui/src/components/AppHeader.tsx)).
3. The shared Tailwind entry point owns a desktop consumer path. Adding web
   would require another app path, making the library stylesheet aware of every
   host.
4. Desktop imports both low-level primitives and product components from the
   same `components/*` namespace, so package structure does not communicate
   portability or ownership
   ([desktop imports](../../apps/desktop/src/renderer)).

## Recommendations for Plakk

The recommendations below are inferences from the sources and current code.

### 1. Keep one UI package, but establish three explicit layers

Use these ownership rules inside `@plakk/ui`:

```text
@plakk/ui/primitives/*  accessible, styled DOM building blocks
@plakk/ui/components/* reusable product-neutral compositions
@plakk/ui/styles.css    tokens, reset/base layer, primitive styles
```

Keep route/page composition, data loading, authentication, IPC, navigation, and
native shell behavior in `apps/desktop` and `apps/web`. A product-shaped view
can be shared later only after both apps use the same view contract; do not put
platform adapters in the UI package to force reuse.

The decisive import rule should be:

> `@plakk/ui` may depend on React, DOM-oriented Base UI, icons, class helpers,
> and presentation-only types. It may not import Electron, preload globals,
> routers, server functions, client-runtime services, or host data hooks.

### 2. Make shared components props-in/events-out

Components should accept serializable display data, React nodes/slots, state,
and intention callbacks. Hosts should adapt their real domain/runtime data at
the app boundary.

Prefer:

```tsx
<AccountMenu
  displayName={accountName}
  email={accountEmail}
  onOpenSettings={openSettings}
  onSignOut={signOut}
/>
```

over a UI component importing an application `User`, router, or desktop IPC
service. Preserve semantic domain types only when the type is genuinely the
same public presentation contract on both hosts; do not mechanically replace
every useful type with strings.

For interactive primitives, preserve Base UI's controlled/uncontrolled API
instead of wrapping it in host state. Use native element props, `className`,
slots/compound parts, `data-state`, and `data-slot` as the stable customization
surface.

### 3. Move desktop chrome out of shared components and styles

`drag-region` is native window-chrome policy, not part of a reusable header.
The desktop host should add a desktop-owned wrapper/class or pass a
desktop-only `className`. The shared stylesheet should not contain
`-webkit-app-region`; put that rule in a desktop stylesheet.

The same rule applies to tray sizing, window controls, protocol links, and IPC
availability. Share their visual children if useful, but let the desktop app
own the shell.

### 4. Separate the theme contract from each app's Tailwind entry point

Use one shared semantic-token/theme file as the contract, but let each app own
the CSS entry point that:

- imports Tailwind and the shared theme;
- explicitly scans `packages/ui/src`;
- scans that app's own source;
- adds host-only utilities.

This avoids an inverted dependency where `packages/ui` names every consuming
app. Desktop and web should apply the same token names and can override token
values at their root when a host genuinely needs a different theme.

Keep variant-to-class mappings static so Tailwind can detect every complete
class name. Continue merging default classes with consumer `className` via the
existing `cn` helper.

### 5. Configure web as a real consumer before expanding abstraction

The first proof should be a small vertical slice:

1. Add `@plakk/ui` as a web workspace dependency.
2. Add `apps/web/components.json` matching the UI package's shadcn style,
   icon library, and base color.
3. Give web an app-owned Tailwind entry point that imports shared tokens and
   scans both web and `packages/ui`.
4. Render a few primitives in both desktop and web.
5. Move desktop-only drag styling out of `@plakk/ui`.
6. Only then extract one product-neutral composition used by both hosts.

Do not start with a second UI package, a registry, npm publishing, or a generic
cross-platform adapter system. Both current consumers are in the same monorepo
and render React DOM, so workspace source distribution is the smallest adequate
model.

### 6. Add library-level acceptance criteria

For every shared primitive/component:

- Typecheck usage from both apps.
- Exercise semantic markup and core visual states in component tests.
- Test keyboard/focus behavior at the wrapper boundary; rely on Base UI for its
  internals, but verify Plakk has not broken them.
- Include at least one light/dark token rendering path.
- Document purpose, variants, slots, controlled state, callbacks, and
  accessibility requirements near the component.
- Reject imports of Electron, app aliases, routers, and host runtime modules
  from `packages/ui` with a lint/import-boundary rule.

## Proposed decision in one sentence

Treat `@plakk/ui` as a React-DOM design-system package—Base UI behavior,
Plakk semantic tokens, and props-in/events-out components—while each app owns
data orchestration, routing, and platform chrome.
