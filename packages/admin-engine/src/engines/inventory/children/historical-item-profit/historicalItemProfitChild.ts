// packages/admin-engine/src/engines/inventory/children/historical-item-profit/historicalItemProfitChild.ts
//
// Historical sale-time cost and profit per menu item.
//
// This is deliberately an Inventory child: the historical fact is the cost
// snapshotted on consumption movements. Orders supply the sold lines and their
// revenue through `admin.orders.read`; Dashboard never receives a repository.
//
// D20's honesty boundary is structural here. Movements identify an ORDER, not an
// order item. Their cost is therefore split by CURRENT recipe proportions and the
// collection says `recipe-proportional-reconstruction`. That reconstruction is
// exact only while D16 keeps recipes read-only. A pre-S11 null `unitCost` makes
// the affected result unknown and degraded — it is never coerced to zero.

import type {
  InventoryMovement,
  InventoryUnit,
  MenuRecipe,
  Money,
  Order,
  ReportingPeriod,
} from "@warungmeng/domain";
import {
  convertInventoryQuantity,
  isTimestampInReportingPeriod,
  validateReportingPeriod,
} from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import type { OrderRead } from "../../../orders/ordersContracts";
import {
  DEFAULT_ORDER_LIST_FILTERS,
  ORDER_READ,
  ORDER_READ_ID,
} from "../../../orders/ordersContracts";
import { INVENTORY_ENGINE_ID } from "../../inventoryEngine";
import type {
  HistoricalItemProfit,
  HistoricalItemProfitCollection,
  HistoricalItemProfitQuery,
  HistoricalItemProfitRow,
  HistoricalItemProfitSource,
  InventoryStorePort,
} from "../../inventoryContracts";
import {
  HISTORICAL_ITEM_PROFIT,
  HISTORICAL_ITEM_PROFIT_ATTRIBUTION,
  HISTORICAL_ITEM_PROFIT_ID,
  HISTORICAL_ITEM_PROFIT_ISSUE,
  HISTORICAL_ITEM_PROFIT_RECIPE_ASSUMPTION,
  HISTORICAL_ITEM_PROFIT_SOURCES,
  HISTORICAL_ITEM_PROFIT_TIME_ZONE,
  INVENTORY_STORE_PORT,
} from "../../inventoryContracts";
import { consumptionQuantity } from "../../inventoryOperations";

interface ValidatedQuery {
  readonly outletId: string;
  readonly menuItemId: string | null;
  readonly period: ReportingPeriod;
}

interface SourceLoad<TValue> {
  readonly source: HistoricalItemProfitSource;
  readonly value: TValue | undefined;
  readonly issues: readonly OperationIssue[];
}

type OrderItem = Order["items"][number];

interface MutableLineCost {
  readonly orderId: string;
  readonly orderCreatedAt: string;
  readonly orderItemId: string;
  readonly menuItemId: string;
  readonly menuName: string;
  readonly quantity: number;
  readonly revenue: Money;
  costAmount: number;
  readonly issues: OperationIssue[];
}

interface ComponentDemand {
  readonly line: MutableLineCost;
  readonly quantity: number;
  readonly unit: InventoryUnit;
}

const NO_STORE = "no-inventory-store";

const SOURCE_ISSUE: Readonly<Record<HistoricalItemProfitSource, string>> = {
  orders: HISTORICAL_ITEM_PROFIT_ISSUE.ordersUnavailable,
  movements: HISTORICAL_ITEM_PROFIT_ISSUE.movementsUnavailable,
  recipes: HISTORICAL_ITEM_PROFIT_ISSUE.recipesUnavailable,
};

function validateQuery(query: HistoricalItemProfitQuery): OperationResult<ValidatedQuery> {
  const outletId = query.outletId.trim();
  if (outletId.length === 0) {
    return operationFailure("invalid-input", [
      operationIssue(
        HISTORICAL_ITEM_PROFIT_ISSUE.invalidOutlet,
        "Historical item profit requires an outlet id.",
        "outletId",
      ),
    ]);
  }

  const menuItemId = query.menuItemId?.trim() ?? null;
  if (menuItemId !== null && menuItemId.length === 0) {
    return operationFailure("invalid-input", [
      operationIssue(
        HISTORICAL_ITEM_PROFIT_ISSUE.invalidMenuItem,
        "A historical item profit menu id cannot be blank.",
        "menuItemId",
      ),
    ]);
  }

  const period: ReportingPeriod = {
    startDate: query.dateFrom,
    endDate: query.dateTo,
    timeZone: HISTORICAL_ITEM_PROFIT_TIME_ZONE,
  };

  try {
    validateReportingPeriod(period);
  } catch (error) {
    return operationFailure("invalid-input", [
      operationIssue(
        HISTORICAL_ITEM_PROFIT_ISSUE.invalidPeriod,
        error instanceof Error ? error.message : "The historical profit period is invalid.",
        "period",
      ),
    ]);
  }

  return operationSuccess({ outletId, menuItemId, period });
}

function sourceFailure<TValue>(
  source: HistoricalItemProfitSource,
  message: string,
  upstreamIssues: readonly OperationIssue[] = [],
): SourceLoad<TValue> {
  return {
    source,
    value: undefined,
    issues: [operationIssue(SOURCE_ISSUE[source], message, source), ...upstreamIssues],
  };
}

async function loadOrders(
  orders: OrderRead,
  query: ValidatedQuery,
): Promise<SourceLoad<readonly Order[]>> {
  try {
    const result = await orders.listOrders({
      ...DEFAULT_ORDER_LIST_FILTERS,
      outletId: query.outletId,
      dateFrom: query.period.startDate,
      dateTo: query.period.endDate,
    });

    if (result.status === "failure") {
      return sourceFailure(
        "orders",
        "Historical item profit order data is unavailable.",
        result.issues,
      );
    }

    return {
      source: "orders",
      value: result.value.orders,
      issues: result.status === "degraded" ? result.issues : [],
    };
  } catch (error) {
    return sourceFailure(
      "orders",
      error instanceof Error ? error.message : "Historical order data is unavailable.",
    );
  }
}

async function loadStoreSource<TValue>(
  source: "movements" | "recipes",
  read: () => Promise<TValue>,
): Promise<SourceLoad<TValue>> {
  try {
    return { source, value: await read(), issues: [] };
  } catch (error) {
    return sourceFailure(
      source,
      error instanceof Error
        ? error.message
        : `Historical item profit ${source} data is unavailable.`,
    );
  }
}

/** Newest first; order id breaks equal sale timestamps. */
function sortOrders(orders: readonly Order[]): readonly Order[] {
  return [...orders].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}

/**
 * Re-applies every promised query dimension after the capability call.
 *
 * The upstream read can push these filters down, but this child owns its answer
 * and does not make adapter/capability query compliance an unstated requirement.
 */
function filterOrders(orders: readonly Order[], query: ValidatedQuery): readonly Order[] {
  return sortOrders(
    orders.filter(
      (order) =>
        order.outletId === query.outletId &&
        isTimestampInReportingPeriod(order.createdAt, query.period),
    ),
  );
}

/** Newest first; movement id breaks S11's identical order timestamp. */
function sortMovements(movements: readonly InventoryMovement[]): readonly InventoryMovement[] {
  return [...movements].sort(
    (left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id),
  );
}

/**
 * Store queries are hints, not promises. Type, outlet, period, and order link are
 * all checked again here before a movement can enter a historical cost.
 */
function filterMovements(
  movements: readonly InventoryMovement[],
  query: ValidatedQuery,
  selectedOrderIds: ReadonlySet<string>,
): readonly InventoryMovement[] {
  return sortMovements(
    movements.filter(
      (movement) =>
        movement.type === "consumption" &&
        movement.outletId === query.outletId &&
        movement.referenceId !== null &&
        selectedOrderIds.has(movement.referenceId) &&
        isTimestampInReportingPeriod(movement.occurredAt, query.period),
    ),
  );
}

function recipeTieKey(recipe: MenuRecipe): string {
  const components = [...recipe.components]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (component) =>
        `${component.id}:${component.ingredientId}:${component.quantity}:` +
        `${component.unit}:${component.wastePercentage}`,
    )
    .join("|");
  return `${components}#${recipe.packagingCost.amount}#${recipe.additionalCost.amount}`;
}

/** Latest recipe wins deterministically if malformed storage returns duplicates. */
function recipesByMenuItemId(recipes: readonly MenuRecipe[]): ReadonlyMap<string, MenuRecipe> {
  const selected = new Map<string, MenuRecipe>();
  const ordered = [...recipes].sort(
    (left, right) =>
      left.menuItemId.localeCompare(right.menuItemId) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      recipeTieKey(left).localeCompare(recipeTieKey(right)),
  );

  for (const recipe of ordered) {
    if (!selected.has(recipe.menuItemId)) selected.set(recipe.menuItemId, recipe);
  }
  return selected;
}

function issueKey(issue: OperationIssue): string {
  return `${issue.code}\u0000${issue.subject ?? ""}\u0000${issue.message}`;
}

function uniqueIssues(issues: readonly OperationIssue[]): readonly OperationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addLineIssue(line: MutableLineCost, issue: OperationIssue): void {
  if (!line.issues.some((current) => issueKey(current) === issueKey(issue))) {
    line.issues.push(issue);
  }
}

function addIssueToLines(
  lines: readonly MutableLineCost[],
  code: string,
  message: string,
  context: string,
  details?: OperationIssue["details"],
): void {
  for (const line of lines) {
    addLineIssue(line, operationIssue(code, message, context, details));
  }
}

function approximatelyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 16;
}

function lineFromOrderItem(order: Order, item: OrderItem): MutableLineCost {
  return {
    orderId: order.id,
    orderCreatedAt: order.createdAt,
    orderItemId: item.id,
    menuItemId: item.menuItemId,
    menuName: item.name,
    quantity: item.quantity,
    revenue: item.lineTotal,
    costAmount: 0,
    issues: [],
  };
}

/**
 * Reconstructs every order line before any menu filter is applied.
 *
 * That order is essential: a query for one dish still needs the other dishes in
 * the same order to divide a shared ingredient's movement cost honestly.
 */
function reconstructOrder(
  order: Order,
  orderMovements: readonly InventoryMovement[] | undefined,
  recipes: ReadonlyMap<string, MenuRecipe> | undefined,
): readonly MutableLineCost[] {
  const lines = [...order.items]
    .sort((left, right) => right.id.localeCompare(left.id))
    .map((item) => lineFromOrderItem(order, item));

  if (recipes === undefined) {
    addIssueToLines(
      lines,
      HISTORICAL_ITEM_PROFIT_ISSUE.recipesUnavailable,
      "Recipes are unavailable, so historical item cost cannot be reconstructed.",
      order.id,
    );
    return lines;
  }

  const demandsByIngredient = new Map<string, ComponentDemand[]>();

  for (const line of lines) {
    const recipe = recipes.get(line.menuItemId);
    if (recipe === undefined) {
      addLineIssue(
        line,
        operationIssue(
          HISTORICAL_ITEM_PROFIT_ISSUE.missingRecipe,
          "This sale has no recipe, so its historical item cost is unknown.",
          line.orderItemId,
          { menuItemId: line.menuItemId },
        ),
      );
      continue;
    }

    if (
      recipe.packagingCost.currency !== line.revenue.currency ||
      recipe.additionalCost.currency !== line.revenue.currency
    ) {
      addLineIssue(
        line,
        operationIssue(
          HISTORICAL_ITEM_PROFIT_ISSUE.currencyMismatch,
          "Recipe and sale currencies differ, so historical profit is unknown.",
          line.orderItemId,
        ),
      );
    } else {
      // Packaging and extras are per sold menu unit, exactly as current HPP is.
      // They are not rounded here; D11/D19 deliberately preserve full precision.
      line.costAmount +=
        (recipe.packagingCost.amount + recipe.additionalCost.amount) * line.quantity;
    }

    for (const component of recipe.components) {
      const demands = demandsByIngredient.get(component.ingredientId) ?? [];
      demands.push({
        line,
        quantity: consumptionQuantity(component, line.quantity),
        unit: component.unit,
      });
      demandsByIngredient.set(component.ingredientId, demands);
    }
  }

  if (orderMovements === undefined) {
    addIssueToLines(
      lines,
      HISTORICAL_ITEM_PROFIT_ISSUE.movementsUnavailable,
      "Consumption movements are unavailable, so historical item cost is unknown.",
      order.id,
    );
    return lines;
  }

  const movementsByIngredient = new Map<string, InventoryMovement[]>();
  for (const movement of orderMovements) {
    const entries = movementsByIngredient.get(movement.ingredientId) ?? [];
    entries.push(movement);
    movementsByIngredient.set(movement.ingredientId, entries);
  }

  for (const [ingredientId, movements] of movementsByIngredient) {
    if (!demandsByIngredient.has(ingredientId)) {
      addIssueToLines(
        lines,
        HISTORICAL_ITEM_PROFIT_ISSUE.unattributedConsumption,
        "A recorded consumption movement has no current recipe component to receive it.",
        ingredientId,
        {
          orderId: order.id,
          movementIds: movements.map((movement) => movement.id).join(","),
        },
      );
    }
  }

  for (const [ingredientId, demands] of demandsByIngredient) {
    const movements = movementsByIngredient.get(ingredientId);
    const affectedLines = [...new Set(demands.map((demand) => demand.line))];

    if (movements === undefined || movements.length === 0) {
      addIssueToLines(
        affectedLines,
        HISTORICAL_ITEM_PROFIT_ISSUE.missingConsumption,
        "The current recipe expects an ingredient with no recorded consumption.",
        ingredientId,
        { orderId: order.id },
      );
      continue;
    }

    // Load-bearing D20 branch: null means pre-S11 UNKNOWN. It is never zero.
    if (movements.some((movement) => movement.unitCost === null)) {
      addIssueToLines(
        affectedLines,
        HISTORICAL_ITEM_PROFIT_ISSUE.missingConsumptionCost,
        "A consumption movement predates sale-time cost snapshots.",
        ingredientId,
        {
          orderId: order.id,
          movementIds: movements
            .filter((movement) => movement.unitCost === null)
            .map((movement) => movement.id)
            .join(","),
        },
      );
      continue;
    }

    const firstCost = movements[0]?.unitCost;
    if (firstCost === undefined || firstCost === null) continue;
    if (movements.some((movement) => movement.unitCost?.currency !== firstCost.currency)) {
      addIssueToLines(
        affectedLines,
        HISTORICAL_ITEM_PROFIT_ISSUE.currencyMismatch,
        "Consumption snapshots for one ingredient use different currencies.",
        ingredientId,
        { orderId: order.id },
      );
      continue;
    }

    const canonicalUnit = movements[0]?.unit;
    if (canonicalUnit === undefined) continue;

    const weightByLine = new Map<MutableLineCost, number>();
    let recordedQuantity = 0;
    let conversionFailed = false;

    try {
      for (const demand of demands) {
        const converted = convertInventoryQuantity(demand.quantity, demand.unit, canonicalUnit);
        weightByLine.set(demand.line, (weightByLine.get(demand.line) ?? 0) + converted);
      }
      for (const movement of movements) {
        recordedQuantity += convertInventoryQuantity(
          movement.quantity,
          movement.unit,
          canonicalUnit,
        );
      }
    } catch {
      conversionFailed = true;
    }

    const totalWeight = [...weightByLine.values()].reduce((total, quantity) => total + quantity, 0);

    if (conversionFailed || !Number.isFinite(totalWeight) || totalWeight <= 0) {
      addIssueToLines(
        affectedLines,
        HISTORICAL_ITEM_PROFIT_ISSUE.incompatibleUnit,
        "Current recipe quantities cannot be compared with recorded consumption units.",
        ingredientId,
        { orderId: order.id },
      );
      continue;
    }

    if (!approximatelyEqual(recordedQuantity, totalWeight)) {
      addIssueToLines(
        affectedLines,
        HISTORICAL_ITEM_PROFIT_ISSUE.consumptionQuantityMismatch,
        "Recorded consumption no longer matches current recipe quantities.",
        ingredientId,
        { orderId: order.id, recordedQuantity, reconstructedQuantity: totalWeight },
      );
      continue;
    }

    const totalRecordedCost = movements.reduce(
      (total, movement) => total + movement.quantity * (movement.unitCost?.amount ?? 0),
      0,
    );

    for (const [line, weight] of weightByLine) {
      if (line.revenue.currency !== firstCost.currency) {
        addLineIssue(
          line,
          operationIssue(
            HISTORICAL_ITEM_PROFIT_ISSUE.currencyMismatch,
            "Sale revenue and its consumption snapshot use different currencies.",
            line.orderItemId,
          ),
        );
        continue;
      }
      // Do not round: allocation preserves the stored snapshot's full precision.
      line.costAmount += totalRecordedCost * (weight / totalWeight);
    }
  }

  return lines;
}

function sortLines(lines: readonly MutableLineCost[]): readonly MutableLineCost[] {
  return [...lines].sort(
    (left, right) =>
      right.orderCreatedAt.localeCompare(left.orderCreatedAt) ||
      right.orderId.localeCompare(left.orderId) ||
      right.orderItemId.localeCompare(left.orderItemId),
  );
}

interface MutableMenuTotal {
  readonly menuItemId: string;
  readonly menuName: string;
  quantitySold: number;
  orderItemCount: number;
  unknownOrderItemCount: number;
  revenueAmount: number;
  costAmount: number;
  readonly currency: Money["currency"];
  readonly issues: OperationIssue[];
}

/** Aggregate only after every order-level shared-ingredient split is complete. */
function aggregateByMenu(
  lines: readonly MutableLineCost[],
  menuItemId: string | null,
): readonly HistoricalItemProfitRow[] {
  const totals = new Map<string, MutableMenuTotal>();

  for (const line of sortLines(lines)) {
    if (menuItemId !== null && line.menuItemId !== menuItemId) continue;
    const current = totals.get(line.menuItemId) ?? {
      menuItemId: line.menuItemId,
      // `sortLines` is newest-first, so the first sale-time name wins.
      menuName: line.menuName,
      quantitySold: 0,
      orderItemCount: 0,
      unknownOrderItemCount: 0,
      revenueAmount: 0,
      costAmount: 0,
      currency: line.revenue.currency,
      issues: [],
    };

    current.quantitySold += line.quantity;
    current.orderItemCount += 1;
    current.revenueAmount += line.revenue.amount;
    if (line.issues.length > 0) current.unknownOrderItemCount += 1;
    else current.costAmount += line.costAmount;
    current.issues.push(...line.issues);
    totals.set(line.menuItemId, current);
  }

  return [...totals.values()]
    .map((total): HistoricalItemProfitRow => {
      const issues = uniqueIssues(total.issues);
      const known = total.unknownOrderItemCount === 0;
      const revenue: Money = {
        amount: total.revenueAmount,
        currency: total.currency,
      };
      const reconstructedCost: Money | null = known
        ? { amount: total.costAmount, currency: total.currency }
        : null;
      const reconstructedProfit: Money | null =
        reconstructedCost === null
          ? null
          : {
              amount: revenue.amount - reconstructedCost.amount,
              currency: total.currency,
            };

      return {
        menuItemId: total.menuItemId,
        menuName: total.menuName,
        quantitySold: total.quantitySold,
        orderItemCount: total.orderItemCount,
        unknownOrderItemCount: total.unknownOrderItemCount,
        revenue,
        reconstructedCost,
        reconstructedProfit,
        costStatus: known ? "known" : "unknown",
        issues,
      };
    })
    .sort(
      (left, right) =>
        left.menuName.localeCompare(right.menuName) ||
        left.menuItemId.localeCompare(right.menuItemId),
    );
}

function noStore(): OperationResult<HistoricalItemProfitCollection> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No inventory store is connected, so historical item profit cannot be reconstructed.",
      "queryHistoricalItemProfits",
    ),
  ]);
}

function unavailableDependency(): OperationResult<HistoricalItemProfitCollection> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      HISTORICAL_ITEM_PROFIT_ISSUE.dependencyUnavailable,
      "The required Orders read capability was unavailable during creation.",
      HISTORICAL_ITEM_PROFIT_ID,
    ),
  ]);
}

function historicalItemProfitOverSources(
  store: InventoryStorePort,
  orders: OrderRead,
): HistoricalItemProfit {
  return {
    async queryHistoricalItemProfits(
      rawQuery: HistoricalItemProfitQuery,
    ): Promise<OperationResult<HistoricalItemProfitCollection>> {
      const validated = validateQuery(rawQuery);
      if (validated.status === "failure") return validated;
      const query = validated.value;

      const [orderSource, movementSource, recipeSource] = await Promise.all([
        loadOrders(orders, query),
        loadStoreSource("movements", () =>
          store.listMovements({ outletId: query.outletId, type: "consumption" }),
        ),
        loadStoreSource("recipes", () => store.listRecipes()),
      ]);
      const sources = [orderSource, movementSource, recipeSource] as const;
      const sourceIssues = sources.flatMap((source) => source.issues);

      if (sources.every((source) => source.value === undefined)) {
        return operationFailure("failed", [
          operationIssue(
            HISTORICAL_ITEM_PROFIT_ISSUE.allSourcesUnavailable,
            "No historical item profit source produced usable data.",
            HISTORICAL_ITEM_PROFIT_ID,
          ),
          ...sourceIssues,
        ]);
      }

      // Orders define the authoritative row set. Inventory data without an order
      // cannot produce a truthful per-item result, so do not fabricate an empty
      // collection when that one source is absent.
      if (orderSource.value === undefined) {
        return operationFailure("failed", sourceIssues);
      }

      try {
        const selectedOrders = filterOrders(orderSource.value, query);
        const selectedOrderIds = new Set(selectedOrders.map((order) => order.id));
        const movements =
          movementSource.value === undefined
            ? undefined
            : filterMovements(movementSource.value, query, selectedOrderIds);
        const movementsByOrderId = new Map<string, InventoryMovement[]>();
        for (const movement of movements ?? []) {
          const referenceId = movement.referenceId;
          if (referenceId === null) continue;
          const entries = movementsByOrderId.get(referenceId) ?? [];
          entries.push(movement);
          movementsByOrderId.set(referenceId, entries);
        }
        const recipeMap =
          recipeSource.value === undefined ? undefined : recipesByMenuItemId(recipeSource.value);

        const lines = selectedOrders.flatMap((order) =>
          reconstructOrder(
            order,
            movements === undefined ? undefined : (movementsByOrderId.get(order.id) ?? []),
            recipeMap,
          ),
        );
        const items = aggregateByMenu(lines, query.menuItemId);
        const rowIssues = items.flatMap((item) => item.issues);
        const issues = uniqueIssues([...sourceIssues, ...rowIssues]);
        const failedSources = HISTORICAL_ITEM_PROFIT_SOURCES.filter((source) => {
          const loaded = sources.find((entry) => entry.source === source);
          return loaded === undefined || loaded.value === undefined || loaded.issues.length > 0;
        });
        const collection: HistoricalItemProfitCollection = {
          attribution: HISTORICAL_ITEM_PROFIT_ATTRIBUTION,
          recipeAssumption: HISTORICAL_ITEM_PROFIT_RECIPE_ASSUMPTION,
          failedSources,
          items,
        };

        return operationDegraded(collection, issues);
      } catch (error) {
        return operationFailure("failed", [
          operationIssue(
            HISTORICAL_ITEM_PROFIT_ISSUE.reconstructionFailed,
            error instanceof Error
              ? error.message
              : "Historical item profit reconstruction failed.",
            HISTORICAL_ITEM_PROFIT_ID,
          ),
          ...sourceIssues,
        ]);
      }
    },
  };
}

function historicalItemProfitWithoutStore(): HistoricalItemProfit {
  return { queryHistoricalItemProfits: async () => noStore() };
}

function historicalItemProfitWithoutOrders(): HistoricalItemProfit {
  return { queryHistoricalItemProfits: async () => unavailableDependency() };
}

export function createHistoricalItemProfit(context: LogicChildContext): HistoricalItemProfit {
  const store = context.ports.resolve(INVENTORY_STORE_PORT);
  const orders = context.capabilities.resolve(ORDER_READ);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No inventory store was supplied to historical-item-profit, so calls return a " +
        "normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "historicalItemProfitChild",
    });
  }

  const capability =
    store === undefined
      ? historicalItemProfitWithoutStore()
      : orders.status !== "available"
        ? historicalItemProfitWithoutOrders()
        : historicalItemProfitOverSources(store, orders.value);

  context.capabilities.provide(HISTORICAL_ITEM_PROFIT, capability);
  return capability;
}

export default defineLogicChild<HistoricalItemProfit>({
  id: HISTORICAL_ITEM_PROFIT_ID,
  parentId: INVENTORY_ENGINE_ID,
  provides: [HISTORICAL_ITEM_PROFIT_ID],
  requires: [ORDER_READ_ID],
  create: createHistoricalItemProfit,
});
