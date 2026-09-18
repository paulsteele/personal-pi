import type { Usage } from "@earendil-works/pi-ai";

export type RequestKind = "first" | "continuation" | "compaction";
export const REQUEST_KINDS: RequestKind[] = ["first", "continuation", "compaction"];
/** Optional fields distinguish legacy reports from measured zero cache usage. */
export interface UsageTotals {
	input: number;
	output: number;
	cost: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costBreakdown?: Usage["cost"];
	byRequest?: Record<RequestKind, UsageBucket>;
}
export type UsageBucket = Omit<UsageTotals, "byRequest"> & { requests: number };
function zeroBucket(): UsageBucket {
	return {
		requests: 0,
		input: 0,
		output: 0,
		cost: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
export function emptyUsage(): UsageTotals {
	const { requests: _, ...totals } = zeroBucket();
	return {
		...totals,
		byRequest: { first: zeroBucket(), continuation: zeroBucket(), compaction: zeroBucket() },
	};
}
export function sumUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	const result: UsageTotals = {
		input: a.input + b.input,
		output: a.output + b.output,
		cost: a.cost + b.cost,
	};
	for (const key of ["cacheRead", "cacheWrite", "totalTokens"] as const)
		if (a[key] !== undefined && b[key] !== undefined) result[key] = a[key]! + b[key]!;
	if (a.costBreakdown && b.costBreakdown) {
		result.costBreakdown = { ...a.costBreakdown };
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			result.costBreakdown[key] += b.costBreakdown[key];
	}
	if (a.byRequest && b.byRequest) {
		result.byRequest = {} as Record<RequestKind, UsageBucket>;
		for (const kind of REQUEST_KINDS)
			result.byRequest[kind] = {
				...sumUsage(a.byRequest[kind], b.byRequest[kind]),
				requests: a.byRequest[kind].requests + b.byRequest[kind].requests,
			};
	}
	return result;
}
export function providerUsage(value: Usage, kind: RequestKind): UsageTotals {
	const result = emptyUsage();
	const totals = {
		input: value.input,
		output: value.output,
		cost: value.cost.total,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		totalTokens: value.totalTokens,
		costBreakdown: { ...value.cost },
	};
	Object.assign(result, totals);
	Object.assign(result.byRequest![kind], totals);
	return result;
}
/** Do not manufacture cache counters for historical/partial reports. */
export function toProviderUsage(value: UsageTotals): Usage | undefined {
	if (
		value.cacheRead === undefined ||
		value.cacheWrite === undefined ||
		value.totalTokens === undefined ||
		!value.costBreakdown
	)
		return undefined;
	return {
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		totalTokens: value.totalTokens,
		cost: { ...value.costBreakdown },
	};
}
export function formatUsage(value: UsageTotals): string {
	const cache =
		value.cacheRead === undefined || value.cacheWrite === undefined
			? "cache metrics unavailable"
			: `${value.cacheRead} cache read / ${value.cacheWrite} cache write${value.input + value.cacheRead + value.cacheWrite > 0 ? ` (${((100 * value.cacheRead) / (value.input + value.cacheRead + value.cacheWrite)).toFixed(1)}% input cache hit)` : ""}`;
	return `${value.input} uncached input / ${value.output} output tokens; ${cache}; ${value.totalTokens ?? "unknown"} total tokens; $${value.cost.toFixed(4)}`;
}
export function formatCost(value: UsageTotals): string {
	const cost = value.costBreakdown;
	return cost
		? `Cost: input $${cost.input.toFixed(4)} / cache read $${cost.cacheRead.toFixed(4)} / cache write $${cost.cacheWrite.toFixed(4)} / output $${cost.output.toFixed(4)}`
		: "Cost breakdown unavailable";
}
