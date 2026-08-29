# Source Surface Capabilities

## Purpose

A source surface presents source text in Code, a changed file in Review, or a source preview in a
Peek pane. Many independent capabilities need to contribute behavior without replacing another
capability's callback, selection, decoration, request, or overlay.

DiffDash follows the architectural principles of VS Code extensions without targeting VS Code API
compatibility. Built-in capabilities dogfood the same semantic boundaries intended for future user
extensions, while trusted built-ins may use an in-process adapter to avoid cross-process overhead.

## Kernel Ownership

The renderer source surface kernel owns the integration mechanics:

| Concern | Sole owner | Capability contract |
| --- | --- | --- |
| Pierre post-render callback | Render lifecycle runtime | Named render observer |
| Bubbled source interactions | Interaction router | Ordered, exclusive route |
| Pierre selected lines | Selection coordinator | Owner-scoped selection intent |
| Gutter and text decoration | Render lifecycle runtime | Idempotent namespaced reconciler |
| Floating-pane positioning | Surface anchor resolver | Semantic target plus fallback rectangle |
| Provider invocation | Capability controller | Typed provider plus cancellation |

Capabilities do not return partial Pierre options. They cannot call another capability's disposer,
clear another capability's selection, or use a DOM element as the only durable identity of an
asynchronous target. Duplicate contribution IDs fail with a typed capability error instead of
silently replacing the first owner. The in-package renderer adapter necessarily handles DOM events
and Pierre instances, but those adapter types are not extension contracts and never cross a package
or process boundary.

The runtime keeps Pierre callback identities stable. Capability data updates reconcile already
mounted hosts and are replayed to future virtualized mounts; they do not force source rendering by
changing callback options.

## Built-In Capabilities

Review Comments (`diffdash.builtin.review-comments`) is the first trusted built-in extension that
spans project activities plus Code and Review source surfaces. The renderer registry publishes
immutable snapshots and owns extension and contribution identity, deterministic ordering, and
owner-scoped disposal. The project activity host owns selection, persistence, surface-preserving
transitions, and fallback when a saved contribution is unavailable. Ordered project-provider
contributions keep extension state scoped to the active project without hard-coding a feature at the
application root.

The same registry has a generic global-navigation lane. Its required host-owned Home contribution
provides the non-removable fallback, while every global owner provides its own opaque state
validation, equality, component, and feature policy. AppShell supplies global components only generic
project-opening and navigation-history controls; it does not build or inject Home content. AppShell and history resolve both global and project
destinations through registered contribution identity and registration generation.
The durable project destination uses the same ownership boundary: persistence stores the registered
navigation contribution identity and bounded encoded JSON without interpreting it. Review owns the
Review codec, Code owns the Code codec, and a preferred project-opening provider can persist either
surface only by dispatching through the registry's owner-neutral codec contract.

Review (`diffdash.builtin.review`) and Code (`diffdash.builtin.code`) own the two project source
surface registrations. Reviews and Files belong to Review; Code owns its repository-tree context and
source-viewer main slots; Walkthrough (`diffdash.builtin.walkthrough`) owns its activity slot; Review
Comments owns its context and selected-thread detail slots. Surface ownership is exclusive and
duplicate registration fails before a partial registry generation becomes visible.

All contribution kinds owned by an extension are removed atomically. The host then resolves a
registered default for the retained surface or another available surface, rewrites stale navigation
history entries without adding a new entry, persists the repaired workspace once, and unmounts an
unavailable source surface so leases and subscriptions are released. This is the deletion invariant
that built-ins must satisfy before the same semantic contracts can be exposed through a future
out-of-process user extension API.

Trusted built-ins mount React adapters in-process. Those adapters are application implementation
details, not public extension contracts. Their source contributions exchange semantic values:

- Code supplies project, workspace revision, Git revision, repository path, line number, and line
  content. The source host orders line actions and renders each contribution's ordered annotation
  list, including multiple annotations targeting the same line.
- Review supplies project, review target, exact base/head revisions, parsed files, and semantic
  thread navigation. The Review host composes annotations and line actions while retaining
  responsive pane layout and viewport navigation.
- The source kernel alone adapts these values to Pierre callbacks, virtualized instances, DOM
  anchors, and input events.

The current built-in adoption is:

| Capability ID | Provider or input | Governed contribution |
| --- | --- | --- |
| `diffdash.builtin.scm-line-changes` | Code workspace line-change provider | Protected SCM gutter decoration |
| `diffdash.builtin.language-navigation` | Definition and reference providers | Modified-token interaction and Peek |
| `diffdash.builtin.review-comments.code-source` | Review Comments extension | Code line action, draft annotation, and collected note annotations |
| `diffdash.builtin.review-comments.review-diff` | Review Comments extension | Review line actions, thread annotations, and collected note annotations |
| `diffdash.builtin.code-search` | In-file search | Owner-scoped selection and text highlight |
| `diffdash.builtin.review-virtualization` | Rendered review diff | Virtualizer registration and settlement |
| `diffdash.builtin.review-search` | Review search manager | Search highlight reconciliation |
| `diffdash.builtin.review-navigation-focus` | Review navigator | Rendered target focus reconciliation |
| `diffdash.builtin.review-viewed-files` | Viewed-file controller | Viewport preservation reconciliation |

Review's side-aware gutter and line callbacks remain one private `DiffCard` Pierre adapter because
Pierre supplies old/new-side metadata there that is not present on a bubbled DOM event. The adapter
converts Pierre values to the semantic Review contribution lane and renders host-composed
annotations. Render lifecycle, virtualization, search, navigation focus, and viewed-file behavior
still flow through the shared runtime.

Language providers compute locations. The generic language-navigation capability owns Cmd-click,
Alt-click, Cmd+Shift-click, cancellation, result policy, and Peek presentation. Git computes compact
line-change ranges. The generic SCM decoration capability owns their rendering. This split allows a
future provider to add a language or repository implementation without reimplementing source input
or directly mutating Pierre.

## Future Extension Boundary

User extension JavaScript must run in a separately supervised extension host, not in the renderer or
Core business runtime. Static manifest contributions are available before activation. Dynamic
registrations return disposables, and host termination disposes every command, provider,
decoration, selection, and overlay owned by that extension.

The public extension API should expose DiffDash concepts such as:

```text
commands
languages
reviews
surfaces
window
workspace
extensions
```

Cross-process payloads use semantic surface identities and locations. Code locations identify a
project, revision, path, line, and character. Review locations additionally identify the review
file and diff side. Renderer-only adapters resolve those values to current virtualized DOM.

Extensions contribute through governed slots:

| Slot | Policy |
| --- | --- |
| SCM gutter | Reserved for the active Git capability |
| Diagnostics gutter | Merged by severity |
| Review gutter | Reserved for review threads and findings |
| Extension gutter | Ordered by declared group |
| Text decorations | Layered by declared category |
| Context menus | Ordered commands with context-key conditions |
| Hover | Merged named sections |
| Peek | One kernel-managed surface overlay |
| Selection | Exclusive result chosen by the selection coordinator |
| Custom panel | Structured native view or sandboxed webview |

Built-ins may use protected lanes and trusted process capabilities. User extensions receive only
manifest-declared permissions and extension lanes. Built-in modifier gestures and protected SCM or
review decorations are not overrideable.

## Extension Host Target

The intended process model is:

```text
Renderer: SourceSurfaceKernel -> BuiltInCapabilities + ExtensionGateway
Main: ExtensionService -> install, trust, permissions, activation, host lifecycle
Utility process: ExtensionHost -> user JavaScript + @diffdash/extension-api
```

Commands are the central action abstraction. Providers compute semantic results. Declarative
contributions place commands and data into governed UI slots. Context keys and `when` clauses are
evaluated synchronously in the renderer; provider and command execution may activate an extension
asynchronously and always supports cancellation.

The extension host, manifest schema, permission model, and published SDK are future work. The
current source surface kernel deliberately keeps Pierre and DOM details private so those additions
do not require breaking built-in capability contracts.
