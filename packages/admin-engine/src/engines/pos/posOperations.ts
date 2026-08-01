// packages/admin-engine/src/engines/pos/posOperations.ts
//
// Shared POS behavior used by sibling children. Operations may import the area's
// contracts; contracts never import operations.

import type { PosCartItem } from "./posContracts";

/** Exact cart aggregate identity shared by cart CAS and checkout finalization. */
export function posCartFingerprint(items: readonly PosCartItem[]): string {
  return JSON.stringify(items);
}
