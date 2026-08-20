import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import copyableCodeBlocks from "./code-blocks/index.ts";

/**
 * Entry point for personal Pi extensions.
 *
 * Keep each plugin in its own subdirectory, then import and register it here.
 * Pi auto-discovers this file as ~/.pi/agent/extensions/local/index.ts.
 */
export default function localExtensions(pi: ExtensionAPI): void {
	copyableCodeBlocks(pi);
}
