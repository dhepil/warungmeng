// packages/admin-engine/src/engines/pos/children/checkout/posCheckoutChild.ts
//
// Wires LOGIC §8's widest child: seven declared requirements, one atomic sequence.

import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
} from "@warungmeng/module-system";
import {
  ADMIN_ATOMIC_OPERATION,
  ADMIN_ATOMIC_OPERATION_ID,
} from "../../../../shared/atomicOperationPort";
import type { AtomicOperationPort } from "../../../../shared/atomicOperationPort";
import {
  TRANSACTION_RECORDING,
  TRANSACTION_RECORDING_ID,
} from "../../../finance/financeContracts";
import type { TransactionRecording } from "../../../finance/financeContracts";
import {
  STOCK_CONSUMPTION,
  STOCK_CONSUMPTION_ID,
} from "../../../inventory/inventoryContracts";
import type { StockConsumption } from "../../../inventory/inventoryContracts";
import { MENU_CATALOG_READ, MENU_CATALOG_READ_ID } from "../../../menu/menuContracts";
import type { CatalogRead } from "../../../menu/menuContracts";
import { ORDER_SUBMISSION, ORDER_SUBMISSION_ID } from "../../../orders/ordersContracts";
import type { OrderSubmission } from "../../../orders/ordersContracts";
import type { PosCart, PosCheckout, PosCheckoutOutcome, PosSession } from "../../posContracts";
import {
  POS_CART,
  POS_CART_ID,
  POS_CHECKOUT,
  POS_CHECKOUT_ID,
  POS_ISSUE,
  POS_SESSION,
  POS_SESSION_ID,
} from "../../posContracts";
import { POS_ENGINE_ID } from "../../posEngine";
import {
  PosCheckoutRollback,
  submitPosCheckoutAtomically,
} from "./submitPosCheckoutAtomically";

interface CheckoutDependencies {
  readonly session: PosSession;
  readonly cart: PosCart;
  readonly catalog: CatalogRead;
  readonly inventory: StockConsumption;
  readonly orders: OrderSubmission;
  readonly finance: TransactionRecording;
  readonly atomic: AtomicOperationPort;
}

function checkoutOver(dependencies: CheckoutDependencies): PosCheckout {
  return {
    async submitCheckout(input) {
      try {
        return await dependencies.atomic.execute<OperationResult<PosCheckoutOutcome>>(() =>
          submitPosCheckoutAtomically(dependencies, input),
        );
      } catch (error) {
        if (error instanceof PosCheckoutRollback) {
          return operationFailure("failed", error.issues);
        }
        return operationFailure("failed", [
          operationIssue(
            POS_ISSUE.atomicFailed,
            "Atomic POS checkout failed, so nothing was committed.",
            "checkout",
            { cause: error instanceof Error ? error.message : String(error) },
          ),
        ]);
      }
    },
  };
}

export function createPosCheckout(context: LogicChildContext): PosCheckout {
  const session = context.capabilities.resolve(POS_SESSION);
  const cart = context.capabilities.resolve(POS_CART);
  const catalog = context.capabilities.resolve(MENU_CATALOG_READ);
  const inventory = context.capabilities.resolve(STOCK_CONSUMPTION);
  const orders = context.capabilities.resolve(ORDER_SUBMISSION);
  const finance = context.capabilities.resolve(TRANSACTION_RECORDING);
  const atomic = context.capabilities.resolve(ADMIN_ATOMIC_OPERATION);

  // Every dependency is in `requires`, so an unavailable resolution means graph or
  // registry contradiction. Returning a fallback only satisfies total typing; child
  // is never created in that state.
  const ready =
    session.status === "available" &&
    cart.status === "available" &&
    catalog.status === "available" &&
    inventory.status === "available" &&
    orders.status === "available" &&
    finance.status === "available" &&
    atomic.status === "available";
  const capability = ready
    ? checkoutOver({
        session: session.value,
        cart: cart.value,
        catalog: catalog.value,
        inventory: inventory.value,
        orders: orders.value,
        finance: finance.value,
        atomic: atomic.value,
      })
    : {
        submitCheckout: async () =>
          operationFailure("unsatisfied-dependency", [
            operationIssue(POS_ISSUE.atomicFailed, "POS checkout dependencies are unavailable."),
          ]),
      };

  context.capabilities.provide(POS_CHECKOUT, capability);
  return capability;
}

export default defineLogicChild<PosCheckout>({
  id: POS_CHECKOUT_ID,
  parentId: POS_ENGINE_ID,
  provides: [POS_CHECKOUT_ID],
  requires: [
    POS_SESSION_ID,
    POS_CART_ID,
    MENU_CATALOG_READ_ID,
    STOCK_CONSUMPTION_ID,
    ORDER_SUBMISSION_ID,
    TRANSACTION_RECORDING_ID,
    ADMIN_ATOMIC_OPERATION_ID,
  ],
  create: createPosCheckout,
});
