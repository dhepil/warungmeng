// packages/admin-engine/src/engines/settings/settingsEngine.ts
//
// Identity-only parent for the Settings area. Discovery owns its children; this
// file deliberately imports neither of them.

import { defineParentEngine } from "@warungmeng/module-system";

export const SETTINGS_ENGINE_ID = "admin.settings";

export default defineParentEngine({
  id: SETTINGS_ENGINE_ID,
  childNamespace: SETTINGS_ENGINE_ID,
});
