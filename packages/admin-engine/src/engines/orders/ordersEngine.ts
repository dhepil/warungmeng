// packages/admin-engine/src/engines/orders/ordersEngine.ts
//
// The Orders area's parent engine (LOGIC §6: identity and child namespace only).
//
// There is deliberately no behavior here and no import of any child. Discovery
// finds order-read, order-submission, and later order-cancellation from their file
// names; removing one must never require editing its parent.

import { defineParentEngine } from "@warungmeng/module-system";

export const ORDERS_ENGINE_ID = "admin.orders";

export default defineParentEngine({
  id: ORDERS_ENGINE_ID,
  childNamespace: ORDERS_ENGINE_ID,
});
