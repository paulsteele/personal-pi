import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoMode from "./auto-mode/index.ts";
import claudeSkills from "./claude-skills/index.ts";
import copyableCodeBlocks from "./code-blocks/index.ts";
import desktopNotifications from "./desktop-notifications/index.ts";
import atelier from "./pi-atelier/extensions/index.ts";

/**
 * Entry point for personal Pi extensions.
 *
 * Keep each plugin in its own subdirectory, then import and register it here.
 * Pi auto-discovers this file as ~/.pi/agent/extensions/local/index.ts.
 */
export default function localExtensions(pi: ExtensionAPI): void {
	claudeSkills(pi);
	copyableCodeBlocks(pi);
	desktopNotifications(pi);
	// Registered before Atelier so its sidebar panel is published by the time
	// Atelier's registry starts; the protocol also replays on discovery, so the
	// ordering is a small optimization rather than a requirement.
	autoMode(pi);
	atelier(pi);
}
