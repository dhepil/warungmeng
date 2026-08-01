# Prompt untuk Codex — PD DS-B, DS-C, DS-D

Tiga prompt terpisah. **Jalankan satu per satu**, masing-masing di sesi Codex sendiri.
Jangan gabungkan: tiap slice berakhir dengan STOP dan laporan, dan urutan
DS-B → DS-C → DS-D adalah urutan yang paling aman (DS-C paling berat, DS-D paling
ringan dan paling berisiko ke data lama).

Setelah ketiganya selesai, laporkan balik ke sesi review untuk diperiksa sekaligus.

---

## PROMPT 1 — DS-B: order-progression

```
Lanjutkan port Warung Meng. Slice berikutnya: PD DS-B — child `order-progression`.
Ini menutup tech-debt D28.

BACA DULU, URUT:
  1. CLAUDE.md                 (kontrak build-agent — 8 aturan keras)
  2. plan/roadmap.md           (blok PD; DS-A sudah [x], DS-B baris berikutnya)
  3. plan/plan.json            (otoritas LETAK file)
  4. plan/tech-debt.md         (D28 + "Structural note — how a new child is
                                actually authorized")
  5. plan/p3-handoff.md        (bagian S7 dan S8 — Orders; S8 paling penting)

LALU jalankan `npm run check` dan pastikan 4/4 hijau sebelum menyentuh apa pun.

CATATAN TOOLCHAIN — BACA SEBELUM MENDIAGNOSIS CHECK MERAH:
Jika merah HANYA di `tests` (structure/boundaries/typecheck hijau) dengan error
rolldown "Cannot find native binding", itu bentrokan install Windows/WSL yang sudah
dikenal, BUKAN drift. Perbaiki:
    git status --short package-lock.json     (kalau kotor: git checkout -- package-lock.json)
    npm install --no-save @rolldown/binding-<platform-anda>
Linux: @rolldown/binding-linux-x64-gnu · Windows: @rolldown/binding-win32-x64-msvc
`--no-save` menjaga lockfile bersih. JANGAN hapus node_modules atau lockfile.
Ini berulang di S9-S13 dan DS-A. Singkirkan dulu SEBELUM meragukan sesi sebelumnya.

STATUS: P1, P2 DONE. P3 DONE tapi `activePhase` sengaja `P3-admin-engine` untuk blok
PD — itu benar, bukan drift. DS-A selesai (53fbba3, fff46ad, 8bd401b). 516 tes hijau,
87 file, 23 child, tree bersih di 8bd401b.

=== APA YANG DIBANGUN ===
SOURCE Admin bisa memajukan pesanan `new → accepted → preparing → ready → completed`.
Target tidak punya pemiliknya. Ini gap pohon target itu sendiri, bukan salah porting.
Setelah slice ini, dapur bisa memajukan tiket lagi.

=== COMMIT 1 WAJIB BERDIRI SENDIRI: ubah dokumen desain ===
Commit PERTAMA hanya menyunting `new-target/LOGIC-TARGET-FILE-TREE.md`:
  - §4: tambah `order-progression/` di bawah `engines/orders/children/` dengan
        `orderProgressionChild.ts` + `orderProgression.test.ts`
  - §8: tambah `admin.orders.order-progression` beserta `requires`-nya
Tidak ada kode di commit ini. Beri pesan commit yang jelas bahwa ini tindakan
otorisasi pemilik. Alasannya: `new-target/` adalah otoritas struktural (aturan 1),
jadi dokumen harus lebih dulu memberi izin sebelum kode ada — bukan sesudahnya.

TIDAK PERLU baris baru di `plan.json`. Glob
`packages/admin-engine/src/engines/*/children/**/*Child.ts` dan `**/*.test.ts` sudah
mengizinkan child baru. Jangan menyunting plan.json sama sekali di slice ini.
(Baca "Structural note" di tech-debt.md — klaim lama bahwa child butuh baris
plan.json itu SALAH dan sudah dikoreksi.)

=== EMPAT BATASAN YANG TIDAK BISA DITAWAR ===

1. JANGAN BUAT PINTU SETTER STATUS UMUM.
   S8 menghapus persis itu dari SOURCE: `updateStatus(orderId, status)` menerima
   `"cancelled"`, tersambung langsung ke repository, dan bisa mem-bypass seluruh
   alur pembatalan atomik — membalik pesanan lunas jadi cancelled/refunded tanpa
   pengembalian stok, di luar transaksi mana pun. Invariannya selamat HANYA karena
   satu layar menyaring nilai itu dari daftar tombol.
   Method port baru Anda HARUS menolak `"cancelled"` secara struktural.
   Idealnya tipenya sendiri melarangnya, bukan cuma pengecekan runtime.

2. PERANGKAP YANG SUDAH SAYA VERIFIKASI — BACA BAIK-BAIK.
   `ORDER_STATUS_TRANSITIONS` di `packages/domain/src/orders.ts` mengizinkan
   `cancelled` dari SETIAP status maju (accepted/preparing/ready semuanya
   mencantumkan "cancelled"). Dan `transitionOrderStatus` punya kebijakan built-in:
   kalau nextStatus `cancelled` dan pesanan `paid`, ia menyetel `refunded`.
   Jadi memakai mesin domain apa adanya AKAN membuka kembali lubang S8.
   Pakai mesin domain untuk aritmetika transisi maju, tapi child ini harus menolak
   `cancelled` sebelum mesin itu dipanggil. Uji ini secara eksplisit.

3. TOKO ADALAH HAKIM. Jangan baca-dulu-baru-tulis.
   Aturan yang sudah diselesaikan S6, ditegaskan S7, dipakai S8: write yang
   memutuskan dan meng-commit. Pertahankan bentuk hasil otoritatif
   `updated | not-found | invalid-transition`. Pre-read = hakim kedua + race.

4. ID KAPABILITAS = ID CHILD di sini.
   Aturan S3: id kapabilitas sama dengan id child KECUALI LOGIC menyebut lain.
   Karena Anda sendiri yang menulis §8 di commit 1, tulis
   `admin.orders.order-progression` dan pakai verbatim. Jangan meniru pengecualian
   `admin.orders.cancel` — itu ada karena dokumen menyebutnya, bukan karena selera.

=== SOAL `requires` ===
D29 sudah menjawab arti `requires`: ia menyatakan apa yang harus HIDUP agar child
aman dipublikasikan, BUKAN apa yang dipanggil child. Cancellation mendeklarasikan
`admin.orders.read` dan tidak pernah memanggilnya, dan itu disengaja.
Putuskan sendiri untuk progression, tulis alasannya di p3-handoff.md, dan pastikan
apa pun yang Anda tulis di §8 sama persis dengan yang dideklarasikan child.

=== GATE S13 AKAN MERAH — ITU MEMANG TUGASNYA ===
`packages/admin-engine/src/adminEngineGraph.test.ts` menegaskan LOGIC §4/§8 verbatim
dan akan gagal saat child ke-24 muncul. Itu benar, bukan kerusakan.
Perbarui konstanta ini agar cocok dengan §8 yang baru:
  - EXPECTED_CHILD_IDS            (baris ~63)
  - EXPECTED_CAPABILITY_BY_CHILD  (baris ~107)
  - EXPECTED_REQUIREMENTS         (baris ~146, hanya jika progression punya requires)
JANGAN mengganti string literal itu jadi import dari file contracts. Literal itulah
yang membuat gate bisa gagal — impor membuat tes setuju dengan kode secara otomatis.
Sudah dibuktikan dengan mutasi di S13.

=== VERIFIKASI WAJIB SEBELUM COMMIT ===
- Tes permanen di `orderProgression.test.ts`, capai kapabilitas lewat PROBE CHILD
  yang mendeklarasikannya di `requires` — jangan panggil `create()` langsung.
  Pola ini yang membuat id salah ketahuan (S8: id keliru = 16 dari 20 tes gagal).
- MUTATION-CHECK minimal 3 tes penopang: rusak perilakunya, pastikan tes gagal,
  pulihkan, lalu `git diff` untuk membuktikan pulih byte-for-byte.
  WAJIB salah satunya: lepas penolakan `cancelled` dan pastikan ada tes yang merah.
- Jalankan `npm run check` LENGKAP, bukan cuma vitest. Tes bisa hijau sementara
  typecheck merah — itu terjadi di S8, S10, dan S13.

=== SELESAI ===
npm run check hijau → commit → tulis satu baris di plan/porting-log.md → centang
DS-B di plan/roadmap.md + tambahkan catatan progres → catat keputusan di
plan/p3-handoff.md → STOP dan laporkan dalam bahasa awam. Jangan mulai DS-C.

TERKUNCI — JANGAN DIPERDEBATKAN LAGI:
- packages/domain dan packages/module-system adalah fase TERTUTUP. Impor, jangan ubah.
- Tidak ada kosakata UI di logic (LOGIC §5/§11).
- Impor lintas-child dilarang — selesaikan lewat kapabilitas, jangan impor saudara.
- Jangan pernah menyetel git config global. Identitas repo-local sudah benar.
- Jangan membuat file yang tidak diizinkan plan.json.
```

---

## PROMPT 2 — DS-C: laba historis per item

```
Lanjutkan port Warung Meng. Slice berikutnya: PD DS-C — child READ baru untuk laba
historis per item. Ini menutup tech-debt D20.

BACA DULU, URUT:
  1. CLAUDE.md
  2. plan/roadmap.md           (blok PD; DS-B harus sudah [x])
  3. plan/plan.json
  4. plan/tech-debt.md         (D20 — TIGA batasannya wajib dibaca utuh; lalu D11,
                                D19, D16 sebagai konteks presisi)
  5. plan/p3-handoff.md        (bagian S5 dan S11 — S11 yang menyempitkan D20)

LALU `npm run check`, pastikan 4/4 hijau sebelum menyentuh apa pun.
Catatan toolchain rolldown: sama seperti prompt DS-B. Singkirkan dulu.

PRASYARAT: DS-B selesai dan hijau. Kalau belum, berhenti dan bilang.

=== APA YANG DIBANGUN ===
SOURCE mengalikan HPP HARI INI dengan jumlah pesanan HISTORIS. Jadi satu pembelian
baru bisa menulis ulang laba bulan lalu. S11 menutup sisi PENCATATAN: setiap
movement konsumsi baru kini menyimpan `unitCost` saat penjualan. Yang belum ada
adalah PEMBACANYA.

Data yang dibutuhkan SUDAH ADA — saya verifikasi sendiri di disk:
  - `InventoryMovement.unitCost: Money | null`  (snapshot S11)
  - `InventoryMovement.referenceId: string | null`  (menunjuk pesanan)
  - `OrderItem.menuItemId` dan `OrderItem.lineTotal`
  - resep, lewat `listRecipes()` di InventoryStorePort
Ini child BACA yang menggabungkan data yang sudah ada. Tidak ada penulisan baru,
tidak ada perubahan domain.

=== LETAK: AREA INVENTORY, BUKAN DASHBOARD ===
Roadmap menyebut area INVENTORY. Alasannya biaya adalah faktanya inventory.
Dashboard boleh menggabungkannya dengan pendapatan yang sudah ia baca, tapi
Dashboard TIDAK BOLEH mendapat akses repository — itu D15, sudah diselesaikan S11,
jangan dibuka lagi.

=== COMMIT 1 WAJIB BERDIRI SENDIRI: ubah dokumen desain ===
Sama seperti DS-B: commit pertama HANYA menyunting
`new-target/LOGIC-TARGET-FILE-TREE.md` §4 dan §8 untuk child baru ini. Tanpa kode.
Tidak perlu menyentuh plan.json — glob children sudah mengizinkannya.

=== TIGA BATASAN D20 YANG TIDAK BISA DITAWAR ===
Ketiganya ada di tech-debt.md. Ringkasnya, dan semuanya wajib:

1. INI REKONSTRUKSI, BUKAN FAKTA TERCATAT — dan harus MENGATAKANNYA.
   Movement hanya menunjuk PESANAN (`referenceId`), bukan baris pesanan atau menu.
   Jadi pembagian biaya ke tiap hidangan disimpulkan lewat resep, bukan dibaca.
   Bentuk hasilnya harus jujur soal ini; jangan sajikan angka simpulan seolah
   terukur.

2. TEPAT HANYA SELAMA RESEP BELUM BISA DIEDIT.
   Rekonstruksi mengandaikan resep hari ini sama dengan resep saat penjualan.
   Itu benar HANYA karena D16 (tidak ada jalur tulis resep) masih berlaku.
   Saat editor resep mendarat di P5, ini perlu ditinjau — catat kaitannya.

3. BARIS SEBELUM S11 HARUS "TIDAK DIKETAHUI", TIDAK PERNAH NOL.
   Ini yang paling penting. Baris lama punya `unitCost: null`. Nol terbaca sebagai
   laba murni — satu-satunya jawaban salah yang terlihat masuk akal. Laporkan
   sebagai tidak diketahui/degraded, dan uji ini secara eksplisit dengan mutasi.

=== POLA YANG SUDAH TERKUNCI, IKUTI ===
- Anak baca menerapkan ULANG filternya sendiri; port tidak menjanjikan apa pun soal
  query yang dihormati (S4).
- Setiap pengurutan butuh tie-break — nama tidak unik dan jalur otomatis menstempel
  `occurredAt` yang identik untuk satu pesanan (S4).
- Satu sumber gagal boleh degraded selama sumber lain masih terpakai; SEMUA sumber
  gagal harus failure, bukan array kosong yang dipalsukan (S6, S11).
- Kalender tunggal: Jakarta, lewat proyeksi tanggal domain (S6, S7, S11).
- Port hilang ≠ child unavailable. Child tetap aktif, tetap publish, satu diagnostic
  saat pembuatan, tiap panggilan mengembalikan failure ternormalisasi (S3).
- Jangan bulatkan ulang atau "perbaiki" presisi di sini. D11/D19 sengaja dibiarkan,
  dan pembulatan uang jadi formatter tampilan di P5. Jangan sentuh.

=== GATE S13 ===
Akan merah karena child ke-25. Perbarui EXPECTED_CHILD_IDS,
EXPECTED_CAPABILITY_BY_CHILD, dan EXPECTED_REQUIREMENTS agar cocok §8 baru.
Tetap string LITERAL, jangan diubah jadi import.

=== VERIFIKASI WAJIB ===
- Tes permanen, kapabilitas dicapai lewat PROBE CHILD.
- Minimal 3 mutasi, salah satunya WAJIB: buat baris pra-S11 melaporkan nol alih-alih
  tidak diketahui, dan pastikan tepat satu tes fokus yang merah.
- `npm run check` LENGKAP.
- Jangan buka `packages/domain`. Kalau terasa perlu, BERHENTI dan tanya pemilik.

=== SELESAI ===
check hijau → commit → porting-log → centang DS-C di roadmap + catatan progres →
p3-handoff → STOP dan laporkan dalam bahasa awam. Jangan mulai DS-D.
```

---

## PROMPT 3 — DS-D: integritas referensial

```
Lanjutkan port Warung Meng. Slice berikutnya: PD DS-D — integritas referensial di
area menu. Ini menutup tech-debt D1 dan D2 sekaligus. Ini slice TERAKHIR blok PD.

BACA DULU, URUT:
  1. CLAUDE.md
  2. plan/roadmap.md           (blok PD; DS-C harus sudah [x])
  3. plan/plan.json
  4. plan/tech-debt.md         (D1 dan D2 — memang dirancang dijawab bersama)
  5. plan/p3-handoff.md        (bagian S3 — area menu)

LALU `npm run check`, pastikan 4/4 hijau.
Catatan toolchain rolldown: sama seperti prompt sebelumnya.

PRASYARAT: DS-C selesai dan hijau.

=== APA YANG DIBANGUN ===
Dua lubang referensial yang diwarisi dari SOURCE:
  D1 — menghapus variant group tidak membuang id-nya dari `variantGroupIds` menu
       mana pun, dan menghapus menu tidak menyentuh group. Tautan yatim bertahan.
       Hanya POS yang menyadarinya, saat memuat keranjang (`missing-group`).
  D2 — tidak ada yang memeriksa `categoryId` menunjuk kategori yang benar-benar ada.
       SOURCE aman hanya karena editornya cuma menawarkan kategori nyata — itu
       layar yang mencegah kesalahan, bukan aturan.

TIDAK ADA FILE BARU. Tidak perlu menyentuh new-target/ maupun plan.json.
Semua di dalam area menu yang sudah ada. Gate S13 harus tetap hijau apa adanya —
kalau ia merah, Anda menambah sesuatu yang seharusnya tidak ada.

=== KEPEMILIKAN — INI BAGIAN YANG CANGGUNG, DAN SUDAH DIPUTUSKAN ===
Penghapusan menu ada di `menu-editor`; penghapusan group ada di
`variant-management`. LOGIC §8 memberi menu child NOL requires, jadi keduanya TIDAK
BOLEH saling bergantung atau saling impor.
Bentuknya sudah ditetapkan di D1: **tiap child membereskan tautan yang menjadi
tanggung jawabnya sendiri, lewat port yang sudah ia pegang.** Jangan bikin child
baru, jangan bikin edge kapabilitas baru, jangan impor saudara.

Port sudah menyediakan yang dibutuhkan (saya verifikasi): `deleteMenu`,
`deleteVariantGroup`, `deleteCategory`, `listMenus`, `listCategories`,
`listVariantGroups`, `updateMenu`.

=== PERINGATAN YANG PALING MUDAH TERLEWAT ===
Pengecekan `categoryId` (D2) MENGUBAH ARTI "write yang sah". Baris yang selama ini
bisa disimpan bisa MULAI GAGAL kalau datanya sudah rusak sejak awal.
Itu memang tujuannya, tapi harus:
  - gagal dengan issue bernama yang jelas, bukan error generik
  - diuji dengan fixture yang memang punya categoryId yatim
  - ditulis di laporan Anda dalam bahasa awam, karena pemilik mungkin melihat
    menu lama tiba-tiba menolak disimpan
Kalau menurut Anda ini perlu keputusan pemilik dulu, BERHENTI dan tanya. Lebih baik
bertanya daripada membuat data lama tak bisa disimpan tanpa peringatan.

=== POLA YANG SUDAH TERKUNCI ===
- Pembersihan non-atomik yang menyentuh banyak baris memakai bentuk S3: COBA SEMUA,
  jangan berhenti di kegagalan pertama, lalu kembalikan `degraded` yang menyebut id
  mana yang gagal. SOURCE melempar di baris pertama dan menyisakan sisanya tak
  tersentuh di balik satu error generik. LOGIC §10 membatasi port atomik hanya untuk
  pembatalan pesanan dan checkout POS — JANGAN memperluasnya ke sini (itu D4,
  `accepted`).
- Semua hasil memakai bentuk `OperationResult` yang satu itu. Jangan bikin union
  hasil khusus (S3 melipat `DeleteMenuCategoryResult` ke dalamnya).
- Baseline dibaca ulang saat save, bukan ditangkap saat mount (S3).
- Aturan validasi tinggal di logic, bukan di props form (LOGIC §13).

=== VERIFIKASI WAJIB ===
- Perluas tes permanen `menuEditor.test.ts` dan `variantManagement.test.ts`.
- Minimal 3 mutasi. WAJIB salah satunya: lepas pengecekan keberadaan kategori dan
  pastikan tepat satu tes fokus yang merah.
- Uji juga arah sebaliknya: hapus menu → id-nya hilang dari group; hapus group →
  id-nya hilang dari semua menu.
- Gate S13 harus tetap 21 tes hijau tanpa disunting.
- `npm run check` LENGKAP.

=== SELESAI — INI MENUTUP BLOK PD ===
check hijau → commit → porting-log → centang DS-D di roadmap + catatan progres →
p3-handoff → **kembalikan `activePhase` ke `P4-storefront-engine` di plan.json**
(itu satu-satunya suntingan plan yang diizinkan; blok PD selesai) → STOP dan
laporkan dalam bahasa awam. Jangan mulai P4.
```
