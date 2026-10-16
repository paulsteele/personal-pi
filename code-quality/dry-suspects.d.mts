export type LinguistAttribute = "vendored" | "generated";
export interface DrySuspectDirectory {
	directory: string;
	suspectSignal: string;
	files: number;
	bytes: number;
}
export function suspectDirectories(
	paths: string[],
	stagedBytesByPath: Map<string, number>,
	linguistAttributeByPath: Map<string, LinguistAttribute>,
	profile: { include: string[] },
): DrySuspectDirectory[];
