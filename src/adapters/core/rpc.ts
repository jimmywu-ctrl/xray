import type { AveQueryParams, AveQueryResult } from "./types.js";

/** Desktop-owned authenticated transports exposed to provider adapters. */
export interface Bridge {
  aveQuery(params: AveQueryParams, signal?: AbortSignal): Promise<AveQueryResult>;
}
