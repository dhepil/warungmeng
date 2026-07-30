// packages/admin-engine/src/adminEngineSnapshot.ts
//
// The read-only Admin snapshot projection (LOGIC §3: the parent exposes
// diagnostics and a read-only snapshot, and nothing else).
//
// This file is pure: a generic snapshot in, an Admin snapshot out, no state of
// its own. That is what makes it safe to call on every subscriber notification —
// and it means the Admin view can never disagree with the runtime it describes,
// because it holds no copy to fall out of date.
//
// It answers exactly one question the generic runtime cannot: which operational
// area a child belongs to. The module system knows a child has a parent id; it
// does not know, and must not know, that `admin.orders` is an area of an admin
// application (LOGIC §5).

import type { ApplicationEngineSnapshot, Diagnostic } from "@warungmeng/module-system";
import { createDiagnosticCollector } from "@warungmeng/module-system";
import type {
  AdminArea,
  AdminAreaSnapshot,
  AdminEngineSnapshot,
} from "./adminEngineContracts";
import { ADMIN_AREAS, ADMIN_NAMESPACE } from "./adminEngineContracts";

/**
 * `admin.orders` → `orders`. Returns undefined for anything not under the Admin
 * namespace or shaped differently, so a stray id becomes a visible absence rather
 * than an area named after a typo.
 */
export function areaFromEngineId(engineId: string): string | undefined {
  const segments = engineId.split(".");
  if (segments.length !== 2 || segments[0] !== ADMIN_NAMESPACE) {
    return undefined;
  }
  const area = segments[1];
  return area !== undefined && area.length > 0 ? area : undefined;
}

/**
 * Projects the Admin view of a generic runtime snapshot.
 *
 * Areas are derived from what actually loaded, in the order ADMIN_AREAS lists
 * them so the output is stable across runs, with any unrecognized area appended
 * afterwards rather than dropped — an area we did not expect is information, and
 * silently hiding it would make the snapshot a worse witness than the runtime.
 *
 * `startupDiagnostics` are the findings from stages the runtime snapshot cannot
 * know about (discovery and the dependency graph). They are passed in rather than
 * read from a collector so this function stays pure.
 */
export function projectAdminSnapshot(
  runtime: ApplicationEngineSnapshot,
  startupDiagnostics: readonly Diagnostic[] = [],
): AdminEngineSnapshot {
  const byArea = new Map<string, AdminAreaSnapshot>();

  for (const engine of runtime.engines) {
    const area = areaFromEngineId(engine.engineId);
    if (area === undefined) {
      continue;
    }

    const unavailableChildIds: string[] = [];
    const failedChildIds: string[] = [];
    let activeChildCount = 0;

    for (const child of engine.children) {
      if (child.state === "active") {
        activeChildCount += 1;
      } else if (child.state === "failed") {
        failedChildIds.push(child.childId);
      } else if (child.state === "unavailable") {
        unavailableChildIds.push(child.childId);
      }
      // `disposed` is intentionally in neither list: a child torn down on purpose
      // is not a problem to report, and counting it as failed would make an
      // orderly shutdown look like an outage.
    }

    byArea.set(area, {
      area,
      engineId: engine.engineId,
      childCount: engine.children.length,
      activeChildCount,
      unavailableChildIds,
      failedChildIds,
    });
  }

  const ordered: AdminAreaSnapshot[] = [];
  const missingAreas: AdminArea[] = [];
  for (const area of ADMIN_AREAS) {
    const found = byArea.get(area);
    if (found) {
      ordered.push(found);
      byArea.delete(area);
    } else {
      missingAreas.push(area);
    }
  }
  for (const area of [...byArea.keys()].sort((left, right) => left.localeCompare(right))) {
    const extra = byArea.get(area);
    if (extra) {
      ordered.push(extra);
    }
  }

  return {
    runtime,
    areas: ordered,
    missingAreas,
    diagnostics: mergeStartupDiagnostics(startupDiagnostics, runtime.diagnostics),
  };
}

/**
 * Merges the three startup stages into one account, dropping repeats.
 *
 * Order is chronological — discovery and graph findings first, then the
 * registry's — so reading the list top to bottom follows what actually happened.
 *
 * De-duplication delegates to the module system's collector instead of comparing
 * diagnostics here. That is deliberate: "when are two diagnostics the same
 * problem" is already answered in one place, and a second answer living in this
 * package would be free to drift from it. The same unmet capability really is
 * noticed twice — once by the graph excluding the child, once by the registry
 * skipping it — and that is one problem, not two.
 */
export function mergeStartupDiagnostics(
  startupDiagnostics: readonly Diagnostic[],
  runtimeDiagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  const merged = createDiagnosticCollector({ deduplicate: true });
  for (const entry of [...startupDiagnostics, ...runtimeDiagnostics]) {
    merged.report(entry);
  }
  return merged.list();
}

/** True when every expected area loaded and every child in them is active. */
export function isAdminRuntimeHealthy(snapshot: AdminEngineSnapshot): boolean {
  return (
    snapshot.missingAreas.length === 0 &&
    snapshot.areas.every((area) => area.activeChildCount === area.childCount)
  );
}
