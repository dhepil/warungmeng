// packages/admin-engine/src/engines/inventory/inventoryEngine.ts
//
// The Inventory area's parent engine (LOGIC §6: a parent declares identity and
// child namespace, and nothing else).
//
// There is deliberately no behavior here and no import of any child, exactly as
// in the Menu area. A parent that knew how its children worked would be the
// thing LOGIC §3 forbids — removing a child would mean editing the parent.
// Discovery finds the children by their file names; this file never names one.
//
// The default export is what discovery reads. One definition per file.

import { defineParentEngine } from "@warungmeng/module-system";

export const INVENTORY_ENGINE_ID = "admin.inventory";

export default defineParentEngine({
  id: INVENTORY_ENGINE_ID,
  childNamespace: INVENTORY_ENGINE_ID,
});
