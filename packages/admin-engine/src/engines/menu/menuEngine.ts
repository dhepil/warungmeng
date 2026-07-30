// packages/admin-engine/src/engines/menu/menuEngine.ts
//
// The Menu area's parent engine (LOGIC §6: a parent declares identity and child
// namespace, and nothing else).
//
// There is deliberately no behavior here and no import of any child. A parent
// that knew how its children worked would be the thing LOGIC §3 forbids — the
// area would stop being plug-and-play, because removing a child would mean
// editing the parent. Discovery finds the children by their file names; this
// file never names one.
//
// The default export is what discovery reads. One definition per file.

import { defineParentEngine } from "@warungmeng/module-system";

export const MENU_ENGINE_ID = "admin.menu";

export default defineParentEngine({
  id: MENU_ENGINE_ID,
  childNamespace: MENU_ENGINE_ID,
});
