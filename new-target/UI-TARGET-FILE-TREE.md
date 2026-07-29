# Warung Meng — Target Shared UI Core File Tree

## 1. Status dan Urutan Eksekusi

Dokumen ini adalah **planning target UI**, bukan deskripsi source saat ini dan
bukan rencana backend.

UI hanya boleh mulai dibangun setelah:

1. `packages/admin-engine` selesai dan tervalidasi;
2. `packages/storefront-engine` selesai dan tervalidasi;
3. engine, parent, child, dan capability IDs dibekukan;
4. query/command input-output contract dibekukan;
5. result, loading, empty, error, unavailable, retry, dan success semantics
   dibekukan;
6. atomic workflow serta engine lifecycle lulus validation.

Jika implementasi UI menemukan business behavior yang belum tersedia,
pekerjaan UI harus berhenti. Kekurangan diperbaiki pada logic child pemiliknya.
UI tidak boleh menambahkan temporary business logic, repository call, data
patch, atau conditional workaround.

## 2. Source Boundary dan Production Runtime

`packages/ui-core` adalah **satu-satunya sumber implementasi UI** untuk:

- Admin;
- Storefront;
- surface baru;
- feature baru.

`ui-core` bukan milik Admin, Storefront, atau salah satu logic engine.

Source package yang sama dibundel secara independen:

```text
Admin production artifact
├─ apps/admin
├─ packages/admin-engine
└─ packages/ui-core

Storefront production artifact
├─ apps/storefront
├─ packages/storefront-engine
└─ packages/ui-core
```

Artinya:

- source UI hanya satu;
- Admin dan Storefront tidak menduplikasi layout, widget, renderer, theme, CSS,
  accessibility, feedback, atau responsive system;
- `ui-core` hadir sebagai salinan bundle masing-masing artifact;
- tidak ada shared UI runtime state atau singleton lintas server;
- logic runtime tetap terpisah walaupun UI source sama.

## 3. Keputusan Arsitektur yang Dikunci

1. UI mempunyai satu headless parent bernama `UiCore`.
2. `UiCore` surface-agnostic dan business-agnostic.
3. `UiCore` memiliki global layout, widget, renderer, theme, feedback,
   accessibility, dan responsive implementation.
4. Headless contract/registry dan React/AntD renderer berada dalam satu package,
   tetapi mempunyai entry dan dependency layer terpisah.
5. Headless layer tidak boleh mengimpor React, Ant Design, DOM, atau CSS.
6. `ui-core` tidak boleh mengimpor `admin-engine` atau `storefront-engine`.
7. Surface gate menjadi boundary yang mengenal public logic contract dan public
   UI contract.
8. Admin mempunyai tepat satu UI gate per root sidebar.
9. Storefront mempunyai satu UI gate per route/customer flow.
10. Logic child yang granular tidak menghasilkan UI file yang granular.
11. Satu gate mengagregasi seluruh logic children untuk sidebar/flow tersebut.
12. Apps hanya memiliki gates, surface profile, composition, `App.tsx`, dan
    `main.tsx`.
13. Tidak ada UI implementation atau CSS di app maupun logic engine.
14. New feature tidak boleh otomatis menambah layout atau widget baru.
15. `ui-core` hanya berubah jika ditemukan kebutuhan presentation pattern yang
    benar-benar reusable.
16. UI tetap schema-driven dalam contract kecil dan stabil, bukan generic
    low-code page builder.

## 4. Model Parent–Gate–Renderer

```text
AdminEngine public capabilities
  → Admin surface gates
  → UiCore headless registry
  → global layouts/widgets
  → React/AntD renderer
  → Admin production bundle

StorefrontEngine public capabilities
  → Storefront surface gates
  → UiCore headless registry
  → global layouts/widgets
  → React/AntD renderer
  → Storefront production bundle
```

`UiCore` tidak mengetahui apakah capability berasal dari Admin, Storefront, atau
surface baru. Ia hanya menerima stable capability resolver dan declarative
presentation schema dari composition layer.

## 5. Headless UI Contract

```ts
import type { CapabilityId } from "@warungmeng/module-system";

export type UiGateId = string & { readonly __brand: "UiGateId" };
export type LayoutId = string & { readonly __brand: "LayoutId" };
export type ViewId = string & { readonly __brand: "ViewId" };
export type SlotId = string & { readonly __brand: "SlotId" };

export interface UiCore {
  getSnapshot(): UiCoreSnapshot;
  resolveGate(gateId: UiGateId): SurfaceUiGate | undefined;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface SurfaceUiGate {
  readonly id: UiGateId;
  readonly surface: string;
  readonly navigation: NavigationContribution;
  readonly views: Readonly<Record<ViewId, UiViewBinding>>;
}

export interface UiViewBinding {
  readonly requires: readonly CapabilityId[];
  readonly layoutId: LayoutId;
  readonly slots: Readonly<Record<SlotId, UiSlotBinding>>;
  readonly presentation: PresentationSchema;
}

export interface SurfaceProfile {
  readonly id: string;
  readonly navigationMode: "sidebar" | "header" | "bottom" | "route";
  readonly density: "compact" | "comfortable";
  readonly responsiveDirection: "desktop-first" | "mobile-first";
}

export interface GlobalLayoutDefinition {
  readonly id: LayoutId;
  readonly supportedSlots: readonly SlotId[];
  readonly accessibilityPolicy: AccessibilityPolicy;
  readonly responsivePolicy: ResponsiveLayoutPolicy;
}

export interface CapabilityResolver {
  resolve<T>(capabilityId: CapabilityId): T | undefined;
  subscribe(listener: () => void): () => void;
}
```

Headless UI contract tidak memiliki:

```ts
ReactNode;
JSX.Element;
antdComponent;
cssClassName;
repository;
fetch;
database;
businessValidation;
businessCalculation;
businessMutation;
```

## 6. Target Shared UI File Tree

```text
packages/
└─ ui-core/
   ├─ src/
   │  ├─ headless/
   │  │  ├─ createUiCore.ts
   │  │  ├─ uiContracts.ts
   │  │  ├─ uiCoreSnapshot.ts
   │  │  ├─ layoutRegistry.ts
   │  │  ├─ gateRegistry.ts
   │  │  ├─ presentationState.ts
   │  │  ├─ uiCore.test.ts
   │  │  └─ index.ts
   │  │
   │  ├─ layouts/
   │  │  ├─ OverviewLayout.tsx
   │  │  ├─ CollectionLayout.tsx
   │  │  ├─ EditorLayout.tsx
   │  │  ├─ DetailLayout.tsx
   │  │  ├─ WorkspaceLayout.tsx
   │  │  ├─ SettingsLayout.tsx
   │  │  ├─ FeedbackLayout.tsx
   │  │  └─ globalLayouts.test.tsx
   │  │
   │  ├─ widgets/
   │  │  ├─ DataWidgets.tsx
   │  │  ├─ InputWidgets.tsx
   │  │  ├─ FeedbackWidgets.tsx
   │  │  └─ globalWidgets.test.tsx
   │  │
   │  ├─ renderer/
   │  │  ├─ UiHost.tsx
   │  │  ├─ AntdUiRenderer.tsx
   │  │  ├─ SurfaceShell.tsx
   │  │  ├─ NavigationRenderer.tsx
   │  │  ├─ iconRegistry.tsx
   │  │  └─ renderer.test.tsx
   │  │
   │  ├─ theme/
   │  │  ├─ themeContracts.ts
   │  │  ├─ createAntdTheme.ts
   │  │  └─ ThemeProvider.tsx
   │  │
   │  ├─ styles/
   │  │  └─ uiCore.css
   │  │
   │  ├─ headless.ts
   │  ├─ react.ts
   │  └─ index.ts
   │
   ├─ package.json
   └─ tsconfig.json

apps/
├─ admin/
│  └─ src/
│     ├─ ui-gates/
│     │  ├─ dashboardUiGate.ts
│     │  ├─ menuUiGate.ts
│     │  ├─ financeUiGate.ts
│     │  ├─ inventoryUiGate.ts
│     │  ├─ posUiGate.ts
│     │  ├─ ordersUiGate.ts
│     │  └─ settingsUiGate.ts
│     ├─ adminUiGates.test.ts
│     ├─ adminSurfaceProfile.ts
│     ├─ createAdminApplication.ts
│     ├─ App.tsx
│     └─ main.tsx
│
└─ storefront/
   └─ src/
      ├─ ui-gates/
      │  ├─ catalogUiGate.ts
      │  ├─ cartUiGate.ts
      │  ├─ checkoutUiGate.ts
      │  └─ ordersUiGate.ts
      ├─ storefrontUiGates.test.ts
      ├─ storefrontSurfaceProfile.ts
      ├─ createStorefrontApplication.ts
      ├─ App.tsx
      └─ main.tsx
```

Tidak ada package renderer/layout/widget terpisah untuk Admin dan Storefront.
Membuat package UI per surface dilarang karena akan menduplikasi shared source.

Tidak ada feature-specific implementation di app:

```text
apps/*/src/screens/
apps/*/src/features/*/components/
apps/*/src/features/*/views/
apps/*/src/**/*.module.css
```

## 7. Public Entry dan Internal Dependency

`packages/ui-core` mempunyai dua public layer:

```text
@warungmeng/ui-core/headless
└─ contracts, registry, snapshot, presentation-state normalization

@warungmeng/ui-core/react
└─ UiHost, React/AntD renderer, layouts, widgets, theme, styles
```

Dependency internal wajib satu arah:

```text
headless
  ↑
layouts/widgets/renderer/theme
```

Dilarang:

```text
headless → React
headless → Ant Design
headless → DOM
headless → CSS
headless → renderer/layout implementation
```

`index.ts` hanya menjadi convenience export yang tidak mengaburkan boundary.
Package export map harus memungkinkan test headless berjalan tanpa memuat
React/AntD renderer.

## 8. Tanggung Jawab `ui-core`

### Headless parent

`UiCore` mengelola:

- lifecycle;
- gate registration;
- global layout registration;
- gate/view/layout/slot validation;
- capability availability snapshot;
- normalized presentation state;
- subscription;
- diagnostics;
- cleanup.

`UiCore` tidak mengelola:

- business state;
- data fetching;
- mutation;
- calculation;
- domain validation;
- repository/storage/network access.

### Global layouts

| Layout ID    | Tujuan                                           |
| ------------ | ------------------------------------------------ |
| `overview`   | Metrics, summary, trend, dan status overview     |
| `collection` | Search, filter, list/table/card-grid, dan paging |
| `editor`     | Create/edit input dan submit-state presentation  |
| `detail`     | Detail, metadata, timeline, dan action slots     |
| `workspace`  | Multi-region operational/customer workspace      |
| `settings`   | Grouped preference/configuration sections        |
| `feedback`   | Loading, empty, error, unavailable, dan retry    |

Layout menerima generic slot contract, bukan business entity:

```ts
export interface CollectionLayoutSlots {
  readonly header?: UiSlotBinding;
  readonly search?: UiSlotBinding;
  readonly filters?: UiSlotBinding;
  readonly primaryAction?: UiSlotBinding;
  readonly content: UiSlotBinding;
  readonly pagination?: UiSlotBinding;
}
```

Gate memilih capability dan schema yang mengisi slot. Renderer memilih AntD
component. Logic engine menyediakan state/query/command melalui public
capability.

### Global widgets

Data widgets:

```text
metric
description-list
data-table
card-grid
status-list
timeline
summary
money-value
date-time-value
image
```

Input widgets:

```text
text-input
number-input
select
switch
date-range
form-section
action-bar
submit-state
quantity-control
```

Feedback widgets:

```text
loading
empty
error
unavailable
retry
disabled-reason
```

Dilarang membuat widget bernama berdasarkan business feature:

```text
MenuTable.tsx
OrderDetailCard.tsx
FinanceExpenseForm.tsx
InventoryHppPanel.tsx
StorefrontCartCard.tsx
```

Gate mengubah semantic presentation schema menjadi konfigurasi global widget.

## 9. Admin: Exactly One Gate per Root Sidebar

```text
Dashboard → dashboardUiGate.ts
Menu      → menuUiGate.ts
Finance   → financeUiGate.ts
Inventory → inventoryUiGate.ts
POS       → posUiGate.ts
Orders    → ordersUiGate.ts
Settings  → settingsUiGate.ts
```

Satu gate memetakan seluruh pure logic children milik sidebar:

```text
dashboardUiGate
├─ admin.dashboard.overview → overview layout
└─ admin.dashboard.reports  → collection layout

menuUiGate
├─ admin.menu.catalog-read       → collection layout
├─ admin.menu.menu-editor        → editor layout
└─ admin.menu.variant-management → collection + editor composition

financeUiGate
├─ admin.finance.ledger-read            → overview/collection
├─ admin.finance.transaction-recording  → collection + editor
└─ admin.finance.expense-management     → collection + editor

inventoryUiGate
├─ admin.inventory.materials-read    → collection
├─ admin.inventory.stock-movements   → collection
├─ admin.inventory.stock-adjustment  → collection action slot
└─ admin.inventory.hpp-calculation   → detail/editor composition

posUiGate
└─ session + cart + checkout → workspace layout

ordersUiGate
├─ admin.orders.order-read         → collection/detail
└─ admin.orders.order-cancellation → detail action slot

settingsUiGate
├─ admin.settings.theme-preference → settings layout
└─ admin.settings.business-hours   → settings layout
```

Headless capabilities yang tidak membutuhkan direct view tetap tidak membuat
file UI baru. Contoh:

- finance refund projection;
- inventory stock consumption;
- inventory stock reversal;
- order submission milik POS orchestration.

Gate hanya memasang capability tersebut pada action/flow yang membutuhkannya.

## 10. Storefront: One Gate per Customer Flow

```text
Catalog flow  → catalogUiGate.ts
Cart flow     → cartUiGate.ts
Checkout flow → checkoutUiGate.ts
Orders flow   → ordersUiGate.ts
```

Binding:

```text
catalogUiGate
├─ storefront.catalog.read        → collection layout
└─ storefront.catalog.menu-detail → detail layout

cartUiGate
└─ storefront.cart.management → collection/detail composition

checkoutUiGate
└─ storefront.checkout.submission → editor/feedback composition

ordersUiGate
├─ storefront.orders.order-submission   → feedback state binding
└─ storefront.orders.order-confirmation → detail layout
```

Storefront tidak membuat salinan `CollectionLayout`, `DetailLayout`, widget
image, quantity control, feedback, theme, atau CSS. Semua berasal dari
`packages/ui-core`.

## 11. Gate Contract

Gate bertanggung jawab atas:

- one surface entry untuk sidebar/flow;
- navigation dan view identity;
- route/view contribution;
- capability requirements;
- global layout selection;
- slot mapping;
- field/column/action presentation schema;
- breadcrumb atau flow-step schema;
- unavailable presentation policy.

Gate tidak bertanggung jawab atas:

- fetching;
- repository access;
- business validation;
- calculation;
- transaction;
- data mutation;
- retry/request identity;
- domain formatting rule;
- command implementation;
- renderer implementation;
- CSS.

Contoh:

```ts
export const menuUiGate = defineSurfaceUiGate({
  id: "admin.menu",
  surface: "admin",
  navigation: {
    textKey: "admin.navigation.menu",
    iconId: "menu",
    order: 20,
  },
  views: {
    catalog: {
      requires: ["admin.menu.catalog-read"],
      layoutId: "collection",
      slots: menuCatalogSlots,
    },
    editor: {
      requires: ["admin.menu.menu-editor"],
      layoutId: "editor",
      slots: menuEditorSlots,
    },
  },
});
```

Gate tidak mengimpor child implementation. Capability IDs dan public types
berasal dari public entry engine terkait.

## 12. Gate Discovery dan Composition

Gate candidates ditemukan oleh app composition, lalu diberikan kepada
`UiCore`. `ui-core` tidak memindai filesystem app.

```ts
// apps/admin/src/createAdminApplication.ts
const gateCandidates = import.meta.glob("./ui-gates/*UiGate.ts", {
  eager: true,
});
```

```ts
// apps/storefront/src/createStorefrontApplication.ts
const gateCandidates = import.meta.glob("./ui-gates/*UiGate.ts", {
  eager: true,
});
```

Validation:

1. unique gate ID;
2. Admin exactly one gate per root sidebar;
3. Storefront unique gate per route/customer flow;
4. unique view/route contribution IDs;
5. every referenced layout exists;
6. every slot is supported by selected layout;
7. every required capability follows locked public contract;
8. no child internal import;
9. no business/data implementation import;
10. all user-facing text uses translation keys.

Tidak ada central manual gate list.

## 13. Surface Profiles

Surface differences adalah configuration, bukan fork UI implementation.

### Admin profile

```text
navigation: sidebar
density: compact
responsive direction: fluid desktop-first
usage: operational/control-center
```

Rules:

- memakai available container width;
- continuous resize tetap usable;
- fixed viewport, device, dan aspect ratio bukan release gate;
- collection dapat berpindah table/card-grid berdasarkan ruang;
- workspace dapat mengubah pembagian region tanpa mengubah business state;
- gate tidak menyimpan breakpoint pixel.

### Storefront profile

```text
navigation: route/header/bottom as configured
density: comfortable
responsive direction: fluid mobile-first
usage: customer-facing
```

Rules:

- mulai dari narrow available width;
- berkembang kontinu ke layar yang lebih lebar;
- tidak mengikat layout pada satu ukuran perangkat atau aspect ratio;
- catalog, detail, cart, dan checkout memakai global layout/widget contract;
- responsive state tidak mengubah business state.

`SurfaceShell` dan global layout membaca profile tersebut. App tidak membuat
shell atau stylesheet sendiri.

## 14. Accessibility dan Feedback Contract

Implementation global berada di `ui-core`:

- focus selalu terlihat;
- hidden/collapsed content tidak tabbable;
- semantic status untuk loading;
- `aria-live` untuk transition penting;
- error/unavailable memiliki reason dan recovery action;
- disabled action mempunyai reason yang dapat diakses;
- status tidak hanya dibedakan melalui warna;
- keyboard navigation konsisten;
- modal/drawer focus lifecycle konsisten;
- form error terhubung ke field;
- responsive reflow mempertahankan reading dan focus order.

Gate hanya memilih policy atau menyediakan semantic metadata. Gate tidak
mengimplementasikan behavior accessibility sendiri.

## 15. State Ownership

```text
Business state
  → admin-engine atau storefront-engine

Capability availability
  → application engine snapshot

Gate/layout/view registration
  → UiCore headless snapshot

Route/view selection
  → UiHost + surface gate contribution

Layout and slot selection
  → surface gate

React presentation state
  → global renderer

Theme/responsive/accessibility behavior
  → ui-core
```

UI draft state boleh menyimpan:

- focused field;
- expanded panel;
- selected visual row;
- temporary form input sebelum command submission;
- modal/drawer open state;
- active view.

UI draft state tidak boleh menentukan:

- final price;
- stock mutation;
- order transition;
- refund;
- HPP;
- checkout validity;
- business-hours validity;
- persistence outcome.

## 16. Missing-Capability Behavior

```text
Required capability available
  → bind layout, slots, and actions

Optional action capability unavailable
  → omit only that action slot

Required view capability unavailable
  → render global unavailable state

Whole gate unavailable
  → hide/disable navigation according to surface policy
```

Gate dan renderer tidak boleh:

- membuat fake business data;
- memanggil legacy repository;
- meniru command yang hilang;
- menambahkan local business fallback;
- mengimpor sibling engine.

## 17. Import Contract

Diizinkan:

```text
ui-core/headless
  → module-system public type contracts
  → generic TypeScript contracts

ui-core/react
  → ui-core/headless
  → React
  → Ant Design
  → ui-core global styles/theme

apps/admin/ui-gates
  → admin-engine public contracts
  → ui-core/headless public contracts

apps/storefront/ui-gates
  → storefront-engine public contracts
  → ui-core/headless public contracts

apps/admin composition
  → admin-engine public runtime
  → ui-core/headless
  → ui-core/react
  → Admin gates/profile

apps/storefront composition
  → storefront-engine public runtime
  → ui-core/headless
  → ui-core/react
  → Storefront gates/profile
```

Dilarang:

```text
ui-core → admin-engine
ui-core → storefront-engine

admin-engine → ui-core
storefront-engine → ui-core

Admin gate → Storefront engine
Storefront gate → Admin engine

gate → child internal implementation
gate → repository/concrete adapter
gate → React/AntD component
gate → CSS
gate → sibling gate

renderer → business engine internal path
renderer → repository/concrete adapter
renderer → business mutation implementation

apps/* → feature-specific screen/component/CSS implementation
```

## 18. File-Efficiency Rules

1. Tepat satu Admin gate per root sidebar.
2. Tepat satu Storefront gate per customer flow.
3. Satu gate memuat seluruh view/action/slot binding untuk owner tersebut.
4. Tidak membuat gate file untuk setiap logic child.
5. Tidak membuat routed screen file per view.
6. Tidak membuat feature component atau feature CSS folder.
7. Global layout dibuat sekali dan dipakai seluruh surface.
8. Layout composition memakai layout IDs dan slots, bukan file baru.
9. Widget dibuat berdasarkan reusable presentation pattern.
10. Layout/widget baru hanya dibuat bila existing global contract benar-benar
    tidak mampu mewakili kebutuhan lintas feature.
11. Seluruh Admin gates dapat diuji dalam satu gate-contract suite.
12. Seluruh Storefront gates dapat diuji dalam satu gate-contract suite.
13. Global layouts/widgets mempunyai consolidated renderer tests.
14. AntD token diprioritaskan sebelum custom CSS.
15. CSS hanya berada di `packages/ui-core`.
16. Tidak membuat speculative abstraction.

Target dasar:

```text
1 shared ui-core package
7 Admin gates
4 Storefront gates
7 global layouts
3 global widget files
1 global renderer
1 generic surface shell
1 shared theme/style source
```

## 19. New Feature Plug-and-Play

### Child baru di root yang sudah ada

```text
add logic child
  → capability ditemukan oleh engine
  → update satu existing surface gate binding
  → use existing global layout/widget
```

Tidak ada file UI per child.

### Root/sidebar/flow baru

```text
add parent + logic children
  → add exactly one new surface gate
  → use existing global layout/widget
```

`ui-core` tidak berubah kecuali terdapat pattern visual reusable baru.

### Feature dipakai dua surface

```text
shared pure invariant
  → packages/domain

Admin orchestration
  → admin-engine child

Storefront orchestration
  → storefront-engine child

shared presentation
  → packages/ui-core

surface mapping
  → gate masing-masing app
```

Tidak ada shared mutable runtime antara dua production artifact.

## 20. Implementation Sequence

### UI-00 — Logic freeze gate

- Verify completion criteria kedua logic engine.
- Freeze engine/child/capability IDs.
- Freeze query/command/result/error contracts.
- Dilarang menulis UI implementation bila gate ini belum PASS.

### UI-01 — Headless UI core

- Implement headless contracts.
- Implement layout/gate registries.
- Implement snapshot, lifecycle, subscription, dan diagnostics.
- Test tanpa React/AntD.

### UI-02 — Global layouts dan widgets

- Implement tujuh global layout contracts/renderers.
- Implement tiga global widget groups.
- Validate slot compatibility.
- Implement feedback dan accessibility behavior global.

### UI-03 — Global React/AntD renderer

- Build generic `UiHost`.
- Build `SurfaceShell`.
- Build navigation renderer driven by surface profile.
- Build theme dan shared CSS.
- Tidak membuat surface-specific screen.

### UI-04 — Surface gates

- Implement tujuh Admin gates.
- Implement empat Storefront gates.
- Bind public engine capabilities.
- Tidak menulis business logic.

### UI-05 — Application wiring

- Compose Admin engine + Admin gates/profile + shared `UiCore`.
- Compose Storefront engine + Storefront gates/profile + shared `UiCore`.
- Pastikan kedua artifact memakai runtime terpisah.

### UI-06 — Browser acceptance

- Admin: fluid desktop-first dan continuous resize.
- Storefront: fluid mobile-first dan continuous resize.
- Navigation, direct view, reload, history, dan localization.
- Keyboard, visible focus, loading, empty, error, unavailable, retry.
- Console dan horizontal-overflow checks.
- Visual correction dilakukan pada global layout/widget/theme, bukan melalui
  business logic patch atau duplicate surface component.

## 21. Hard Stop Conditions

Stop UI implementation apabila:

- salah satu logic engine belum lengkap;
- public capability belum tersedia;
- query/command/result contract belum stabil;
- gate membutuhkan repository atau concrete adapter;
- gate mulai menghitung business value;
- renderer perlu mengetahui child implementation;
- layout membutuhkan data patch agar dapat dirender;
- surface meminta duplicate layout/widget;
- UI fix mengubah domain, transaction, atau persistence behavior;
- feature-specific screen/component/CSS mulai dibuat di luar `ui-core`;
- Admin dan Storefront mulai berbagi runtime state.

Owner per masalah:

```text
Missing business behavior       → logic child pemilik
Missing capability contract     → engine public contract
Missing reusable structure      → ui-core global layout
Missing reusable visual unit    → ui-core global widget
Missing Admin mapping           → satu Admin sidebar gate
Missing Storefront mapping      → satu Storefront flow gate
Missing external data behavior  → pembahasan backend berikutnya
```

## 22. Completion Criteria

Target shared UI dianggap lengkap hanya jika:

- `packages/ui-core` adalah satu-satunya UI implementation source;
- source yang sama dibundel independen ke Admin dan Storefront;
- tidak ada shared runtime singleton lintas server;
- headless entry dapat diuji tanpa React dan Ant Design;
- `ui-core` tidak mengimpor logic engine;
- terdapat tepat tujuh Admin gates;
- terdapat tepat empat Storefront flow gates;
- tidak ada UI file per logic child;
- tidak ada feature screen/component/CSS di apps atau engines;
- seluruh gate memakai global layouts/widgets;
- gate tidak mengimpor repository atau child implementation;
- missing capability hanya memengaruhi view/action terkait;
- global loading/empty/error/unavailable behavior konsisten;
- Admin menggunakan fluid desktop-first policy;
- Storefront menggunakan fluid mobile-first policy;
- accessibility behavior diterapkan global;
- business logic tidak berada di gate, renderer, JSX handler, atau CSS;
- new feature dapat dipasang melalui logic child + gate binding tanpa mengubah
  `ui-core`, kecuali benar-benar membutuhkan reusable presentation primitive
  baru.

## 23. Hal yang Sengaja Ditunda untuk Pembahasan Backend

Dokumen UI ini tidak menentukan:

- concrete data source;
- network transport;
- persistence;
- authentication;
- synchronization;
- komunikasi operational antara Admin dan Storefront.

UI hanya menerima public capability dari runtime milik production artifact
masing-masing. External integration contract akan dibahas terpisah tanpa
mengubah prinsip satu shared UI source dan dua application logic runtime.
