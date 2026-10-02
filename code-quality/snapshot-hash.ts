import { createHash } from "node:crypto";

export const digest = (text: string | null): string =>
	createHash("sha256")
		.update(text === null ? "absent:" : `text:${text}`)
		.digest("hex");
