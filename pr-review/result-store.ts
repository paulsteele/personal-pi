import { actionPayload, fitsResult, redactedData } from "./handoff.js";
import type { SourceEffect } from "./permissions.js";
import { SnapshotStore, textPage } from "./snapshot-store.js";
import { readStored, storedFileMetadataFingerprint } from "./storage.js";
import type { Repo, Report } from "./types.js";

export type ResultSection = "action" | "report";
export interface RegisteredReport {
	root: string;
	path: string;
	repo: Repo;
	reportId: string;
	revision: string;
	fileMetadataFingerprint: string;
	dependencies: SourceEffect[];
}
interface SectionFile {
	path: string;
	fileMetadataFingerprint: string;
}
interface SectionBacking {
	store: SnapshotStore;
	files: Record<ResultSection, SectionFile>;
}

function storedReport(value: unknown, reportId: string, repoId: string): Report {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid saved review report");
	}
	const report = value as Report;
	if (report.version !== 1 || report.id !== reportId || report.repoId !== repoId) {
		throw new Error("Saved review report identity does not match");
	}
	return report;
}

export async function prepareReport(
	root: string,
	path: string,
	repo: Repo,
	report: Report,
	dependencies: SourceEffect[],
): Promise<RegisteredReport> {
	const fileMetadataFingerprint = await storedFileMetadataFingerprint(root, path);
	const saved = await readStored(root, path);
	if (!saved || !fileMetadataFingerprint) {
		throw new Error("Saved review report is unavailable");
	}
	if (fileMetadataFingerprint !== (await storedFileMetadataFingerprint(root, path))) {
		throw new Error("Saved review report changed during registration");
	}
	const value = storedReport(saved.value, report.id, repo.id);
	if (JSON.stringify(actionPayload(value)) !== JSON.stringify(actionPayload(report))) {
		throw new Error("Saved action payload differs from the final review result");
	}
	return {
		root,
		path,
		repo: { ...repo },
		reportId: report.id,
		revision: saved.revision,
		fileMetadataFingerprint,
		dependencies: dependencies.map((source) => ({ ...source })),
	};
}

export class ResultStore {
	private readonly reports = new Map<string, RegisteredReport>();
	private readonly backings = new Map<RegisteredReport, Promise<SectionBacking>>();
	private sessionId: string | undefined;

	clear(): void {
		this.reports.clear();
		this.sessionId = undefined;
		for (const backing of this.backings.values()) {
			void backing.then((value) => value.store.dispose()).catch(() => {});
		}
		this.backings.clear();
	}

	publish(entry: RegisteredReport, sessionId: string): void {
		if (!sessionId) {
			throw new Error("Review result requires a session identity");
		}
		if (this.sessionId !== sessionId) {
			this.clear();
			this.sessionId = sessionId;
		}
		const previous = this.reports.get(entry.reportId);
		if (previous && previous !== entry) {
			const backing = this.backings.get(previous);
			this.backings.delete(previous);
			void backing?.then((value) => value.store.dispose()).catch(() => {});
		}
		this.reports.set(entry.reportId, entry);
	}

	get(reportId: string, sessionId: string): RegisteredReport {
		const entry = this.reports.get(reportId);
		if (this.sessionId !== sessionId || !entry) {
			throw new Error("Unknown or expired review result; only reports handed to this session are available");
		}
		return entry;
	}

	assertCurrent(entry: RegisteredReport, sessionId: string): void {
		if (this.get(entry.reportId, sessionId) !== entry) {
			throw new Error("Review result registration changed");
		}
	}

	private async validateSavedFile(entry: RegisteredReport, sessionId: string): Promise<void> {
		this.assertCurrent(entry, sessionId);
		const fingerprint = await storedFileMetadataFingerprint(entry.root, entry.path);
		this.assertCurrent(entry, sessionId);
		if (!fingerprint) {
			throw new Error("Review report is unavailable; retained history may have removed it");
		}
		if (fingerprint !== entry.fileMetadataFingerprint) {
			throw new Error("Saved review report changed; rerun the review");
		}
	}

	private async materialize(entry: RegisteredReport, sessionId: string): Promise<SectionBacking> {
		await this.validateSavedFile(entry, sessionId);
		const saved = await readStored(entry.root, entry.path);
		await this.validateSavedFile(entry, sessionId);
		if (!saved || saved.revision !== entry.revision) {
			throw new Error("Saved review report changed; rerun the review");
		}
		const report = storedReport(saved.value, entry.reportId, entry.repo.id);
		const store = await SnapshotStore.createAtRoot(entry.root);
		try {
			const action = await store.put(JSON.stringify(actionPayload(report)));
			const { markdown: _markdown, ...audit } = report as Report & { markdown?: string };
			const auditPath = await store.put(JSON.stringify(redactedData(audit)));
			const actionFingerprint = await storedFileMetadataFingerprint(entry.root, action);
			const auditFingerprint = await storedFileMetadataFingerprint(entry.root, auditPath);
			if (!actionFingerprint || !auditFingerprint) {
				throw new Error("Prepared result backing is unavailable");
			}
			await this.validateSavedFile(entry, sessionId);
			return {
				store,
				files: {
					action: { path: action, fileMetadataFingerprint: actionFingerprint },
					report: { path: auditPath, fileMetadataFingerprint: auditFingerprint },
				},
			};
		} catch (error) {
			await store.dispose();
			throw error;
		}
	}

	private backing(entry: RegisteredReport, sessionId: string): Promise<SectionBacking> {
		let pending = this.backings.get(entry);
		if (!pending) {
			pending = this.materialize(entry, sessionId);
			this.backings.set(entry, pending);
			void pending.catch(() => {
				if (this.backings.get(entry) === pending) {
					this.backings.delete(entry);
				}
			});
		}
		return pending;
	}

	async page(
		entry: RegisteredReport,
		sessionId: string,
		section: ResultSection,
		cursor = 0,
		signal?: AbortSignal,
	) {
		if (section !== "action" && section !== "report") {
			throw new Error("Unknown review result section");
		}
		if (!Number.isSafeInteger(cursor) || cursor < 0) {
			throw new Error("Invalid result cursor; use the returned nextOffset (UTF-16 code units)");
		}
		signal?.throwIfAborted();
		await this.validateSavedFile(entry, sessionId);
		const backing = await this.backing(entry, sessionId);
		signal?.throwIfAborted();
		const file = backing.files[section];
		if ((await storedFileMetadataFingerprint(entry.root, file.path)) !== file.fileMetadataFingerprint) {
			throw new Error("Prepared result backing changed");
		}
		const start = Math.max(0, cursor - 1);
		const window = await textPage(file.path, start, 8002, signal);
		const localOffset = cursor - start;
		if (cursor > window.total || splitsSurrogatePair(window.text, localOffset)) {
			throw new Error("Invalid result cursor; use the returned nextOffset (UTF-16 code units)");
		}
		let end = Math.min(window.total, cursor + 8000);
		if (splitsSurrogatePair(window.text, end - start)) {
			end--;
		}
		await this.validateSavedFile(entry, sessionId);
		if ((await storedFileMetadataFingerprint(entry.root, file.path)) !== file.fileMetadataFingerprint) {
			throw new Error("Prepared result backing changed");
		}
		signal?.throwIfAborted();
		this.assertCurrent(entry, sessionId);
		return formatPage(
			entry.reportId,
			section,
			window.text.slice(localOffset, end - start),
			cursor,
			window.total,
		);
	}
}

function splitsSurrogatePair(text: string, offset: number): boolean {
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function formatPage(reportId: string, section: ResultSection, text: string, offset: number, total: number) {
	const end = offset + text.length;
	const page = {
		reportId,
		section,
		text,
		offset,
		totalCharacters: total,
		cursorUnits: "UTF-16 code units",
		nextOffset: end < total ? end : null,
	};
	if (!fitsResult(JSON.stringify(page))) {
		throw new Error("Review result page exceeds the output budget");
	}
	return page;
}

export function resultPage(reportId: string, section: ResultSection, text: string, cursor = 0) {
	if (
		!Number.isSafeInteger(cursor) ||
		cursor < 0 ||
		cursor > text.length ||
		splitsSurrogatePair(text, cursor)
	) {
		throw new Error("Invalid result cursor; use the returned nextOffset (UTF-16 code units)");
	}
	let end = Math.min(text.length, cursor + 8000);
	if (splitsSurrogatePair(text, end)) {
		end--;
	}
	return formatPage(reportId, section, text.slice(cursor, end), cursor, text.length);
}
