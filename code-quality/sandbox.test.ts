import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { readGuestSnapshot, type QualitySandbox } from "./sandbox.js";

function sandboxWithFile(contents: string): QualitySandbox {
	return {
		sessionId: "session",
		revision: () => "revision",
		session: {
			generation: 1,
			processSupervisor: "fixture supervisor",
			environment: { container: "container", user: "root", workspace: "/workspace", configuration: {} },
			filesystem: {
				canonical: async (path) => path,
				read: async () => Buffer.from(contents),
				stat: async () => ({ file: true, directory: false, size: Buffer.byteLength(contents) }),
				write: async () => {},
				mkdir: async () => {},
				list: async () => [],
			},
			execute: async () => ({ output: Buffer.alloc(0), stderr: "", code: 0 }),
		},
	};
}

it("reviews guest-accessible external files without repository-membership authorization", async () => {
	const sandbox = sandboxWithFile("export const external = true;\n");
	expect(await readGuestSnapshot(sandbox, "/external/helper.ts", DEFAULT_CONFIG, false)).toBe(
		"export const external = true;\n",
	);
});

it("retains sensitive-content disclosure checks for externally mounted files", async () => {
	const sandbox = sandboxWithFile("Bearer " + "x".repeat(25));
	await expect(readGuestSnapshot(sandbox, "/external/helper.ts", DEFAULT_CONFIG, false)).rejects.toThrow(
		"secret",
	);
	expect(await readGuestSnapshot(sandbox, "/external/helper.ts", DEFAULT_CONFIG, true)).toContain("Bearer");
});
