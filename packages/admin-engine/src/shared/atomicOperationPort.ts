// packages/admin-engine/src/shared/atomicOperationPort.ts
//
// The multi-owner atomic workflow boundary for Admin (LOGIC §10).
//
// Two workflows in this runtime touch more than one owner and must land as one
// unit or not at all: order cancellation (order → inventory → finance) and POS
// checkout (order → inventory → finance → cart). SOURCE handled this with an
// `atomicTransaction` its composition root owned and threaded into
// `cancelOrderAtomically` / the checkout command by hand. The target keeps the
// same guarantee but delivers it the way every other cross-child dependency is
// delivered: as a capability a child declares in `requires` (LOGIC §8/§9).
//
// That leaves one seam, and this file is it. The mechanism is deliberately
// unspecified here (LOGIC §10) — no transaction, no backend, no adapter — so the
// concrete implementation has to come from whoever composes the runtime. It
// arrives as an OUTBOUND PORT, and the engine root republishes it as the
// CAPABILITY children require. The two tokens below name both ends of that seam.
//
// Keeping them in one file is the point: if the port and the capability drifted
// apart, a child could declare the requirement and still get nothing, and the
// "all or nothing" promise would quietly become "some of it, sometimes".

import type { AtomicOperationPort } from "@warungmeng/module-system";
import { createCapabilityToken, createOutboundPortToken } from "@warungmeng/module-system";

export type { AtomicOperationPort };

/**
 * The inbound half: what the composition root supplies. Unresolved is a legal
 * state — a runtime composed without it simply leaves the two atomic children
 * unavailable, which is exactly rule 4 of LOGIC §7 and strictly better than
 * running a multi-owner write without a boundary.
 */
export const ATOMIC_OPERATION_PORT =
  createOutboundPortToken<AtomicOperationPort>("admin.atomic-operation");

/**
 * The outbound half: what children resolve. The id matches the one written in
 * LOGIC §8's capability graph, so the graph in the doc and the graph the runtime
 * computes are the same graph.
 */
export const ADMIN_ATOMIC_OPERATION =
  createCapabilityToken<AtomicOperationPort>("admin.atomic-operation");

/** The capability id as a plain string, for `requires` lists. */
export const ADMIN_ATOMIC_OPERATION_ID = "admin.atomic-operation";
