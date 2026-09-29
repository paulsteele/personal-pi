import type { LspCheckResult, LspFileRequest, LspServerStatus } from "./lsp-diagnostics.js";
import type { LspRoute } from "./lsp-profile.js";
import { isAbsolute } from "node:path";

export const LSP_BROKER_VERSION = 1;
export interface BrokerLaunch {
	version: 1;
	key: string;
	generation: string;
	token: string;
	socket: string;
	directory: string;
	root: string;
	route: LspRoute;
}
export interface BrokerRegistry extends BrokerLaunch {
	pid: number;
}
export type BrokerRequest = {
	id: string;
	token: string;
	clientId: string;
	method: "attach" | "check" | "status" | "detach" | "cancel" | "restart";
	files?: LspFileRequest[];
	requestId?: string;
};
export interface BrokerReply {
	id?: string;
	result?: LspCheckResult | LspServerStatus;
	error?: string;
	event?: "status" | "invalidated";
	status?: LspServerStatus;
}
export function parseBrokerRequest(value: unknown): BrokerRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid broker request");
	const request = value as BrokerRequest;
	const identities = [
		["id", request.id],
		["clientId", request.clientId],
		["token", request.token],
	] as const;
	for (const [name, value] of identities) {
		if (typeof value !== "string" || !value || value.length > 160 || /[\u0000-\u001f]/.test(value))
			throw new Error(`Invalid broker request ${name}`);
	}
	if (!["attach", "check", "status", "detach", "cancel", "restart"].includes(request.method))
		throw new Error("Unsupported broker operation");
	if (request.method === "check") {
		if (!Array.isArray(request.files) || !request.files.length || request.files.length > 96)
			throw new Error("Invalid file check scope");
		for (const file of request.files) {
			if (
				!file ||
				typeof file.path !== "string" ||
				file.path.length > 4096 ||
				!isAbsolute(file.path) ||
				file.path.includes("\0") ||
				!/^[a-f0-9]{64}$/.test(file.hash) ||
				typeof file.languageId !== "string" ||
				!file.languageId ||
				file.languageId.length > 80
			)
				throw new Error("Invalid file check input");
		}
	}
	if (request.method === "cancel") {
		if (typeof request.requestId !== "string" || request.requestId.length > 160)
			throw new Error("Invalid cancellation request ID");
	}
	return request;
}
