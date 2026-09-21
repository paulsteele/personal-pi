import { AsyncLocalStorage } from "node:async_hooks";

interface ToolCommits {
	active: boolean;
	changes: Array<() => void>;
}
/** Only the current tool's bookkeeping is staged; sibling tools retain their own commits. */
const pending = new AsyncLocalStorage<ToolCommits | undefined>();

export function deferToolCommit(commit: () => void): boolean {
	const transaction = pending.getStore();
	if (!transaction?.active) return false;
	transaction.changes.push(commit);
	return true;
}

export async function commitToolResult<T>(executeAndAuthorize: () => Promise<T>): Promise<T> {
	const inherited = pending.getStore();
	const parent = inherited?.active ? inherited : undefined;
	const transaction: ToolCommits = { active: true, changes: [] };
	try {
		const result = await pending.run(transaction, executeAndAuthorize);
		transaction.active = false;
		const changes = transaction.changes.splice(0);
		// UI callbacks may outlive a tool's async context; never append to a retired parent's queue.
		if (parent) {
			if (parent.active) parent.changes.push(...changes);
		} else
			pending.run(undefined, () => {
				for (const commit of changes) commit();
			});
		return result;
	} finally {
		transaction.active = false;
		transaction.changes.length = 0;
	}
}
