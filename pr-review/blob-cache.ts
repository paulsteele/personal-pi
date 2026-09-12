/** A byte-bounded immutable-blob LRU. Only one cache miss allocates a buffer at a time. */
export class BlobCache {
	private readonly values = new Map<string, Buffer>();
	private readonly pending = new Map<string, Promise<Buffer>>();
	private tail: Promise<void> = Promise.resolve();
	private retained = 0;
	private reserved = 0;
	constructor(
		private readonly options: {
			maxBytes: number;
			maxFileBytes: number;
			size(id: string): Promise<number>;
			load(id: string, size: number): Promise<Buffer>;
		},
	) {}
	get stats() {
		return {
			retainedBytes: this.retained,
			reservedBytes: this.reserved,
			entries: this.values.size,
			pending: this.pending.size,
		};
	}
	get(id: string): Promise<Buffer> {
		const cached = this.values.get(id);
		if (cached) {
			this.values.delete(id);
			this.values.set(id, cached);
			return Promise.resolve(cached);
		}
		const inFlight = this.pending.get(id);
		if (inFlight) return inFlight;
		const load = this.tail.then(async () => {
			const size = await this.options.size(id);
			if (
				!Number.isSafeInteger(size) ||
				size < 0 ||
				size > this.options.maxFileBytes ||
				size > this.options.maxBytes
			)
				throw new Error("Source blob exceeds cache/file budget");
			while (this.retained + size > this.options.maxBytes) {
				const first = this.values.entries().next().value;
				if (!first) throw new Error("Source cache budget exhausted");
				this.values.delete(first[0]);
				this.retained -= first[1].length;
			}
			this.reserved = size;
			try {
				const data = await this.options.load(id, size);
				if (data.length !== size) throw new Error("Source blob size changed while reading");
				this.values.set(id, data);
				this.retained += size;
				return data;
			} finally {
				this.reserved = 0;
			}
		});
		this.pending.set(id, load);
		this.tail = load.then(
			() => {},
			() => {},
		);
		void load.then(
			() => this.pending.delete(id),
			() => this.pending.delete(id),
		);
		return load;
	}
}
