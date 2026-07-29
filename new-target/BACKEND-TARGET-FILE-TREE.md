# Warung Meng — Target Backend File Tree

## 1. Status, Authority, dan Ruang Lingkup

Dokumen ini adalah **planning target backend**, bukan deskripsi source saat ini
dan bukan izin untuk langsung menulis implementation.

Dokumen ini mengisi boundary backend yang sengaja belum ditentukan pada:

- `new-target/LOGIC-TARGET-FILE-TREE.md`;
- `new-target/UI-TARGET-FILE-TREE.md`.

Keputusan user yang menjadi dasar:

1. data backend disiapkan dan dibekukan sebelum logic implementation;
2. data yang dipakai mockup harus dipetakan, bukan dibuat ulang dari ingatan;
3. WooCommerce dipakai sebagai commerce persistence/integration;
4. WooCommerce tidak mengambil alih seluruh domain operasional Warung Meng;
5. Admin dan Storefront tetap merupakan production artifact terpisah;
6. backend menjadi external integration boundary, bukan shared in-memory
   singleton;
7. target harus modular, headless, plug-and-play, dan hemat file;
8. lima dokumen utama `document contexts/01-PRD.md` sampai
   `document contexts/05-RULES.md` tidak diubah oleh pekerjaan planning ini.

Dokumen ini mencakup:

- source-of-truth dan ownership data;
- target production topology;
- satu backend parent dan domain children;
- WooCommerce boundary;
- target file tree;
- API, event, persistence, seed, transaction, dan deployment contract;
- urutan implementasi serta stop-gate.

Dokumen ini tidak mencakup:

- implementation backend;
- perubahan domain/data contract;
- instalasi dependency;
- Docker scaffold aktual;
- migrasi source frontend;
- payment provider;
- authentication atau role;
- UI, CSS, layout, route, atau responsive behavior;
- isi row-by-row canonical seed.

Isi data secara rinci dibuat setelah target ini disetujui dalam dokumen terpisah:

```text
new-target/CANONICAL-SEED-DATA.md
```

## 2. Urutan Arsitektur yang Dikunci

Urutan kerja:

```text
Backend target approval
  → canonical data inventory
  → ownership + schema freeze
  → deterministic seed compiler
  → local WooCommerce persistence populated
  → stable backend contracts
  → Admin/Storefront logic engines
  → backend adapters and engine wiring
  → shared UiCore
  → staging and production
```

Logic tidak boleh dibangun dengan entity atau field yang dikarang. Sebelum
logic implementation dimulai, minimum berikut harus sudah tersedia:

1. canonical source registry;
2. reference/demo/test classification;
3. entity relationship map;
4. stable identity map;
5. known-gap register;
6. normalized seed;
7. schema validation;
8. stable outbound contract untuk kedua engine.

UI tetap dibangun setelah logic selesai sesuai
`new-target/UI-TARGET-FILE-TREE.md`.

## 3. Production Boundary

Target mempunyai tiga runtime yang berbeda:

```text
Admin production artifact
├─ apps/admin
├─ packages/admin-engine
└─ packages/ui-core

Storefront production artifact
├─ apps/storefront
├─ packages/storefront-engine
└─ packages/ui-core

Backend production artifact
├─ backend/gateway
├─ backend/core
├─ WordPress
├─ WooCommerce
└─ persistent database + media storage
```

Hubungannya:

```text
Admin Engine outbound ports
  → Admin backend client
  → Backend Gateway private API
  → WarungMeng Backend Core
  → WooCommerce/custom persistence

Storefront Engine outbound ports
  → Storefront backend client
  → Backend Gateway public API
  → WarungMeng Backend Core
  → WooCommerce/custom persistence

WooCommerce events
  → Backend Core event bridge
  → durable outbox
  → Gateway event stream
  → Admin refresh/SSE subscriber
```

Aturan mutlak:

```text
admin-engine       ✕ storefront-engine
storefront-engine  ✕ admin-engine

admin/storefront UI ✕ WooCommerce REST secret
admin/storefront UI ✕ direct database
admin/storefront UI ✕ WordPress internal table

backend/core       ✕ React/AntD/CSS/router
backend/gateway    ✕ business calculation
WooCommerce adapter ✕ UI state
```

`packages/admin-engine` dan `packages/storefront-engine` tetap transport-neutral.
Keduanya hanya mengenal outbound port miliknya. Concrete HTTP client dipasang
oleh composition root application.

## 4. Peran WooCommerce yang Dikunci

WooCommerce adalah **commerce system**, bukan keseluruhan Warung Meng engine.

### WooCommerce menjadi authoritative owner untuk

- product/menu commerce record;
- product category;
- publish/visibility status;
- base price;
- product media relation;
- simple stock projection bila digunakan;
- cart/checkout session dari Store API;
- commerce order dan historical order line snapshot;
- payment/settlement record setelah provider disetujui.

### WarungMeng Backend Core menjadi authoritative owner untuk

- internal outlet ID dan external outlet mapping;
- business hours dan special schedules;
- variant selection rules yang tidak dapat direpresentasikan secara aman sebagai
  kombinasi Woo variation;
- supplier, ingredient, recipe, HPP;
- ingredient stock balance dan stock movement;
- consume/reverse inventory berdasarkan order;
- manual finance transaction;
- automatic finance projection;
- POS session, cash reconciliation, dan pending operational sync;
- idempotency record;
- technical audit log;
- durable event outbox;
- operational reporting projection.

### Data turunan, bukan source of truth baru

- Dashboard summary;
- sales/menu/inventory report;
- automatic sale/refund finance rows;
- HPP projection;
- low-stock projection;
- POS expected cash;
- Woo simple product stock bila ingredient inventory menjadi authority.

Data turunan tidak boleh di-seed sebagai record kedua bila dapat dihitung dari
source authority.

## 5. Backend Parent–Child Contract

Prinsip:

> **Parent = Backend Host. Child = domain module yang memiliki seluruh query,
> command, persistence policy, dan event contract untuk satu ownership area.**

Backend hanya mempunyai satu parent:

```text
WarungMengBackendHost
```

Parent hanya memiliki:

- configuration validation;
- module registration dan lifecycle;
- transaction/outbox infrastructure;
- health dan readiness snapshot;
- diagnostics;
- public/private transport attachment;
- graceful startup dan shutdown.

Parent dilarang memiliki:

- catalog query;
- order command;
- HPP calculation;
- inventory mutation;
- finance projection;
- POS workflow;
- report aggregation;
- WooCommerce field mapping.

Domain children:

| Child       | Ownership                                                              |
| ----------- | ---------------------------------------------------------------------- |
| `outlets`   | outlet identity, external mapping, business hours, special schedule    |
| `catalog`   | category, menu, variant rules, commerce media, Woo product mapping     |
| `orders`    | create/read/transition/cancel, status events, historical line snapshot |
| `inventory` | suppliers, ingredients, balances, recipes, movements, consume/reverse  |
| `finance`   | manual ledger, order-derived sale/refund, void semantics               |
| `pos`       | cashier session, checkout handoff, close record, reconciliation        |
| `reporting` | read-only projections from authoritative modules                       |

Tidak dibuat module kosong untuk payment, customer account, delivery, loyalty,
atau multi-outlet. Folder baru hanya dibuat setelah scope dan owner disetujui.

### Module gate

Setiap domain mempunyai tepat satu module gate:

```text
<Domain>Module
```

Module gate hanya:

- mendeklarasikan module ID;
- mendeklarasikan capability;
- memasang operation set;
- memasang repository adapter;
- memasang route/event contribution;
- expose health/diagnostic state.

Business behavior berada pada cohesive operation child. Tidak dibuat satu file
per endpoint kecil.

Default per domain:

```text
<Domain>Module
<Domain>Operations
```

Operation baru dipisahkan menjadi file sendiri hanya jika mempunyai salah satu
alasan berikut:

- transaction boundary mandiri;
- lifecycle mandiri;
- failure/retry policy mandiri;
- independent plug-and-play capability;
- characterization test boundary yang berbeda.

Contoh yang memang layak dipisah:

- `CreateOrder`;
- `CancelPaidOrder`;
- `ConsumeOrderInventory`;
- `ReverseOrderInventory`;
- `ClosePosSession`.

## 6. Stable Backend Contract

Backend contract harus serialization-neutral dan tidak bergantung pada
WooCommerce response shape.

Canonical contract disimpan sebagai OpenAPI + JSON Schema. TypeScript client dan
server DTO dihasilkan dari contract tersebut; tidak ditulis ulang manual pada
setiap consumer.

Minimum envelope:

```ts
export interface BackendRequestContext {
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly locale?: "id" | "en";
  readonly occurredAt?: string;
}

export type BackendErrorCode =
  | "validation-failed"
  | "not-found"
  | "conflict"
  | "invalid-transition"
  | "capability-unavailable"
  | "dependency-failed"
  | "rate-limited"
  | "internal-error";

export type BackendResult<T> =
  | { readonly ok: true; readonly data: T; readonly requestId: string }
  | {
      readonly ok: false;
      readonly code: BackendErrorCode;
      readonly message: string;
      readonly requestId: string;
      readonly retryable: boolean;
    };

export interface BackendEventEnvelope<TType extends string, TPayload> {
  readonly id: string;
  readonly type: TType;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly occurredAt: string;
  readonly payload: TPayload;
}
```

Contract rules:

1. amount IDR memakai integer minor-unit policy yang dibekukan;
2. timestamp memakai ISO 8601 dan server-authoritative clock;
3. ID eksternal tidak menggantikan canonical internal ID;
4. list endpoint memakai stable filter dan pagination contract;
5. create command wajib mempunyai idempotency key;
6. status transition mempertahankan hasil
   `updated | not-found | invalid-transition`;
7. inventory consume/reverse idempotent berdasarkan order ID;
8. API error tidak membocorkan WooCommerce/PHP/database internal;
9. private DTO dan public DTO dipisahkan;
10. contract version memakai namespace `/api/v1`.

WooCommerce plugin berjalan pada PHP, sedangkan Admin/Storefront engine dan
backend client memakai TypeScript. Karena itu:

- backend contract, schema, dan behavior examples harus language-neutral;
- server tetap menjadi authority untuk validation dan mutation outcome;
- frontend boleh melakukan deterministic pre-validation untuk UX, tetapi tidak
  boleh mengubah server rule;
- protected behavior cases dijalankan terhadap TypeScript engine dan PHP
  Backend Core;
- gateway dilarang membuat implementasi rule ketiga.

Cross-language parity test wajib melindungi:

- variant selection bounds;
- order transition;
- POS pricing;
- inventory unit conversion;
- HPP calculation;
- finance projection;
- paid/unpaid cancellation;
- Rupiah amount serialization.

## 7. Target Backend File Tree

Seluruh server-side Warung Meng dikumpulkan di satu root agar mudah ditemukan:

```text
backend/
├─ README.md
│  # [DOC] local/staging/production entry, ownership, commands
│
├─ contracts/
│  ├─ openapi/
│  │  └─ warungmeng-v1.yaml
│  │     # [CONTRACT] public/private API, errors, pagination, idempotency
│  ├─ schemas/
│  │  ├─ common.schema.json
│  │  ├─ outlets.schema.json
│  │  ├─ catalog.schema.json
│  │  ├─ orders.schema.json
│  │  ├─ inventory.schema.json
│  │  ├─ finance.schema.json
│  │  ├─ pos.schema.json
│  │  └─ reporting.schema.json
│  ├─ generated/
│  │  └─ backendContractTypes.ts
│  │     # [GENERATED] tidak diedit manual
│  ├─ backendContractParity.test.ts
│  └─ package.json
│
├─ client/
│  ├─ src/
│  │  ├─ createBackendClient.ts
│  │  ├─ storefrontBackendClient.ts
│  │  │  # [DATA] public catalog/checkout/order-confirmation calls
│  │  ├─ adminBackendClient.ts
│  │  │  # [DATA] private operational calls; secret tetap server-side
│  │  ├─ backendEventClient.ts
│  │  │  # [DATA] SSE/polling client
│  │  └─ index.ts
│  ├─ tests/
│  │  └─ backendClientContract.test.ts
│  ├─ package.json
│  └─ tsconfig.json
│
├─ gateway/
│  ├─ src/
│  │  ├─ bootstrap.ts
│  │  │  # [BOOT] process start + graceful shutdown only
│  │  ├─ createBackendGateway.ts
│  │  │  # [COMP] config + core client + transport + diagnostics
│  │  ├─ http/
│  │  │  ├─ publicApiRoutes.ts
│  │  │  │  # [TRANSPORT] Storefront-safe endpoints
│  │  │  ├─ adminApiRoutes.ts
│  │  │  │  # [TRANSPORT] private operational endpoints
│  │  │  └─ webhookRoutes.ts
│  │  │     # [TRANSPORT] provider/Woo webhook intake
│  │  ├─ realtime/
│  │  │  └─ backendEventStream.ts
│  │  │     # [TRANSPORT] SSE first; WebSocket only if proven necessary
│  │  ├─ core/
│  │  │  └─ warungMengCoreClient.ts
│  │  │     # [ADAPTER] calls backend/core; no business calculation
│  │  └─ diagnostics/
│  │     └─ backendHealthSnapshot.ts
│  ├─ tests/
│  │  └─ gatewayContract.test.ts
│  ├─ Dockerfile
│  ├─ package.json
│  └─ tsconfig.json
│
├─ core/
│  ├─ warungmeng-core.php
│  │  # [BOOT] WordPress plugin bootstrap only
│  ├─ src/
│  │  ├─ BackendHost.php
│  │  │  # [PARENT] lifecycle, module registry, diagnostics
│  │  ├─ BackendContracts.php
│  │  │  # [CONTRACT] internal module/result/context contracts
│  │  ├─ Modules/
│  │  │  ├─ Outlets/
│  │  │  │  ├─ OutletsModule.php
│  │  │  │  └─ OutletsOperations.php
│  │  │  ├─ Catalog/
│  │  │  │  ├─ CatalogModule.php
│  │  │  │  └─ CatalogOperations.php
│  │  │  ├─ Orders/
│  │  │  │  ├─ OrdersModule.php
│  │  │  │  ├─ OrdersOperations.php
│  │  │  │  ├─ CreateOrder.php
│  │  │  │  └─ CancelPaidOrder.php
│  │  │  ├─ Inventory/
│  │  │  │  ├─ InventoryModule.php
│  │  │  │  ├─ InventoryOperations.php
│  │  │  │  ├─ ConsumeOrderInventory.php
│  │  │  │  └─ ReverseOrderInventory.php
│  │  │  ├─ Finance/
│  │  │  │  ├─ FinanceModule.php
│  │  │  │  └─ FinanceOperations.php
│  │  │  ├─ Pos/
│  │  │  │  ├─ PosModule.php
│  │  │  │  ├─ PosOperations.php
│  │  │  │  └─ ClosePosSession.php
│  │  │  └─ Reporting/
│  │  │     ├─ ReportingModule.php
│  │  │     └─ ReportingOperations.php
│  │  ├─ Persistence/
│  │  │  ├─ SchemaMigrator.php
│  │  │  ├─ WooCatalogStore.php
│  │  │  ├─ WooOrderStore.php
│  │  │  ├─ OperationalStore.php
│  │  │  ├─ IdempotencyStore.php
│  │  │  └─ OutboxStore.php
│  │  ├─ Transactions/
│  │  │  └─ AtomicOperation.php
│  │  ├─ Rest/
│  │  │  └─ CoreRoutes.php
│  │  ├─ Events/
│  │  │  └─ WooEventBridge.php
│  │  └─ Diagnostics/
│  │     └─ CoreHealthSnapshot.php
│  └─ tests/
│     ├─ ModuleContractTest.php
│     ├─ OrderAtomicityTest.php
│     └─ IdempotencyTest.php
│
├─ seed/
│  ├─ raw/
│  │  └─ shopeefood/
│  │     ├─ Menu Utama.json
│  │     └─ Kategori Varian.json
│  │     # [RAW] immutable source snapshots; moved, not duplicated
│  ├─ src/
│  │  ├─ canonicalSeedManifest.ts
│  │  ├─ normalizeCanonicalSeed.ts
│  │  ├─ validateCanonicalSeed.ts
│  │  ├─ importWooCommerceSeed.ts
│  │  ├─ profiles/
│  │  │  ├─ referenceSeed.ts
│  │  │  ├─ demoSeed.ts
│  │  │  └─ testSeed.ts
│  │  └─ index.ts
│  ├─ tests/
│  │  ├─ canonicalSeedParity.test.ts
│  │  ├─ canonicalSeedRelations.test.ts
│  │  └─ repeatableImport.test.ts
│  ├─ package.json
│  └─ tsconfig.json
│
├─ acceptance/
│  ├─ storefrontOrderAppearsInAdmin.test.ts
│  ├─ cancelPaidOrderAtomicity.test.ts
│  ├─ inventoryIdempotency.test.ts
│  ├─ financeProjectionParity.test.ts
│  ├─ realtimeOrderNotification.test.ts
│  └─ seedBackupRestore.test.ts
│
└─ infra/
   ├─ compose.local.yaml
   ├─ .env.example
   ├─ wordpress.Dockerfile
   ├─ gateway.Dockerfile
   ├─ php.local.ini
   └─ scripts/
      ├─ start-local.ps1
      ├─ stop-local.ps1
      ├─ backup-local.ps1
      ├─ restore-local.ps1
      └─ verify-local.ps1
```

Tree tersebut adalah **target ownership**, bukan perintah membuat seluruh file
sekaligus. Folder/file hanya dibuat ketika phase pemiliknya dimulai.

## 8. Import Contract

Diizinkan:

```text
backend/gateway
  → backend/contracts generated types
  → backend/core HTTP client
  → transport/security/observability libraries yang disetujui

backend/core
  → WooCommerce public CRUD APIs
  → WordPress APIs
  → custom persistence
  → backend contract schema validation

backend/seed
  → immutable raw source
  → backend contracts
  → WooCommerce/core import ports

apps/* composition
  → backend/client
  → application engine public outbound ports
```

Dilarang:

```text
admin-engine/storefront-engine → backend/core implementation
ui-core                         → backend/client/contracts
backend/gateway                 → React/AntD/UI
backend/gateway                 → Woo table direct query
backend/core                    → apps/admin or apps/storefront
backend/core                    → browser storage
backend/seed                    → production mutation without profile guard
Woo webhook                     → direct UI mutation
```

## 9. Canonical Data Classification

### Reference seed

Source yang dapat dipertahankan sebagai reference baseline:

| Entity                  | Current evidence |
| ----------------------- | ---------------: |
| Menu category           |                2 |
| Menu item               |               23 |
| Variant group           |                9 |
| Variant option          |               30 |
| Menu–variant relation   |               20 |
| Menu image reference    |               23 |
| Unique image source URL |               22 |

Reference seed mempertahankan seluruh row, termasuk hidden, unavailable, tracked,
untracked, orphan variant group, dan duplicate menu name yang berbeda ID.

### Demo seed

Data berikut adalah current mockup fixture, bukan bukti transaksi operasional
nyata:

| Entity                     | Current fixture |
| -------------------------- | --------------: |
| Supplier                   |               3 |
| Ingredient                 |              11 |
| Stock balance              |              11 |
| Recipe                     |               4 |
| Recipe component           |              16 |
| Inventory movement         |               1 |
| Order / item / event       |      6 / 6 / 11 |
| Manual finance transaction |               5 |

Demo seed:

- hanya boleh berjalan pada development/staging/demo;
- tidak boleh auto-run pada production;
- harus diberi provenance `demo`;
- tidak boleh dipresentasikan sebagai real operational history;
- boleh dinormalisasi hanya melalui deterministic mapping yang tercatat.

### Test seed

Test seed adalah fixture minimal per behavior. Test fixture tidak boleh masuk ke
runtime reference atau demo seed.

### Client-only state

Tidak masuk backend reference seed:

- theme preference;
- locale preference;
- active UI filter;
- recent receipt cache;
- local cart cache;
- sidebar state;
- temporary form draft.

POS session menjadi backend operational state pada target production. Browser
storage hanya boleh menjadi recovery cache selama migrasi.

## 10. Identity dan Relationship Decisions

Data canon wajib menyelesaikan:

1. internal outlet `wm-1` dan external Store ID `22261894`;
2. canonical menu ID versus Woo numeric product ID;
3. raw variant group/option ID versus Woo attribute/variation ID;
4. six demo order item IDs yang sekarang tidak menunjuk canonical menu ID;
5. recipe coverage yang baru tersedia untuk 4 dari 23 menu;
6. media source URL versus owned media asset ID;
7. server timestamp versus browser-generated timestamp;
8. order number generation authority;
9. event version dan idempotency ownership;
10. current business-hours fixture `09:00–17:00` yang belum terbukti sebagai
    real operational hours;
11. pricing conflict: current demo order/POS memakai tax 10%, sedangkan
    Storefront checkout memakai tax 0%;
12. rounding conflict: POS memakai step Rp100, sedangkan Storefront memakai
    step 0;
13. finance attachment yang baru mempunyai metadata tetapi tidak mempunyai file
    asset;
14. Storefront default order repository yang saat ini memang dimulai kosong.

Target identity map:

```text
canonicalMenuId
  ↔ Woo product ID
  ↔ Woo SKU/custom metadata

canonicalOutletId: wm-1
  ↔ external source ID: 22261894
  ↔ Woo store installation identity
```

Mapping tersebut harus tercatat di seed manifest. External ID tidak boleh
menjadi primary key domain.

Missing recipe berarti `recipe-not-configured`; bukan izin membuat bahan,
quantity, waste, atau HPP baru.

Business hours, tax, rounding, dan attachment yang belum mempunyai source sah
masuk `knownGaps`, bukan reference seed. Enam demo order tidak boleh muncul
sebagai customer history Storefront; order tersebut hanya boleh dipakai pada
Admin/demo profile.

## 11. Seed Manifest Contract

Setiap dataset mempunyai:

```ts
export interface CanonicalSeedManifest {
  readonly datasetId: string;
  readonly profile: "reference" | "demo" | "test";
  readonly sourceFiles: readonly {
    readonly path: string;
    readonly checksum: string;
  }[];
  readonly transformerVersion: string;
  readonly generatedAt: string;
  readonly entityCounts: Readonly<Record<string, number>>;
  readonly deterministicMappings: readonly string[];
  readonly knownGaps: readonly string[];
}
```

Seed gate:

1. source checksum cocok;
2. canonical ID unik;
3. seluruh foreign key resolve;
4. menu–variant relation valid;
5. recipe component menunjuk ingredient valid;
6. normalized demo order menunjuk canonical menu;
7. amount valid sebagai IDR;
8. timestamp valid;
9. import kedua tidak membuat duplicate;
10. demo profile ditolak pada production;
11. derived finance row tidak disimpan sebagai manual finance duplicate;
12. balance snapshot tidak direkayasa menjadi movement history.

## 12. Media Contract

Current CDN URL adalah source reference, bukan bukti kepemilikan asset.

Target media record:

```ts
export interface BackendMediaAsset {
  readonly id: string;
  readonly sourceUrl: string;
  readonly ownedUrl: string | null;
  readonly checksum: string | null;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly status: "external-reference" | "ingested" | "missing" | "failed";
}
```

Tahap awal mempertahankan exact source URL untuk parity. Production gate
memerlukan ingest ke media storage yang dimiliki Warung Meng atau keputusan
eksplisit untuk tetap memakai external reference.

Gambar menu yang saat ini sudah merupakan satu composition tidak boleh dipecah
menjadi background/frame/transparent layer secara otomatis. Perubahan asset
tersebut adalah workflow desain terpisah.

## 13. Order, Inventory, dan Finance Transaction Boundary

Protected behavior:

```text
paid order cancellation
  → order cancelled
  → payment/refund state projected
  → inventory consumption reversed
  → finance refund projected
  → one externally observable result
```

Semua efek harus:

- atomic dari sudut pandang caller;
- idempotent;
- retry-safe;
- failure-injection tested;
- tidak menghasilkan half-applied state.

### Mandatory WooCommerce feasibility gate

Sebelum implementation `CancelPaidOrder` diterima:

1. buktikan Woo order mutation dan custom operational mutation dapat
   diselesaikan/di-rollback melalui satu authoritative command;
2. buktikan failure setelah setiap mutation step tidak meninggalkan partial
   state;
3. buktikan retry dengan idempotency key menghasilkan outcome yang sama.

Jika WooCommerce + custom table tidak dapat memenuhi gate tersebut:

- jangan menyebut saga setengah jadi sebagai atomic;
- operational order workflow dipindahkan menjadi authority
  `WarungMeng Operational Store`;
- WooCommerce menerima projection/synchronization setelah commit;
- Admin dan Storefront tetap memakai backend contract yang sama.

Engines tidak boleh berubah hanya karena persistence authority berpindah.

## 14. Public, Private, dan Event Surface

### Public Storefront surface

Diizinkan:

- public catalog/category/menu;
- availability;
- cart/checkout session;
- create order dengan idempotency;
- confirmation untuk order identity milik caller;
- public business hours.

Tidak diizinkan:

- list semua order;
- manual finance;
- ingredient cost/HPP internal;
- stock movement detail;
- POS session;
- diagnostic internal;
- Woo REST credential.

### Private Admin surface

- catalog management;
- order management;
- inventory and recipe management;
- finance manual transaction;
- POS session;
- reporting;
- diagnostics terbatas.

Admin private surface dipisahkan dari public storefront pada reverse proxy.
Auth/role tetap deferred, tetapi private API tidak boleh dianggap aman hanya
karena UI tidak menampilkan link. Development/staging dapat memakai IP
allowlist dan environment-specific access control.

### Event surface

Webhook adalah notification input, bukan source of truth.

Reliable flow:

```text
Woo/provider event
  → validate signature
  → deduplicate event ID
  → reconcile authoritative aggregate
  → commit
  → durable outbox
  → publish SSE event
  → periodic reconciliation as safety net
```

SSE diprioritaskan untuk incoming-order/admin refresh. WebSocket hanya ditambah
jika two-way realtime requirement benar-benar muncul.

## 15. Local Hosting Simulation Target

Local environment:

```text
Docker Desktop
├─ wordpress + WooCommerce
├─ MySQL/MariaDB
├─ WarungMeng Backend Core plugin
├─ Backend Gateway
└─ named persistent volumes

Host development
├─ Admin
└─ Storefront
```

Local environment harus mensimulasikan:

- process/network boundary;
- persistent restart;
- real HTTP contract;
- Woo Store API and REST behavior;
- seed/import;
- webhook delivery;
- order event notification;
- backup/restore;
- failure/retry.

Local Docker bukan production hosting. Public tunnel hanya untuk temporary
integration test. Staging/production memerlukan:

- stable domain/subdomain;
- HTTPS;
- persistent storage;
- secret management;
- backup retention;
- restore drill;
- health monitoring;
- log retention;
- controlled updates;
- rollback procedure.

`WORDPRESS_DEBUG` dan demo seed wajib mati pada production.

## 16. File-Efficiency Rules

1. Seluruh backend server source berada di satu root `backend/`.
2. Tepat satu backend parent.
3. Tepat satu module gate per ownership domain.
4. Tidak membuat module per endpoint.
5. Default satu operation set per domain.
6. File operation terpisah hanya untuk independent transaction/lifecycle.
7. Gateway tidak mempunyai duplicate business services.
8. Satu canonical OpenAPI/JSON Schema source; generated types tidak diedit.
9. Satu seed normalizer; tidak ada seed mapper per app.
10. Satu stable backend client package dengan public/admin entry terpisah.
11. Tidak membuat wrapper yang hanya meneruskan nama method tanpa normalization,
    security, transport, atau ownership value.
12. Tidak membuat generic repository sebelum minimal dua concrete consumers
    membutuhkan contract yang sama.
13. Tidak membuat empty payment/auth/delivery module.
14. Test difokuskan pada contract, behavior, atomicity, idempotency, dan data
    integrity; bukan private implementation detail.

## 17. Implementation Sequence

### BE-00 — Target approval

- Review dokumen ini.
- Kunci peran WooCommerce.
- Kunci backend parent/children.
- Kunci file-efficiency rules.
- Tidak ada source implementation.

### BE-01 — Canonical data freeze

- Tulis `new-target/CANONICAL-SEED-DATA.md`.
- Catat seluruh source, count, identity, relation, derivation, dan gap.
- Tentukan mapping `wm-1` ↔ `22261894`.
- Tentukan demo versus reference versus test.

Gate:

- tidak ada unknown production mock source;
- tidak ada fixture synthetic masuk reference seed;
- tidak ada missing relation disembunyikan.

### BE-02 — Contract and schema freeze

- Tulis OpenAPI/JSON Schema target.
- Kunci money/time/error/pagination/idempotency contract.
- Kunci source ownership per entity.
- Kunci public/private surface.

Gate:

- Admin dan Storefront outbound port dapat dipetakan tanpa business-rule patch;
- backend contract tidak membocorkan Woo response shape;
- perubahan domain contract mendapat approval terpisah.

### BE-03 — Deterministic seed compiler

- Implement raw snapshot registry.
- Implement normalization.
- Implement reference/demo/test profile.
- Implement validation dan repeatable import.

Gate:

- counts parity;
- relations valid;
- import dua kali tidak duplicate;
- production menolak demo seed.

### BE-04 — Local WooCommerce runtime

- Implement Docker local environment.
- Install/lock compatible WordPress + WooCommerce.
- Enable/verify HPOS.
- Import reference seed.
- Verify persistent restart dan backup/restore.

Gate:

- 23 menu dan seluruh variant source terpetakan;
- hidden/unavailable data tetap ada;
- restart tidak menghapus data;
- secret tidak masuk Git.

### BE-05 — Backend Core and Gateway

- Implement backend parent.
- Implement domain module gates.
- Implement Woo/custom persistence adapters.
- Implement public/private API.
- Implement idempotency, outbox, and diagnostics.
- Jalankan atomicity feasibility gate.

Gate:

- no half-applied paid cancellation;
- stable contract parity;
- one domain authority per record;
- gateway bebas business calculation.

### BE-06 — Logic engine contract integration

- Bangun/selesaikan Admin dan Storefront engines terhadap outbound port yang
  sudah dibekukan.
- Implement concrete backend client pada app composition boundary.
- Pertahankan mock adapter untuk isolated unit tests.

Gate:

- engine tests tidak membutuhkan WordPress;
- integration tests memakai local backend;
- tidak ada direct Woo import di engine/UI.

### BE-07 — Realtime and acceptance

- Webhook reconciliation.
- Durable outbox.
- SSE order events.
- Storefront create order → Admin visibility.
- POS checkout → inventory/finance effects.
- Cancellation/retry/failure injection.

### BE-08 — Staging and operational readiness

- Stable HTTPS domain.
- Admin/private access boundary.
- Monitoring/logging.
- backup schedule dan restore drill;
- migration/rollback procedure;
- staging seed and UAT.

## 18. Hard Stop Conditions

Stop implementation apabila:

- canonical data belum dibekukan;
- seed masih mengarang missing recipe/transaction;
- WooCommerce response shape masuk logic engine;
- REST secret masuk browser atau Git;
- Admin/Storefront mengakses database langsung;
- satu record memiliki dua writable source of truth;
- paid cancellation menghasilkan partial state;
- demo seed dapat berjalan di production;
- webhook dianggap source of truth tunggal;
- gateway mulai memiliki duplicate domain calculation;
- module dibuat per endpoint dan menyebabkan file bloat;
- backend implementation dimasukkan ke `ui-core`, `admin-engine`, atau
  `storefront-engine`;
- auth/payment/delivery scope ditambahkan tanpa approval;
- canonical document `01–05` diedit hanya untuk menyesuaikan implementation;
- implementation menuntut perubahan business behavior yang belum disetujui.

Owner per masalah:

```text
Missing or doubtful source data    → CANONICAL-SEED-DATA
Entity/invariant mismatch          → domain contract approval
Transport/API mismatch             → backend/contracts
Woo mapping/persistence mismatch   → backend/core Persistence
Atomic workflow failure            → owning backend module
Secret/CORS/access boundary        → backend/gateway + infra
Frontend orchestration             → owning Admin/Storefront logic child
Presentation requirement           → ui-core gate/layout/widget
```

## 19. Completion Criteria

Backend target dianggap tercapai hanya jika:

1. data reference/demo/test terpisah;
2. source provenance dan checksum tercatat;
3. local WooCommerce berisi canonical catalog;
4. persistent restart, seed, backup, dan restore terbukti;
5. Admin dan Storefront memakai stable external contracts;
6. tidak ada Woo credential di frontend;
7. protected repository semantics tetap sama;
8. order create idempotent;
9. paid cancellation atomic dan idempotent;
10. inventory consume/reverse idempotent;
11. automatic finance tidak diduplikasi;
12. realtime order event mempunyai reconciliation fallback;
13. backend module dapat diuji tanpa UI;
14. engine dapat diuji tanpa backend concrete implementation;
15. WooCommerce dapat diganti sebagai adapter tanpa menulis ulang logic engine
    atau `ui-core`.

## 20. Non-Goals yang Tetap Deferred

- multi-outlet runtime;
- customer account dan order history;
- delivery zone/fee/ETA;
- payment provider;
- settlement provider;
- loyalty/voucher/membership;
- hardware POS;
- marketing automation;
- production deployment aktual;
- auth/role implementation;
- speculative microservices.

Deferred scope tidak menghasilkan empty folder atau placeholder implementation.
