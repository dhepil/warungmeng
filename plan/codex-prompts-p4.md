# Prompt Codex — P4-storefront-engine

**Enam slice, jalankan SATU PER SATU**, masing-masing di sesi Codex sendiri.
Setiap slice berakhir dengan `npm run check` hijau → commit → catat → **STOP dan
lapor**. Jangan gabungkan. Setelah tiap slice selesai, kirim laporannya ke sesi
review untuk diperiksa.

Urutan dikunci oleh capability graph LOGIC §8 — tidak bisa dibangun sebelum yang
diperlukannya ada:

| Slice | Isi | Kenapa urutannya begitu |
|---|---|---|
| **S1** | scaffold + `storefrontEngineContracts` + `storefrontEngineSnapshot` | fondasi, tidak bergantung apa pun |
| **S2** | `createStorefrontEngine` + `discoverStorefrontLogic` + `index` | ruang mesin; sesudah ini area bisa ditemukan |
| **S3** | catalog — `catalog-read`, `menu-detail` | tiga area lain memerlukan catalog-read |
| **S4** | cart — `cart-management` | perlu catalog-read |
| **S5** | orders — `order-submission`, `order-confirmation` | checkout perlu order-submission |
| **S6** | checkout — `checkout-submission` + `submitCheckoutSafely.ts` | perlu cart + catalog + order-submission |
| **S7** | `storefrontEngineGraph.test.ts` — phase gate | penutup fase, buktikan kelengkapan |

---

## ⚠️ SATU HAL YANG HARUS DIPUTUSKAN PEMILIK SEBELUM S3

**Dokumen otoritas bertentangan dengan dirinya sendiri soal dua id kapabilitas.**
Saya temukan saat menyiapkan prompt ini, dan ini bukan hal yang boleh ditebak agen:

| | §6 (tabel scope, baris 455/457) | §8 (capability graph, baris 559-570) |
|---|---|---|
| catalog read | `storefront.catalog.catalog-read` | `storefront.catalog.read` |
| cart | `storefront.cart.cart-management` | `storefront.cart.management` |

§8 adalah yang dipakai sebagai `requires` oleh tiga child lain, jadi kalau salah,
tiga child akan gagal resolve dan jadi unavailable. Ini persis kelas kesalahan yang
di S8 Admin membuat 16 dari 20 tes gagal.

**Slice S3 WAJIB berhenti dan menanyakan ini ke pemilik sebelum menulis kode**,
lalu commit pertamanya menyelaraskan §6 dan §8 agar konsisten. Jangan pilih sendiri.
Rekomendasi untuk diajukan: pakai bentuk §8 (`storefront.catalog.read`,
`storefront.cart.management`) karena itu yang dirujuk `requires`, dan perbaiki §6.

---

## Yang berlaku untuk SEMUA slice P4 (salin ke tiap sesi)

```
BACA DULU, URUT:
  1. CLAUDE.md                 (kontrak build-agent — 8 aturan keras)
  2. plan/roadmap.md           (blok P4)
  3. plan/plan.json            (otoritas LETAK file — P4 punya 8 entri `exact`)
  4. plan/p3-handoff.md        (bagian penutup S13 ditulis KHUSUS untuk P4)
  5. plan/tech-debt.md         (D27 dan D3 punya aksi berdiri di P4)

LALU `npm run check` dan pastikan 4/4 hijau sebelum menyentuh apa pun.

CATATAN TOOLCHAIN — BACA SEBELUM MENDIAGNOSIS CHECK MERAH:
Kalau merah HANYA di `tests` (structure/boundaries/typecheck hijau) dengan error
rolldown "Cannot find native binding", itu bentrokan install Windows/WSL yang sudah
dikenal, BUKAN drift. Perbaiki:
    git status --short package-lock.json   (kalau kotor: git checkout -- package-lock.json)
    npm install --no-save @rolldown/binding-linux-x64-gnu     (Linux/WSL)
    npm install --no-save @rolldown/binding-win32-x64-msvc    (Windows)
`--no-save` menjaga lockfile bersih. JANGAN hapus node_modules atau lockfile.
Berulang di S9-S13, DS-A, DS-B. Singkirkan dulu SEBELUM meragukan sesi lain.

TITIK MULAI: P1, P2, P3 DONE. Blok utang PD (DS-A..DS-D) DONE. 545 tes, 91 file,
25 child, tree bersih di 08aae29. `activePhase` sudah `P4-storefront-engine`.
`packages/storefront-engine/` BELUM ADA — S1 yang membuatnya.

BATAS YANG TIDAK BOLEH DILANGGAR (LOGIC §11, ditegakkan check:boundaries):
- storefront-engine ✕ admin-engine. Sama sekali. Kalau butuh perilaku Admin,
  BERHENTI dan tanya — jawabannya hampir pasti "pindahkan invariant murni ke
  packages/domain" atau "itu milik composition root", bukan impor.
- storefront-engine ✕ React / AntD / router / CSS. Ini paket headless.
- packages/domain dan packages/module-system adalah fase TERTUTUP. Impor, jangan ubah.
  Kalau terasa perlu mengubahnya, BERHENTI dan tanya pemilik.
- Impor lintas-child DILARANG. Selesaikan lewat capability, jangan impor saudara.
- Tidak ada kosakata UI di logic — tanpa label, route, icon, component (LOGIC §5/§11).
- Jangan buat file yang tidak ada di plan.json. P4 `exact` hanya 8 file; child dan
  area diizinkan lewat glob `engines/*`.
- Jangan pernah set git config global. Identitas repo-local sudah benar.

POLA YANG SUDAH TERBUKTI DI P3 — PAKAI, JANGAN DITEMUKAN ULANG:
- `import.meta.glob` HARUS ditulis literal. Mengaliaskan ke variabel lolos tsc lalu
  MELEDAK saat runtime. Perlu augmentasi `ImportMeta` sempit agar tsc lolos. Pola
  nol-kecocokan mengembalikan `{}`, bukan melempar — itu sebabnya folder engines
  kosong tetap start bersih. Sudah diverifikasi eksperimen di P3 S2; jangan diuji ulang.
- Tes mencapai capability lewat PROBE CHILD yang mendeklarasikannya di `requires`,
  BUKAN panggilan `create()` langsung. Ini yang membuat id salah ketahuan.
- Port hilang ≠ child unavailable. Child tetap aktif, tetap publish, SATU diagnostic
  saat pembuatan, tiap panggilan mengembalikan failure ternormalisasi. `unavailable`
  hanya untuk "capability yang diperlukan tidak ada yang publish".
- Satu bentuk hasil: `OperationResult`. Jangan bikin union hasil khusus per area.
- Anak baca menerapkan ULANG filternya sendiri; port tidak menjanjikan apa pun.
- Setiap pengurutan wajib punya tie-break yang stabil.
- Satu kalender: Jakarta, lewat proyeksi tanggal domain.
- Sumber gagal boleh degraded selama ada sumber sehat; SEMUA gagal harus failure,
  bukan array kosong yang dipalsukan.
- MUTATION-CHECK tes penopang tiap slice: rusak perilakunya, pastikan tes gagal,
  pulihkan, `git diff` untuk bukti byte-for-byte. Tes yang tak bisa gagal lebih
  buruk daripada tidak ada tes.
- Jalankan `npm run check` LENGKAP, bukan cuma vitest. Tes bisa hijau sementara
  typecheck merah — terjadi di S8, S10, S13.

SELESAI TIAP SLICE:
check hijau → commit → satu baris di plan/porting-log.md → centang di
plan/roadmap.md + catatan progres → tulis keputusan di plan/p4-handoff.md (S1 yang
membuatnya; jangan perpanjang p3-handoff.md) → STOP dan lapor bahasa awam.
```

---

## SLICE S1 — scaffold + contracts + snapshot

```
Lanjutkan port Warung Meng. Slice: P4 S1 — scaffold storefront-engine + contracts +
snapshot. Ini slice PERTAMA fase P4.

[sisipkan blok "berlaku untuk semua slice" di atas]

YANG DIBANGUN (hanya 5 file, semuanya `exact` di plan.json):
  packages/storefront-engine/package.json
  packages/storefront-engine/tsconfig.json
  packages/storefront-engine/src/storefrontEngineContracts.ts
  packages/storefront-engine/src/storefrontEngineSnapshot.ts
  + buat plan/p4-handoff.md (catatan kerja P4; plan/** diizinkan rootAllow)

CERMIN P3 S1, TAPI JANGAN SALIN MENTAH. Baca
`packages/admin-engine/src/adminEngineContracts.ts` dan `adminEngineSnapshot.ts`
sebagai pola bentuk, lalu tulis versi Storefront. Yang HARUS berbeda:
- `STOREFRONT_NAMESPACE = "storefront"`.
- `STOREFRONT_AREAS` = empat area LOGIC §4: catalog, cart, checkout, orders.
  Sama seperti ADMIN_AREAS: ini EKSPEKTASI, bukan registry. Tidak ada yang memuat
  darinya; menambah folder area tetap bekerja tanpa menyuntingnya. Ia ada supaya
  phase gate S7 bisa mendeteksi area yang diam-diam hilang. Kalau sampai dipakai
  untuk MEMBANGUN runtime, itu melanggar LOGIC §7 aturan 1.
- **TIDAK ADA `shared/atomicOperationPort.ts`.** Ini perbedaan struktural terbesar
  dari Admin, dan disengaja: LOGIC §10 memberi checkout Storefront bentuk yang
  BERBEDA — "validate cart and submission lock → submit through Storefront order
  capability → store normalized success", dengan kegagalan "preserve retry-safe
  state". Tidak ada `AtomicOperationPort`, tidak ada rollback multi-owner.
  plan.json juga tidak mencantumkan file itu untuk P4. Jangan menambahkannya.

Runtime handle TIDAK BOLEH bisa register setelah startup (pelajaran P3 S1):
expose getSnapshot/subscribe/dispose saja. Registrasi selesai saat
createStorefrontEngine kembali.

Dalam proyeksi snapshot: child `disposed` dihitung BUKAN failed dan BUKAN
unavailable — shutdown tertib tidak boleh terbaca sebagai gangguan. Area tak
terduga DITAMBAHKAN di akhir, tidak pernah dibuang.

VERIFIKASI: belum ada file tes permanen yang direncanakan untuk file-file ini
(tes permanen mulai per-child di S3, plus phase gate di S7). Jadi tulis suite
SEMENTARA di `test/` (legal per plan.json rootAllow), jalankan, perbaiki yang
gagal, MUTATION-CHECK dua tes penopang, lalu HAPUS sebelum commit.

Set status fase P4 ke `active` di plan.json kalau belum (satu-satunya suntingan
plan yang diizinkan — flip status, bukan perubahan struktur).
```

---

## SLICE S2 — ruang mesin

```
Lanjutkan port Warung Meng. Slice: P4 S2 — createStorefrontEngine +
discoverStorefrontLogic + index.

[sisipkan blok "berlaku untuk semua slice"]
PRASYARAT: S1 selesai dan hijau.

YANG DIBANGUN (3 file `exact`):
  src/createStorefrontEngine.ts
  src/discoverStorefrontLogic.ts
  src/index.ts

CERMIN P3 S2. Baca `createAdminEngine.ts` dan `discoverAdminLogic.ts` sebagai pola.
Urutan startup LOGIC §7: discover → graph → register → initialize → expose.

TIGA HAL YANG BERBEDA DARI ADMIN:
1. **Tidak ada republish port atomik.** createAdminEngine punya `atomicBridgeChild`
   yang menerbitkan ulang port atomik sebagai capability. Storefront TIDAK punya itu
   (lihat S1). Jadi tidak ada `admin.runtime.shared` tandingan, tidak ada
   diagnostic "missing atomic port". Hapus seluruh konsep itu, jangan disalin.
2. Glob discovery menunjuk folder paket INI: `./engines/*/*Engine.ts` dan
   `./engines/*/children/**/*Child.ts`. Relatif — itulah yang membuat "Storefront
   tidak pernah memindai Admin" benar secara struktural, bukan sekadar niat.
3. Filter namespace menolak apa pun yang bukan `storefront.` (pertahanan berlapis).

YANG TETAP SAMA DAN WAJIB ADA:
- Fan-in de-duplication diagnostic. Registry sengaja TIDAK dedupe (di dalamnya tiap
  situs laporan berbeda); lintas tahap itu tidak lagi benar, jadi dedupe milik host.
- Runtime SELALU kembali. Tidak ada throw. Discovery kosong, port hilang, child
  gagal — semuanya dilaporkan dan dilewati. Storefront setengah jadi = degraded,
  bukan crash (LOGIC §7 aturan 4-6).
- Child yang dikecualikan graph TETAP diregistrasi, supaya muncul sebagai
  unavailable di snapshot. Yang hilang dari laporan tak bisa dibedakan dari yang
  tak pernah ditulis.
- `index.ts` = ekspor pilihan tangan. Discovery TIDAK diekspor — itu cara runtime
  menemukan areanya sendiri, bukan layanan untuk orang lain. Bentuk sah dari
  kebutuhan itu adalah opsi `definitions` yang bertipe.

VERIFIKASI: suite sementara di `test/` + MUTATION-CHECK, lalu hapus.
WAJIB juga: buktikan discovery on-disk benar-benar jalan dengan area scratch
sementara (P3 S2 melakukan ini, lalu menghapusnya — membangun area sungguhan
adalah tugas S3).
```

---

## SLICE S3 — catalog (BERHENTI DULU: lihat konflik id di atas)

```
Lanjutkan port Warung Meng. Slice: P4 S3 — area catalog: catalog-read + menu-detail.
Ini area operasional PERTAMA Storefront dan menetapkan pola untuk S4-S6.

[sisipkan blok "berlaku untuk semua slice"]
PRASYARAT: S2 selesai dan hijau.

=== BERHENTI SEBELUM MENULIS KODE — TANYA PEMILIK DULU ===
`new-target/LOGIC-TARGET-FILE-TREE.md` bertentangan dengan dirinya sendiri:
  §6 baris 455: `storefront.catalog.catalog-read`
  §8 baris 560: `storefront.catalog.read`   ← yang dirujuk `requires` 3 child lain
  §6 baris 457: `storefront.cart.cart-management`
  §8 baris 562: `storefront.cart.management` ← dirujuk checkout
Kalau salah pilih, tiga child gagal resolve dan jadi unavailable — persis kegagalan
yang di Admin S8 menjatuhkan 16 dari 20 tes.
TANYAKAN ke pemilik bentuk mana yang benar. Rekomendasi: pakai §8 karena itu yang
dirujuk `requires`, lalu perbaiki §6. Setelah dijawab, COMMIT PERTAMA slice ini
menyelaraskan §6 dan §8 — berdiri sendiri, tanpa kode, diberi label jelas sebagai
tindakan otorisasi pemilik.

YANG DIBANGUN:
  engines/catalog/catalogEngine.ts       (identitas saja, tanpa impor child)
  engines/catalog/catalogContracts.ts    (token capability, outbound port, tipe)
  engines/catalog/children/catalog-read/{catalogReadChild.ts,catalogRead.test.ts}
  engines/catalog/children/menu-detail/{menuDetailChild.ts,menuDetail.test.ts}

CAPABILITY GRAPH (LOGIC §8, verbatim):
  catalog-read  → requires: []
  menu-detail   → requires: [<id catalog-read yang disepakati>]
menu-detail adalah child Storefront PERTAMA dengan `requires`, jadi tesnya harus
membuktikan DUA arah: resolve normal, DAN — saat catalog-read tidak ada — graph
MENGECUALIKAN menu-detail alih-alih membiarkannya publish capability yang rusak.

SCOPE per LOGIC §6 (jangan pecah tiap helper jadi child):
  catalog-read → category, search, menu collection, availability read
  menu-detail  → detail, input pemilihan option/variant, validasi detail

PERILAKU dari SOURCE `apps/storefront/src/features/catalog/` (28 file — pakai agen
scout untuk membacanya, port di thread utama). Struktur dari plan.json, JANGAN dari
layout SOURCE.

YANG HARUS DIWASPADAI (pelajaran P3 yang kemungkinan terulang):
- Cari aturan yang hanya hidup sebagai props form: `rules={[...]}`, `maxLength`,
  `min=`, `disabled=`. Itu aturan logic yang kebetulan ditulis di layar; pindahkan
  ke logic per LOGIC §13. Ini muncul di SETIAP area Admin.
- Kalau satu aturan punya beberapa salinan yang tidak sepakat, cari mana yang
  BISA DILIHAT pemilik dan menangkan itu, lalu satukan.
- Pengurutan adalah janji engine, bukan janji adapter. Urutkan di child, dan beri
  tie-break stabil.
- Storefront punya kebijakan yang BERBEDA dari Admin di beberapa tempat (catatan
  P3 S9 menemukan cap kuantitas 20 untuk item untracked di Storefront, sedangkan
  Admin tidak punya). Pertahankan kebijakan Storefront; jangan impor asumsi Admin.

VERIFIKASI: tes permanen per child, capai capability lewat PROBE CHILD.
Mutation-check tes penopang. Verifikasi discovery on-disk dengan tes sementara di
`test/` — buktikan ia GAGAL saat satu file child diganti nama ke glob lain yang
diizinkan (mis. `*.test.ts`) sementara structure tetap hijau — lalu hapus.
```

---

## SLICE S4 — cart

```
Lanjutkan port Warung Meng. Slice: P4 S4 — area cart: cart-management.

[sisipkan blok "berlaku untuk semua slice"]
PRASYARAT: S3 selesai dan hijau, dan konflik id §6/§8 sudah diputuskan pemilik.

YANG DIBANGUN:
  engines/cart/cartEngine.ts
  engines/cart/cartContracts.ts
  engines/cart/children/cart-management/{cartManagementChild.ts,cartManagement.test.ts}

GRAPH: cart-management → requires: [<id catalog-read>]
SCOPE §6: cart state, aturan kuantitas, subtotal, persistence port.

DARI SOURCE `apps/storefront/src/features/cart/` (20 file).

PERBEDAAN YANG SUDAH TERCATAT DAN HARUS DIPERTAHANKAN:
Catatan P3 S9 (POS cart Admin) mencatat bahwa Storefront punya kebijakan merge dan
cap kuantitas yang BERBEDA dari Admin — Storefront punya cap keras 20 untuk item
untracked. Itu perilaku Storefront; pertahankan apa adanya. JANGAN menyelaraskannya
dengan Admin, dan jangan impor apa pun dari admin-engine untuk membandingkan.

PERSISTENCE: port outbound yang di-inject dan netral-transport. JANGAN impor
localStorage/sessionStorage/window. Adapter browser adalah keputusan composition
root nanti, bukan keputusan paket ini. Port hilang → child tetap aktif dan publish,
satu diagnostic, tiap panggilan mengembalikan failure ternormalisasi.

VERIFIKASI: seperti S3.
```

---

## SLICE S5 — orders

```
Lanjutkan port Warung Meng. Slice: P4 S5 — area orders: order-submission +
order-confirmation.

[sisipkan blok "berlaku untuk semua slice"]
PRASYARAT: S4 selesai dan hijau.

YANG DIBANGUN:
  engines/orders/ordersEngine.ts
  engines/orders/ordersContracts.ts
  engines/orders/children/order-submission/{orderSubmissionChild.ts,orderSubmission.test.ts}
  engines/orders/children/order-confirmation/{orderConfirmationChild.ts,orderConfirmation.test.ts}

GRAPH:
  order-submission   → requires: []
  order-confirmation → requires: [storefront.orders.order-submission]

SCOPE §6:
  order-submission   → handoff order ternormalisasi lewat injected outbound port
  order-confirmation → snapshot konfirmasi + pemulihan struk terakhir lewat port

=== D27 PUNYA AKSI BERDIRI DI SINI — INI ALASAN UTAMA SLICE INI ADA ===
Baca D27 di plan/tech-debt.md sebelum menulis. Ringkasnya: SOURCE tidak punya
idempotency saat membuat order. `submissionLockRef` di React hanya menekan klik
ganda di layar yang sama; ia TIDAK melindungi tulisan backend yang sukses tapi
responsnya hilang. Retry bisa membuat order duplikat.
P3 S7 menutup seam ini di sisi Admin: `SubmitOrderInput` mewajibkan idempotency key,
dan store mengembalikan `created | replayed | conflict` secara otoritatif.
**Terapkan aturan yang sama di sini.** Kuncinya harus berasal dari identitas yang
TAHAN LAMA (session/checkout), bukan nilai acak baru tiap retry. Replay harus
terlihat sebagai hasil degraded yang berguna, bukan disamarkan jadi sukses segar.
Ref React tetap hanya penjaga responsivitas, TIDAK PERNAH mekanisme durabilitas.

CATATAN LINTAS-RUNTIME (LOGIC §9): order submission Storefront memakai outbound port
milik composition Storefront; Admin memakai miliknya sendiri. Bagaimana keduanya
bertemu di produksi SENGAJA belum ditentukan. Jangan mengarangnya, dan jangan
mengimpor apa pun dari admin-engine.

VERIFIKASI: seperti S3. Wajib ada tes untuk jalur replay dan jalur conflict.
```

---

## SLICE S6 — checkout (bentuknya BEDA dari Admin)

```
Lanjutkan port Warung Meng. Slice: P4 S6 — area checkout: checkout-submission +
submitCheckoutSafely.ts. Ini child terluas di P4.

[sisipkan blok "berlaku untuk semua slice"]
PRASYARAT: S5 selesai dan hijau.

YANG DIBANGUN:
  engines/checkout/checkoutEngine.ts
  engines/checkout/checkoutContracts.ts
  engines/checkout/children/checkout-submission/{checkoutSubmissionChild.ts,
                                                 submitCheckoutSafely.ts,
                                                 checkoutSubmission.test.ts}

GRAPH (LOGIC §8):
  checkout-submission → requires: [<catalog-read>, <cart-management>,
                                   storefront.orders.order-submission]
SCOPE §6: validation, submission lock, retry identity, flow result.

=== PERINGATAN TERPENTING SLICE INI ===
**Checkout Storefront BUKAN workflow atomik.** Jangan meniru `cancelOrderAtomically`
atau `submitPosCheckoutAtomically` dari Admin.

LOGIC §10 menuliskannya berbeda, verbatim:
    validate cart and submission lock
      → submit through Storefront order capability
      → store normalized success in Storefront runtime
    failure
      → preserve retry-safe state
      → return normalized failure

Tidak ada `AtomicOperationPort`. Tidak ada rollback multi-owner. Tidak ada
`requires: [atomic-operation]`. plan.json juga tidak memberi P4 file port atomik.
Nama filenya `submitCheckoutSafely.ts` — "safely", bukan "atomically" — dan
perbedaan nama itu bermakna.

Konsekuensinya: aturan mekanis S8 Admin ("di dalam batas atomik, failure yang
DIKEMBALIKAN akan commit, karena rollback dipicu throw") TIDAK berlaku di sini,
karena tidak ada batas atomik. Yang menggantikannya adalah "preserve retry-safe
state": setelah gagal, keadaan harus tetap memungkinkan percobaan ulang yang aman
memakai identitas retry yang sama (lihat D27 dan S5). Jangan mengarang boundary
atomik untuk merasa aman — itu justru menyimpang dari dokumen.

Kalau menurut Anda checkout SUNGGUH butuh jaminan atomik, BERHENTI dan tanya
pemilik. Jangan tambahkan sendiri.

VERIFIKASI: seperti S3, plus wajib:
- tes yang membuktikan child unavailable saat SETIAP satu dari tiga capability
  yang diperlukan tidak ada (bukan gagal saat dipanggil — unavailable).
- tes yang membuktikan keadaan retry-safe bertahan setelah kegagalan.
```

---

## SLICE S7 — phase gate (penutup fase)

```
Lanjutkan port Warung Meng. Slice: P4 S7 — storefrontEngineGraph.test.ts, PHASE GATE.
Ini slice TERAKHIR P4 dan menutup fase.

[sisipkan blok "berlaku untuk semua slice"]
PRASYARAT: S6 selesai dan hijau; keenam child ada.

YANG DIBANGUN: satu file, `src/storefrontEngineGraph.test.ts` (`exact` di plan.json).

BACA `packages/admin-engine/src/adminEngineGraph.test.ts` LEBIH DULU — itu padanan
Admin-nya, sudah terbukti, dan komentarnya menjelaskan tiap keputusan. Tiru
bentuknya, sesuaikan isinya.

KENAPA FILE INI ADA: plan.json mencantumkan entri `engines/*` sebagai glob `allow`,
bukan `exact`. Artinya satu area yang sama sekali tidak dibangun tetap lolos
keempat check. Kelengkapan BUKAN sesuatu yang bisa dibuktikan structure checker;
itu tugas file ini.

Titik butanya, terukur bukan diasumsikan: mengganti nama `cartManagementChild.ts`
jadi `cartManagement.ts` MEMBUAT structure merah (tidak cocok glob mana pun). Yang
LOLOS adalah rename ke glob lain yang diizinkan — `cartManagementOrphan.test.ts`
lolos structure DAN typecheck DAN semua tes lain, sementara child-nya memuat sebagai
NIHIL, tidak publish apa pun, tidak melapor apa pun.

YANG HARUS DIBUKTIKAN:
1. Discovery on-disk nyata menemukan 4 engine dan 6 child — sebagai HIMPUNAN ID,
   bukan hitungan. File yang di-rename mempertahankan hitungan sambil memuat nihil,
   dan "harusnya 6, dapat 5" tidak menyebut siapa yang hilang. Diff himpunan menyebut
   id-nya.
2. Tiap capability id cocok LOGIC §8 VERBATIM, termasuk keputusan pemilik soal
   konflik §6/§8 di S3.
3. Empat child dengan `requires` mendeklarasikan tepat edge dokumen, dalam urutan
   dokumen; dua sisanya tidak punya requires. Edge yang DIKARANG sama menyimpangnya
   dengan edge yang hilang.
4. Runtime sehat melapor NOL diagnostic. (P3 S2 menemukan diagnostic yang menyala di
   graph sehat; diagnostic yang berteriak serigala melatih pembacanya berhenti melihat.)
5. Provider diinisialisasi sebelum konsumennya.
6. Disposal idempoten, menyisakan nol child aktif tanpa failure.
7. Child yang requirement-nya hilang DIKECUALIKAN, bukan publish dalam keadaan rusak.
8. **TIDAK ADA capability atomik di mana pun** — buktikan secara eksplisit bahwa
   Storefront tidak menerbitkan `atomic-operation`. Ini menjaga agar sesi berikutnya
   tidak "melengkapi" Storefront dengan menyalin seam Admin.

DUA KEPUTUSAN YANG MEMBUAT GATE BISA GAGAL — JANGAN DILANGGAR:
- Tulis ekspektasi sebagai STRING LITERAL, jangan impor dari file contracts area.
  Mengimpor `CATALOG_READ_ID` membuat tes setuju dengan kode SECARA KONSTRUKSI:
  rename capability ikut me-rename ekspektasinya, dan tes tak akan pernah bisa
  gagal. Terbukti lewat mutasi di P3 S13.
- Bandingkan HIMPUNAN ID, bukan hitungan.

CATATAN YANG MENGHEMAT WAKTU: child yang dikecualikan GRAPH melaporkan
`unmetRequirements: []`, dan itu BENAR — registry hanya mengisi field itu untuk
child yang benar-benar ia coba inisialisasi. Alasan pengecualian ada di diagnostic
`missing-dependency` milik graph. Assert di sana.

MUTATION-CHECK GATE ITU SENDIRI — INI YANG PALING PENTING DI SELURUH FASE:
Ganti nama satu file child ke glob yang diizinkan (mis. `*.test.ts`) DAN perbaiki
impor saudaranya supaya mutasinya benar-benar senyap. Pastikan structure TETAP HIJAU
dan semua tes lain TETAP LULUS, sementara HANYA gate ini yang merah dan menyebut id
yang hilang. Lalu pulihkan byte-for-byte dan buktikan dengan `git diff` kosong.
Gate yang tidak bisa gagal lebih buruk daripada tidak ada gate.

MENUTUP FASE (satu-satunya suntingan plan.json yang diizinkan):
Setelah gate hijau: set status P4-storefront-engine ke `done` dan pindahkan
`activePhase` ke `P5-ui-core`. Flip status saja, BUKAN perubahan struktur. Lalu
centang S7 + header P4 di roadmap.md, tambah ke porting-log.md, perbarui
p4-handoff.md dengan bagian penutup yang ditujukan untuk P5.
JANGAN mulai P5. Lapor dan STOP.
```
