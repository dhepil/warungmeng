// packages/admin-engine/src/engines/dashboard/dashboardEngine.ts
//
// Dashboard parent identity only. Discovery owns child registration; the parent
// never imports or enumerates overview/reports.

import { defineParentEngine } from "@warungmeng/module-system";

export const DASHBOARD_ENGINE_ID = "admin.dashboard";

export default defineParentEngine({
  id: DASHBOARD_ENGINE_ID,
  childNamespace: DASHBOARD_ENGINE_ID,
});
