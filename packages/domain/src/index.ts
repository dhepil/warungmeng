// packages/domain/src/index.ts
//
// Public barrel for the pure domain package. Re-exports every domain module so consumers
// import from "@warungmeng/domain" rather than reaching into individual files.

export * from "./catalog";
export * from "./orders";
export * from "./inventory";
export * from "./finance";
export * from "./reporting";
