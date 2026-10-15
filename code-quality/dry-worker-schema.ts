import { Type } from "typebox";
import { Check } from "typebox/value";
import { DryLineRangeSchema, type DryIndexedFile, type DryManifest, type DryReport } from "./dry-types.js";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const count = Type.Integer({ minimum: 0 });
const relativePath = Type.String({
	minLength: 1,
	maxLength: 4096,
	pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\u0000]+$",
});
const IndexedMetadataSchema = Type.Object(
	{
		path: relativePath,
		hash,
		format: Type.String({ minLength: 1, maxLength: 80 }),
		bytes: count,
		lines: Type.Integer({ minimum: 1 }),
		suppressed: Type.Boolean(),
	},
	{ additionalProperties: false },
);
const IndexedFileSchema = Type.Object(
	{
		...IndexedMetadataSchema.properties,
		windows: Type.Array(
			Type.Object(
				{
					range: DryLineRangeSchema,
					features: Type.Array(Type.String({ minLength: 1, maxLength: 240 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
const ReportSchema = Type.Object(
	{
		version: Type.Literal(1),
		manifestRevision: hash,
		cloneCounts: Type.Object(
			{ exact: count, renamed: count, gap: count, ast: count },
			{ additionalProperties: false },
		),
		analyzedFiles: count,
		formats: Type.Array(
			Type.Object(
				{ name: Type.String({ minLength: 1, maxLength: 80 }), files: count },
				{ additionalProperties: false },
			),
		),
		scanDurationMs: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
const ManifestSchema = Type.Object(
	{
		version: Type.Literal(1),
		revision: hash,
		files: Type.Array(IndexedMetadataSchema),
		excluded: Type.Array(
			Type.Object(
				{ path: relativePath, reason: Type.String({ minLength: 1, maxLength: 240 }) },
				{ additionalProperties: false },
			),
		),
		truncated: Type.Boolean(),
		bytes: count,
	},
	{ additionalProperties: false },
);
export function isIndexedFile(value: unknown): value is DryIndexedFile {
	if (!Check(IndexedFileSchema, value)) {
		return false;
	}
	const file = value as DryIndexedFile;
	return file.windows.every((window) => window.range[0] <= window.range[1] && window.range[1] <= file.lines);
}
export function isReport(value: unknown): value is DryReport {
	return Check(ReportSchema, value);
}
export function isManifest(value: unknown): value is DryManifest {
	if (!Check(ManifestSchema, value)) {
		return false;
	}
	const manifest = value as DryManifest;
	const paths = manifest.files.map((file) => file.path);
	const hasUniquePaths = new Set(paths).size === paths.length;
	const hasNoParentDirectorySegments = paths.every((path) => !path.split("/").includes(".."));
	return hasUniquePaths && hasNoParentDirectorySegments;
}
