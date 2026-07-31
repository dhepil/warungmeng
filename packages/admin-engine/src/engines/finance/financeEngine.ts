// packages/admin-engine/src/engines/finance/financeEngine.ts
//
// The Finance area's parent engine (LOGIC §6: a parent declares identity and
// child namespace, and nothing else).
//
// No behavior and no import of any child, exactly as in the Menu and Inventory
// areas. A parent that knew how its children worked would be the thing LOGIC §3
// forbids — removing a child would mean editing the parent. Discovery finds the
// children by their file names; this file never names one.
//
// The default export is what discovery reads. One definition per file.

import { defineParentEngine } from "@warungmeng/module-system";

export const FINANCE_ENGINE_ID = "admin.finance";

export default defineParentEngine({
  id: FINANCE_ENGINE_ID,
  childNamespace: FINANCE_ENGINE_ID,
});
