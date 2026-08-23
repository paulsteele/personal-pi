/**
 * Minimal ambient declarations for `bun:test`.
 *
 * The local plugins run their suites under `bun test`, but typechecking uses
 * the Atelier fork's pinned TypeScript, which has no Bun types available. This
 * declares only the surface the auto-mode suite actually uses.
 */
declare module "bun:test" {
	export function describe(label: string, body: () => void): void;
	export function test(label: string, body: () => void | Promise<void>): void;

	interface Matchers {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toContain(expected: unknown): void;
		toBeDefined(): void;
		toBeUndefined(): void;
		toBeNull(): void;
		toBeGreaterThan(expected: number): void;
		toBeLessThanOrEqual(expected: number): void;
		toHaveLength(expected: number): void;
		readonly not: Matchers;
	}

	export function expect(actual: unknown): Matchers;
}
