import { type Component, ScrollView } from "@earendil-works/pi-tui";

interface LayoutNode {
	type: "scroll" | "vstack" | "hstack";
	state?: ScrollView;
	component?: Component;
	entries?: readonly { component: Component }[];
	gap?: number;
}

function getLayoutNode(component: Component): LayoutNode | undefined {
	const layoutComponent = component as Component & {
		[key: symbol]: (() => LayoutNode) | undefined;
	};
	return layoutComponent[Symbol.for("@earendil-works/pi-tui/layout-node")]?.();
}

function findTranscript(root: Component): ScrollView | undefined {
	const node = getLayoutNode(root);
	if (node?.type === "scroll") {
		return node.state?.primary && typeof node.state.scrollTo === "function" ? node.state : undefined;
	}
	if (node?.type !== "vstack" && node?.type !== "hstack") {
		return undefined;
	}
	for (const entry of node.entries ?? []) {
		const transcript = findTranscript(entry.component);
		if (transcript) {
			return transcript;
		}
	}
	return undefined;
}

function toolOffset(component: Component, toolCallId: string, width: number): number | undefined {
	const tool = component as Component & { toolCallId?: unknown; children?: Component[] };
	if (tool.toolCallId === toolCallId) {
		return component.render(width).length > 0 ? 0 : undefined;
	}
	const node = getLayoutNode(component);
	if (node?.type === "hstack" || node?.type === "scroll") {
		return undefined;
	}
	const children = node?.type === "vstack" ? node.entries?.map((entry) => entry.component) : tool.children;
	if (!children) {
		return undefined;
	}
	let precedingRows = 0;
	for (const child of children) {
		const offset = toolOffset(child, toolCallId, width);
		if (offset !== undefined) {
			return precedingRows + offset;
		}
		precedingRows += child.render(width).length + (node?.type === "vstack" ? (node.gap ?? 0) : 0);
	}
	return undefined;
}

export function scrollTranscriptToTool(root: Component, width: number, toolCallId: string): boolean {
	const transcript = findTranscript(root);
	if (!transcript) {
		return false;
	}
	const document = getLayoutNode(transcript);
	if (document?.type !== "scroll" || !document.component) {
		return false;
	}
	const contentWidth = transcript.getContentWidth(width);
	let targetId = toolCallId;
	while (targetId) {
		const offset = toolOffset(document.component, targetId, contentWidth);
		if (offset !== undefined) {
			transcript.scrollTo(offset, { disableFollow: true });
			return true;
		}
		const parentSeparator = targetId.lastIndexOf("/");
		if (parentSeparator < 0) {
			return false;
		}
		targetId = targetId.slice(0, parentSeparator);
	}
	return false;
}
