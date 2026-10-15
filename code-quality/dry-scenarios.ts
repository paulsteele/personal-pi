export interface DryScenario {
	name: string;
	extension: string;
	changed: string;
	counterpart: string;
	expected: "approved" | "needs_work";
	notes: string[];
}
export const DRY_SCENARIOS: DryScenario[] = [
	{
		name: "shared token lifetime",
		extension: "ts",
		expected: "needs_work",
		notes: ["Both handlers own the same access-token lifetime policy."],
		changed: "export function apiTokenLifetimeMs() { return 30 * 24 * 60 * 60 * 1000; }",
		counterpart: "export function browserTokenLifetimeMs() { return 30 * 24 * 60 * 60 * 1000; }",
	},
	{
		name: "independent retention and expiry",
		extension: "py",
		expected: "approved",
		notes: [],
		changed: "def invoice_retention_days():\n    return 30\n",
		counterpart: "def access_token_expiry_days():\n    return 30\n",
	},
	{
		name: "shared repository identity",
		extension: "go",
		expected: "needs_work",
		notes: ["Both extensions implement the same repository identity contract."],
		changed:
			"func QualityRepositoryID(commonDir string) string { sum := sha256.Sum256([]byte(commonDir)); return hex.EncodeToString(sum[:]) }",
		counterpart:
			"func ReviewRepositoryID(commonDir string) string { sum := sha256.Sum256([]byte(commonDir)); return hex.EncodeToString(sum[:]) }",
	},
	{
		name: "explicit Rust test attempts",
		extension: "rs",
		expected: "approved",
		notes: [],
		changed:
			"#[test]\nfn expired_token_is_denied() { let token = expired_token(); assert_eq!(authorize(token), Denied); }",
		counterpart:
			"#[test]\nfn expired_token_cannot_refresh() { let token = expired_token(); assert_eq!(refresh(token), Denied); }",
	},
	{
		name: "external C# schema keys",
		extension: "cs",
		expected: "approved",
		notes: ["The external protocol prescribes both serialized representations."],
		changed: 'record ClientMessage([property: JsonPropertyName("requestId")] string RequestId);',
		counterpart: 'record ServerMessage([property: JsonPropertyName("requestId")] string RequestId);',
	},
	{
		name: "independent Ruby lifecycles",
		extension: "rb",
		expected: "approved",
		notes: [],
		changed: "def stop_watch\n  @watcher.close\n  @watcher = nil\nend",
		counterpart: "def stop_transaction\n  @transaction.close\n  @transaction = nil\nend",
	},
];
