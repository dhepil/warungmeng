// packages/admin-engine/src/engines/pos/posEngine.ts
//
// The POS area's parent engine (LOGIC §6: identity and child namespace only).
// Session, cart and checkout are discovered from their child filenames; this parent
// imports none of them.

import { defineParentEngine } from "@warungmeng/module-system";

export const POS_ENGINE_ID = "admin.pos";

export default defineParentEngine({
  id: POS_ENGINE_ID,
  childNamespace: POS_ENGINE_ID,
});
