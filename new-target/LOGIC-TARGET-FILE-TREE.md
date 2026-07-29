# Warung Meng — Target Headless Logic File Tree

## 1. Status dan Ruang Lingkup

Dokumen ini adalah **planning target logic**, bukan deskripsi struktur source
saat ini dan bukan rencana backend.

Dokumen ini hanya menetapkan:

- generic parent/child module runtime;
- dua application logic runtime yang mengikuti batas production deployment;
- parent engine dan pure logic children;
- capability, dependency, lifecycle, diagnostics, dan isolation contract;
- outbound port sebagai boundary abstrak;
- target file tree serta aturan efisiensi file.

Dokumen ini tidak menetapkan:

- React, JSX, DOM, Ant Design, CSS, layout, widget, atau responsive behavior;
- screen, component, form, modal, table, atau UI state;
- sidebar label, icon, URL path, router, atau navigation rendering;
- concrete network, storage, database, queue, atau repository adapter;
- mekanisme komunikasi backend antara Admin dan Storefront.

Pembahasan concrete backend dan persistence dilakukan setelah dua logic engine
ini disepakati. Dokumen ini hanya mengunci bahwa komunikasi lintas production
runtime harus melewati external integration contract di masa depan, bukan
shared in-memory registry atau singleton.

## 2. Deployment Boundary yang Dikunci

Admin dan Storefront dibangun serta dijalankan sebagai production artifact
terpisah. Karena itu application logic runtime juga wajib terpisah:

```text
Admin production artifact
├─ apps/admin
├─ packages/admin-engine
├─ packages/module-system
└─ packages/domain

Storefront production artifact
├─ apps/storefront
├─ packages/storefront-engine
├─ packages/module-system
└─ packages/domain
```

Aturan mutlak:

```text
admin-engine      ✕ storefront-engine
storefront-engine ✕ admin-engine

admin-engine      → module-system + domain
storefront-engine → module-system + domain

apps/admin        → admin-engine
apps/storefront   → storefront-engine
```

`packages/domain` hanya boleh berisi type, value object, invariant, dan pure
rule yang benar-benar dipakai kedua runtime. Package ini tidak boleh memiliki
mutable application state, registry, repository instance, browser state, atau
runtime singleton.

Application orchestration tetap dimiliki engine masing-masing. Kesamaan entity
atau invariant tidak menjadi alasan untuk menyatukan Admin dan Storefront ke
dalam satu runtime.

## 3. Parent–Child Contract yang Dikunci

Prinsip utamanya:

> **Parent = engine host. Child = seluruh feature behavior.**

Parent engine hanya boleh memiliki:

- stable identity;
- lifecycle host;
- namespace child;
- discovery dan isolation;
- dependency validation;
- capability aggregation;
- diagnostics dan read-only snapshot.

Parent engine dilarang memiliki:

- query atau command;
- calculation atau business validation;
- repository atau storage call;
- list, detail, editor, form, atau route behavior;
- state transition;
- workflow orchestration;
- business fallback.

Seluruh behavior tersebut harus berada di pure logic child.

Beberapa mode dapat berada dalam satu child apabila merupakan satu cohesive
feature dengan invariant dan lifecycle yang sama. Contoh: create dan edit menu
berada dalam satu child `menu-editor`. Penggabungan dilakukan di child, bukan
dengan memindahkan behavior ke parent.

```ts
export type EngineId = string & { readonly __brand: "EngineId" };
export type LogicChildId = string & { readonly __brand: "LogicChildId" };
export type CapabilityId = string & { readonly __brand: "CapabilityId" };

export interface ParentEngineDefinition {
  readonly id: EngineId;
  readonly childNamespace: string;
}

export interface LogicChildDefinition<TCapability = unknown> {
  readonly id: LogicChildId;
  readonly parentId: EngineId;
  readonly provides: readonly CapabilityId[];
  readonly requires: readonly CapabilityId[];
  create(context: LogicChildContext): TCapability;
}

export interface LogicChildContext {
  readonly capabilities: CapabilityRegistry;
  readonly diagnostics: DiagnosticSink;
  readonly ports: OutboundPortRegistry;
}

export interface ApplicationEngineRuntime {
  initialize(): void;
  getSnapshot(): ApplicationEngineSnapshot;
  resolve<T>(capabilityId: CapabilityId): T | undefined;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
```

Tidak ada route, label, icon, component, renderer, atau CSS pada kontrak logic.

## 4. Target Logic File Tree

```text
packages/
├─ module-system/
│  ├─ src/
│  │  ├─ engineContracts.ts
│  │  ├─ engineRegistry.ts
│  │  ├─ capabilityRegistry.ts
│  │  ├─ dependencyGraph.ts
│  │  ├─ discovery.ts
│  │  ├─ diagnostics.ts
│  │  ├─ operationResult.ts
│  │  ├─ moduleSystem.test.ts
│  │  └─ index.ts
│  ├─ package.json
│  └─ tsconfig.json
│
├─ domain/
│  ├─ src/
│  │  ├─ catalog.ts
│  │  ├─ orders.ts
│  │  ├─ inventory.ts
│  │  ├─ finance.ts
│  │  ├─ reporting.ts
│  │  ├─ domainRules.test.ts
│  │  └─ index.ts
│  ├─ package.json
│  └─ tsconfig.json
│
├─ admin-engine/
│  ├─ src/
│  │  ├─ createAdminEngine.ts
│  │  ├─ discoverAdminLogic.ts
│  │  ├─ adminEngineContracts.ts
│  │  ├─ adminEngineSnapshot.ts
│  │  ├─ adminEngineGraph.test.ts
│  │  ├─ index.ts
│  │  │
│  │  ├─ shared/
│  │  │  └─ atomicOperationPort.ts
│  │  │
│  │  └─ engines/
│  │     ├─ dashboard/
│  │     │  ├─ dashboardEngine.ts
│  │     │  ├─ dashboardContracts.ts
│  │     │  └─ children/
│  │     │     ├─ overview/
│  │     │     │  ├─ dashboardOverviewChild.ts
│  │     │     │  └─ dashboardOverview.test.ts
│  │     │     └─ reports/
│  │     │        ├─ dashboardReportsChild.ts
│  │     │        └─ dashboardReports.test.ts
│  │     │
│  │     ├─ menu/
│  │     │  ├─ menuEngine.ts
│  │     │  ├─ menuContracts.ts
│  │     │  └─ children/
│  │     │     ├─ catalog-read/
│  │     │     │  ├─ catalogReadChild.ts
│  │     │     │  └─ catalogRead.test.ts
│  │     │     ├─ menu-editor/
│  │     │     │  ├─ menuEditorChild.ts
│  │     │     │  └─ menuEditor.test.ts
│  │     │     └─ variant-management/
│  │     │        ├─ variantManagementChild.ts
│  │     │        └─ variantManagement.test.ts
│  │     │
│  │     ├─ finance/
│  │     │  ├─ financeEngine.ts
│  │     │  ├─ financeContracts.ts
│  │     │  └─ children/
│  │     │     ├─ ledger-read/
│  │     │     │  ├─ ledgerReadChild.ts
│  │     │     │  └─ ledgerRead.test.ts
│  │     │     ├─ transaction-recording/
│  │     │     │  ├─ transactionRecordingChild.ts
│  │     │     │  └─ transactionRecording.test.ts
│  │     │     ├─ expense-management/
│  │     │     │  ├─ expenseManagementChild.ts
│  │     │     │  └─ expenseManagement.test.ts
│  │     │     └─ refund-projection/
│  │     │        ├─ refundProjectionChild.ts
│  │     │        └─ refundProjection.test.ts
│  │     │
│  │     ├─ inventory/
│  │     │  ├─ inventoryEngine.ts
│  │     │  ├─ inventoryContracts.ts
│  │     │  └─ children/
│  │     │     ├─ materials-read/
│  │     │     │  ├─ materialsReadChild.ts
│  │     │     │  └─ materialsRead.test.ts
│  │     │     ├─ stock-movements/
│  │     │     │  ├─ stockMovementsChild.ts
│  │     │     │  └─ stockMovements.test.ts
│  │     │     ├─ stock-adjustment/
│  │     │     │  ├─ stockAdjustmentChild.ts
│  │     │     │  └─ stockAdjustment.test.ts
│  │     │     ├─ stock-consumption/
│  │     │     │  ├─ stockConsumptionChild.ts
│  │     │     │  └─ stockConsumption.test.ts
│  │     │     ├─ stock-reversal/
│  │     │     │  ├─ stockReversalChild.ts
│  │     │     │  └─ stockReversal.test.ts
│  │     │     └─ hpp-calculation/
│  │     │        ├─ hppCalculationChild.ts
│  │     │        └─ hppCalculation.test.ts
│  │     │
│  │     ├─ pos/
│  │     │  ├─ posEngine.ts
│  │     │  ├─ posContracts.ts
│  │     │  └─ children/
│  │     │     ├─ session/
│  │     │     │  ├─ posSessionChild.ts
│  │     │     │  └─ posSession.test.ts
│  │     │     ├─ cart/
│  │     │     │  ├─ posCartChild.ts
│  │     │     │  └─ posCart.test.ts
│  │     │     └─ checkout/
│  │     │        ├─ posCheckoutChild.ts
│  │     │        ├─ submitPosCheckoutAtomically.ts
│  │     │        └─ posCheckout.test.ts
│  │     │
│  │     ├─ orders/
│  │     │  ├─ ordersEngine.ts
│  │     │  ├─ ordersContracts.ts
│  │     │  └─ children/
│  │     │     ├─ order-read/
│  │     │     │  ├─ orderReadChild.ts
│  │     │     │  └─ orderRead.test.ts
│  │     │     ├─ order-submission/
│  │     │     │  ├─ orderSubmissionChild.ts
│  │     │     │  └─ orderSubmission.test.ts
│  │     │     └─ order-cancellation/
│  │     │        ├─ orderCancellationChild.ts
│  │     │        ├─ cancelOrderAtomically.ts
│  │     │        └─ orderCancellation.test.ts
│  │     │
│  │     └─ settings/
│  │        ├─ settingsEngine.ts
│  │        ├─ settingsContracts.ts
│  │        └─ children/
│  │           ├─ theme-preference/
│  │           │  ├─ themePreferenceChild.ts
│  │           │  └─ themePreference.test.ts
│  │           └─ business-hours/
│  │              ├─ businessHoursChild.ts
│  │              └─ businessHours.test.ts
│  │
│  ├─ package.json
│  └─ tsconfig.json
│
└─ storefront-engine/
   ├─ src/
   │  ├─ createStorefrontEngine.ts
   │  ├─ discoverStorefrontLogic.ts
   │  ├─ storefrontEngineContracts.ts
   │  ├─ storefrontEngineSnapshot.ts
   │  ├─ storefrontEngineGraph.test.ts
   │  ├─ index.ts
   │  │
   │  └─ engines/
   │     ├─ catalog/
   │     │  ├─ catalogEngine.ts
   │     │  ├─ catalogContracts.ts
   │     │  └─ children/
   │     │     ├─ catalog-read/
   │     │     │  ├─ catalogReadChild.ts
   │     │     │  └─ catalogRead.test.ts
   │     │     └─ menu-detail/
   │     │        ├─ menuDetailChild.ts
   │     │        └─ menuDetail.test.ts
   │     │
   │     ├─ cart/
   │     │  ├─ cartEngine.ts
   │     │  ├─ cartContracts.ts
   │     │  └─ children/
   │     │     └─ cart-management/
   │     │        ├─ cartManagementChild.ts
   │     │        └─ cartManagement.test.ts
   │     │
   │     ├─ checkout/
   │     │  ├─ checkoutEngine.ts
   │     │  ├─ checkoutContracts.ts
   │     │  └─ children/
   │     │     └─ checkout-submission/
   │     │        ├─ checkoutSubmissionChild.ts
   │     │        ├─ submitCheckoutSafely.ts
   │     │        └─ checkoutSubmission.test.ts
   │     │
   │     └─ orders/
   │        ├─ ordersEngine.ts
   │        ├─ ordersContracts.ts
   │        └─ children/
   │           ├─ order-submission/
   │           │  ├─ orderSubmissionChild.ts
   │           │  └─ orderSubmission.test.ts
   │           └─ order-confirmation/
   │              ├─ orderConfirmationChild.ts
   │              └─ orderConfirmation.test.ts
   │
   ├─ package.json
   └─ tsconfig.json
```

## 5. Tanggung Jawab Setiap Package

### `packages/module-system`

Runtime generic yang tidak mengetahui Warung Meng, Admin, Storefront, business
entity, UI framework, atau concrete I/O.

| File                    | Tanggung jawab                                      |
| ----------------------- | --------------------------------------------------- |
| `engineContracts.ts`    | Stable parent, child, lifecycle, dan snapshot API   |
| `engineRegistry.ts`     | Register, resolve, list, initialize, dan dispose    |
| `capabilityRegistry.ts` | Register dan resolve public capability              |
| `dependencyGraph.ts`    | Duplicate, orphan, missing dependency, cycle, order |
| `discovery.ts`          | Validasi unknown candidate                          |
| `diagnostics.ts`        | Diagnostic event dan collector                      |
| `operationResult.ts`    | Generic success/failure/degraded result contract    |
| `index.ts`              | Public exports only                                 |

### `packages/domain`

Pure shared business vocabulary dan invariant. Package ini boleh digunakan oleh
kedua engine, tetapi tidak mengorkestrasi use case milik salah satu application
runtime.

Diizinkan:

- entity dan value-object type;
- pure calculation;
- pure validation rule;
- deterministic state-transition rule;
- serialization-neutral contract.

Dilarang:

- repository instance;
- application registry;
- browser/global state;
- network call;
- concrete persistence;
- dependency ke Admin, Storefront, atau UI.

### `packages/admin-engine`

Headless application logic untuk production Admin. Folder parent mengikuti
operational area/sidebar agar ownership mudah ditemukan, tetapi tidak memiliki
label, path, icon, atau UI behavior.

### `packages/storefront-engine`

Headless application logic untuk production Storefront. Engine ini mempunyai
registry, lifecycle, capability graph, dan state sendiri. Ia tidak menggunakan
runtime Admin sebagai dependency.

## 6. Parent dan Child Ownership

### Parent engine

Parent default hanya memiliki dua file:

```text
<area>Engine.ts
<area>Contracts.ts
```

`<area>Engine.ts` mendeklarasikan identity dan namespace. Ia tidak mengimpor
implementation child.

`<area>Contracts.ts` hanya mengekspor stable capability/port/input/output type
yang dimiliki area tersebut. Contract bukan tempat implementation behavior.

### Logic child

Logic child adalah unit plug-and-play sebenarnya:

- memiliki satu cohesive feature;
- menyediakan dan membutuhkan capability secara eksplisit;
- memakai outbound port melalui injected context;
- dapat aktif, unavailable, dan dispose secara terisolasi;
- diuji tanpa React, DOM, router, CSS, atau Ant Design.

Contoh:

```ts
export const orderCancellationChild = defineLogicChild({
  id: "admin.orders.order-cancellation",
  parentId: "admin.orders",
  provides: ["admin.orders.cancel"],
  requires: [
    "admin.orders.read",
    "admin.inventory.stock-reversal",
    "admin.finance.refund-projection",
    "admin.atomic-operation",
  ],
  create: createOrderCancellation,
});
```

Parent `admin.orders` tidak mengetahui cara cancellation bekerja.

### Cohesive Storefront child scope

Storefront behavior tetap lengkap tanpa memecah setiap helper menjadi child:

| Child                                  | Behavior yang dimiliki                                       |
| -------------------------------------- | ------------------------------------------------------------ |
| `storefront.catalog.catalog-read`      | category, search, menu collection, availability read         |
| `storefront.catalog.menu-detail`       | detail, option/variant selection input, detail validation    |
| `storefront.cart.cart-management`      | cart state, quantity rules, subtotal, persistence port       |
| `storefront.checkout.submission`       | validation, submission lock, retry identity, flow result     |
| `storefront.orders.order-submission`   | normalized order handoff melalui injected outbound port      |
| `storefront.orders.order-confirmation` | confirmation snapshot dan recent-receipt recovery via a port |

Persistence atau external handoff tetap berupa port. Concrete implementation
dibahas bersama backend, bukan dimasukkan ke logic child.

## 7. Discovery dan Plug-and-Play

Setiap application engine menemukan parent dan children miliknya sendiri:

```ts
// packages/admin-engine
const adminParents = import.meta.glob("./engines/*/*Engine.ts", { eager: true });
const adminChildren = import.meta.glob("./engines/*/children/**/*Child.ts", {
  eager: true,
});

// packages/storefront-engine
const storefrontParents = import.meta.glob("./engines/*/*Engine.ts", {
  eager: true,
});
const storefrontChildren = import.meta.glob("./engines/*/children/**/*Child.ts", { eager: true });
```

Urutan aktivasi:

```text
Discover unknown candidates
  → validate parent and child contracts
  → reject duplicate IDs
  → reject orphan children
  → resolve dependency graph
  → initialize parents
  → initialize eligible children
  → register provided capabilities
  → expose read-only snapshot
```

Aturan runtime:

1. Tidak ada central hardcoded parent/child list.
2. Menambah child membuatnya ditemukan pada build berikutnya.
3. Menghapus child menghapus capability child tanpa edit parent.
4. Missing required dependency membuat child tersebut unavailable.
5. Failure satu child tidak mematikan sibling independen.
6. Dependency failure hanya merambat ke child yang benar-benar membutuhkannya.
7. `initialize()` dan `dispose()` idempotent.
8. Disposal menghapus capability dan state milik runtime tersebut.
9. Admin discovery tidak pernah memindai Storefront.
10. Storefront discovery tidak pernah memindai Admin.

## 8. Capability Graph per Runtime

### Admin

```text
admin.dashboard.overview
├─ requires admin.orders.read
├─ requires admin.inventory.materials-read
└─ requires admin.finance.ledger-read

admin.dashboard.reports
├─ requires admin.orders.read
├─ requires admin.inventory.stock-movements
└─ requires admin.finance.ledger-read

admin.inventory.hpp-calculation
└─ requires admin.menu.catalog-read

admin.orders.order-cancellation
├─ requires admin.orders.read
├─ requires admin.inventory.stock-reversal
├─ requires admin.finance.refund-projection
└─ requires admin.atomic-operation

admin.pos.checkout
├─ requires admin.pos.session
├─ requires admin.pos.cart
├─ requires admin.menu.catalog-read
├─ requires admin.inventory.stock-consumption
├─ requires admin.orders.order-submission
├─ requires admin.finance.transaction-recording
└─ requires admin.atomic-operation
```

### Storefront

```text
storefront.catalog.menu-detail
└─ requires storefront.catalog.read

storefront.cart.management
└─ requires storefront.catalog.read

storefront.checkout.submission
├─ requires storefront.cart.management
├─ requires storefront.catalog.read
└─ requires storefront.orders.order-submission

storefront.orders.order-confirmation
└─ requires storefront.orders.order-submission
```

Storefront order submission memakai outbound port milik Storefront composition.
Admin order reading memakai outbound port milik Admin composition. Cara kedua
runtime bertemu di production sengaja belum ditentukan dalam dokumen ini.

## 9. Cross-Child dan Cross-Runtime Contract

Child hanya boleh berkomunikasi melalui capability:

```ts
// Forbidden
import { reverseStock } from "../../inventory/children/stock-reversal";

// Allowed
const reverseStock = capabilities.resolve("admin.inventory.stock-reversal");
```

Cross-runtime import selalu dilarang:

```ts
// Forbidden inside storefront-engine
import { submitOrder } from "@warungmeng/admin-engine";

// Forbidden inside admin-engine
import { customerCart } from "@warungmeng/storefront-engine";
```

Jika behavior perlu dipakai kedua runtime:

1. pure invariant dapat dipindahkan ke `packages/domain`;
2. application orchestration tetap berada di engine pemilik;
3. operational exchange menggunakan external integration contract yang akan
   dirancang pada pembahasan backend;
4. tidak ada shared mutable registry, repository singleton, atau in-memory
   capability graph lintas server.

## 10. Atomic Workflow Boundary

Workflow multi-owner tetap harus atomik, tetapi concrete transaction mechanism
belum ditentukan di dokumen ini.

```ts
export interface AtomicOperationPort {
  execute<T>(operation: () => Promise<T> | T): Promise<T>;
}
```

### Admin order cancellation

```text
validate order
  → cancel order
  → reverse inventory
  → project finance refund
  → commit as one operation

any failure
  → rollback all affected owners
  → return normalized failure
```

### Admin POS checkout

```text
validate session and cart
  → submit order
  → consume inventory
  → record finance transaction
  → clear committed cart
  → commit as one operation

any failure
  → rollback affected owners
  → preserve retry-safe request identity
```

### Storefront checkout

```text
validate cart and submission lock
  → submit through Storefront order capability
  → store normalized success in Storefront runtime

failure
  → preserve retry-safe state
  → return normalized failure
```

Tidak ada concrete adapter atau backend transport yang dikunci di sini.

## 11. Import Contract

Diizinkan:

```text
module-system → TypeScript standard library only

domain → TypeScript standard library only

admin-engine root
  → module-system
  → domain
  → admin-engine internal public contracts

storefront-engine root
  → module-system
  → domain
  → storefront-engine internal public contracts

parent
  → module-system public contracts
  → same-parent contracts

child
  → module-system public contracts
  → domain public contracts
  → same-parent contracts
  → capability registry
  → injected outbound port types
```

Dilarang:

```text
module-system → Warung Meng business logic
module-system → React/router/AntD/CSS

domain → application engine
domain → React/router/AntD/CSS
domain → concrete adapter

parent → child implementation
parent → repository implementation

child A → child B implementation
child → React/router/AntD/CSS
child → apps/*
child → concrete adapter

admin-engine → storefront-engine
storefront-engine → admin-engine

admin-engine → ui-core
storefront-engine → ui-core
```

## 12. File-Efficiency Rules

1. Parent default hanya dua file:
   - `<area>Engine.ts`;
   - `<area>Contracts.ts`.
2. Parent tidak memperoleh behavior hanya untuk mengurangi jumlah child.
3. Child sederhana default hanya dua file:
   - `<feature>Child.ts`;
   - `<feature>.test.ts`.
4. Child kompleks boleh memiliki satu file algorithm/workflow tambahan bila
   perlu diuji terpisah.
5. Satu child mewakili satu cohesive feature, bukan satu function atau satu
   route string.
6. Create/edit dapat menjadi satu editor child bila invariant dan lifecycle-nya
   sama.
7. List/detail dapat memakai satu read child bila contract read-nya memang satu
   feature; parent tetap tidak memiliki read behavior.
8. Action tanpa halaman, seperti cancellation atau stock reversal, tetap child.
9. Tidak membuat folder `commands/`, `queries/`, `models/`, `ports/`,
   `services/`, `helpers/`, atau `utils/` sebelum benar-benar memiliki beberapa
   owner/file yang jelas.
10. Tidak membuat `manifest.ts`, `extension.ts`, dan `index.ts` untuk setiap
    child. Descriptor dan factory berada di `<feature>Child.ts`.
11. Registration topology diuji sekali per application engine graph.
12. Tidak membuat speculative abstraction atau empty directory.

## 13. UI Boundary

Logic engine hanya menghasilkan:

- state snapshot;
- query capability;
- command capability;
- normalized result/error;
- capability availability;
- diagnostics;
- subscription dan lifecycle.

Logic engine tidak memiliki:

- route/path/navigation;
- screen/component;
- layout/widget;
- renderer/theme/CSS;
- responsive policy;
- presentation fallback.

Admin dan Storefront UI hanya boleh mengakses public entry masing-masing:

```text
apps/admin        → @warungmeng/admin-engine
apps/storefront   → @warungmeng/storefront-engine
```

Internal child path tidak boleh menjadi public UI dependency.

## 14. Completion Criteria

Target logic dianggap lengkap hanya jika:

- Admin dan Storefront mempunyai application engine terpisah;
- kedua engine tidak saling mengimpor;
- tidak ada shared mutable runtime lintas production artifact;
- seluruh feature behavior dimiliki child yang jelas;
- parent hanya menjadi engine host;
- seluruh child dapat diuji tanpa UI framework;
- discovery tidak memakai central hardcoded child list;
- orphan, duplicate, cycle, dan missing dependency tervalidasi;
- cross-child access hanya melalui capability;
- cross-runtime interaction tidak memakai in-memory capability;
- atomic workflow terbukti rollback-safe dan retry-safe sesuai owner-nya;
- initialization dan disposal idempotent;
- public entry tidak mengekspos internal child implementation;
- tidak ada legacy business logic tersisa di UI handler, hook, screen, atau
  component;
- capability dan query/command/result/error contracts siap dibekukan sebelum
  pembangunan UI dimulai.

## 15. Hal yang Sengaja Ditunda untuk Pembahasan Backend

Dokumen ini belum menentukan:

- concrete repository implementation;
- persistence ownership;
- transport protocol;
- authentication atau authorization;
- synchronization mechanism;
- deployment topology di luar pemisahan Admin dan Storefront;
- cara external integration contract diimplementasikan.

Keputusan backend nanti wajib mempertahankan batas berikut:

```text
Admin runtime terpisah
Storefront runtime terpisah
Tidak ada shared in-memory singleton
Integration hanya melalui stable external contract
```
