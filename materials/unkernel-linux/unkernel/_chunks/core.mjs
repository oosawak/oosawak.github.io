const VSOCK_HOST_CID = 2;
const VSOCK_GUEST_CID = 3;
const VSOCK_HEADER_SIZE = 44;
const FIRST_HOST_PORT = 49152;
const CLOSE_TIMEOUT_MS = 8e3;
const CREDIT_RETRY_MS = 500;
const BACKLOG = 128;
function decodeVsockHeader(pkt) {
	const dv = new DataView(pkt.buffer, pkt.byteOffset, 44);
	return {
		srcCid: dv.getUint32(0, true) + dv.getUint32(4, true) * 2 ** 32,
		dstCid: dv.getUint32(8, true) + dv.getUint32(12, true) * 2 ** 32,
		srcPort: dv.getUint32(16, true),
		dstPort: dv.getUint32(20, true),
		len: dv.getUint32(24, true),
		type: dv.getUint16(28, true),
		op: dv.getUint16(30, true),
		flags: dv.getUint32(32, true),
		bufAlloc: dv.getUint32(36, true),
		fwdCnt: dv.getUint32(40, true)
	};
}
function encodeVsockPacket(h, payload) {
	const n = payload?.length ?? 0;
	const pkt = new Uint8Array(44 + n);
	const dv = new DataView(pkt.buffer);
	dv.setUint32(0, h.srcCid >>> 0, true);
	dv.setUint32(4, Math.floor(h.srcCid / 2 ** 32), true);
	dv.setUint32(8, h.dstCid >>> 0, true);
	dv.setUint32(12, Math.floor(h.dstCid / 2 ** 32), true);
	dv.setUint32(16, h.srcPort, true);
	dv.setUint32(20, h.dstPort, true);
	dv.setUint32(24, n, true);
	dv.setUint16(28, h.type, true);
	dv.setUint16(30, h.op, true);
	dv.setUint32(32, h.flags, true);
	dv.setUint32(36, h.bufAlloc, true);
	dv.setUint32(40, h.fwdCnt, true);
	if (payload) pkt.set(payload, 44);
	return pkt;
}
var VsockDevice = class {
	enabled;
	probed = false;
	guestCid = 0;
	rxMax = 0;
	onPacket;
	onInit;
	refuse;
	keep;
	onSave;
	hostBusy;
	stats = {
		fromGuest: 0,
		fromGuestBytes: 0,
		toGuest: 0,
		toGuestBytes: 0,
		refused: 0
	};
	#queue = [];
	#head = 0;
	#memory;
	#raise;
	#retry;
	#closed = false;
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
		this.onPacket = opts.onPacket;
		this.onInit = opts.onInit;
	}
	get queued() {
		return this.#queue.length - this.#head;
	}
	blocker() {
		if (this.queued) return "vsock packets";
		return this.hostBusy?.() ?? "";
	}
	deliver(pkt) {
		if (!this.enabled || this.#closed) return;
		this.#queue.push(pkt);
		this.#raise();
	}
	imports() {
		return {
			wasm_driver_vsock_init: (guestCid, rxMax) => {
				this.probed = true;
				if (!this.enabled) return -19;
				this.guestCid = guestCid >>> 0;
				this.rxMax = rxMax >>> 0;
				try {
					this.onInit?.(this.guestCid, this.rxMax);
				} catch {}
				return 0;
			},
			wasm_driver_vsock_send: (hdr, data, len) => {
				if (this.refuse?.()) {
					this.stats.refused++;
					this.#retry ??= setTimeout(() => {
						this.#retry = void 0;
						this.#raise();
					}, 0);
					return -11;
				}
				const n = len >>> 0;
				const u8 = new Uint8Array(this.#memory().buffer);
				const pkt = new Uint8Array(44 + n);
				pkt.set(u8.subarray(Number(hdr), Number(hdr) + 44));
				if (n) pkt.set(u8.subarray(Number(data), Number(data) + n), 44);
				this.stats.fromGuest++;
				this.stats.fromGuestBytes += pkt.length;
				this.onPacket?.(pkt);
				return 0;
			},
			wasm_driver_vsock_keep: (guestPort, hostPort) => this.keep?.has(`${guestPort >>> 0}:${hostPort >>> 0}`) ? 1 : 0,
			wasm_driver_vsock_rx_len: () => this.#head < this.#queue.length ? this.#queue[this.#head].length : 0,
			wasm_driver_vsock_recv: (buf, max) => {
				if (this.#head >= this.#queue.length) return 0;
				const pkt = this.#queue[this.#head];
				this.#queue[this.#head++] = void 0;
				if (this.#head > 64 && this.#head * 2 > this.#queue.length) {
					this.#queue = this.#queue.slice(this.#head);
					this.#head = 0;
				}
				if (buf) {
					new Uint8Array(this.#memory().buffer).set(pkt.subarray(0, max >>> 0), Number(buf));
					this.stats.toGuest++;
					this.stats.toGuestBytes += pkt.length;
				}
				return pkt.length;
			}
		};
	}
	saveState() {
		const mounts = this.onSave?.();
		return {
			guestCid: this.guestCid,
			rxMax: this.rxMax,
			...mounts ? { mounts } : {}
		};
	}
	restoreState(s) {
		this.probed = true;
		this.guestCid = s.guestCid >>> 0;
		this.rxMax = s.rxMax >>> 0;
		try {
			this.onInit?.(this.guestCid, this.rxMax);
		} catch {}
	}
	close() {
		this.#closed = true;
		this.#queue = [];
		this.#head = 0;
		clearTimeout(this.#retry);
		this.#retry = void 0;
	}
};
function saveVsockConnection(c) {
	return c instanceof Connection$1 ? c.saveState() : "not a connection of this host";
}
var VsockError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "VsockError";
		this.code = code;
	}
};
var Connection$1 = class {
	localPort;
	remotePort;
	readable;
	writable;
	closed;
	state;
	#rx = [];
	#rxBytes = 0;
	#rxCnt = 0;
	#fwdCnt = 0;
	#sentFwd = 0;
	#rc;
	#wantRead = false;
	#readDone = false;
	#readCancelled = false;
	#peerShutSend = false;
	#peerBufAlloc = 0;
	#peerFwdCnt = 0;
	#txCnt = 0;
	#tx = [];
	#peerShutRcv = false;
	#shutSent = 0;
	#closeWanted = false;
	#creditAsked = false;
	#creditTimer;
	#resetErr;
	#closeTimer;
	#resolveClosed;
	#host;
	#encoder;
	onEstablished;
	constructor(host, localPort, remotePort, state) {
		this.#host = host;
		this.localPort = localPort;
		this.remotePort = remotePort;
		this.state = state;
		this.closed = new Promise((r) => this.#resolveClosed = r);
		this.readable = new ReadableStream({
			start: (c) => {
				this.#rc = c;
			},
			pull: () => {
				this.#wantRead = true;
				this.#pump();
			},
			cancel: () => {
				this.#readCancelled = true;
				this.#readDone = true;
				this.#consume(this.#rxBytes);
				this.#rx = [];
				this.#rxBytes = 0;
				this.#shutdown(1);
			}
		}, { highWaterMark: 0 });
		this.writable = new WritableStream({
			write: (chunk) => this.#write(typeof chunk === "string" ? (this.#encoder ??= new TextEncoder()).encode(chunk) : chunk),
			close: () => this.#shutdown(2),
			abort: () => this.reset()
		});
	}
	get key() {
		return `${this.localPort}:${this.remotePort}`;
	}
	saveState() {
		if (this.state !== "established") return `the connection is ${this.state}`;
		if (this.#rx.length || this.#tx.length) return "data on the way";
		if (this.#shutSent || this.#peerShutSend || this.#peerShutRcv || this.#closeWanted) return "a shutdown on the way";
		return {
			localPort: this.localPort,
			remotePort: this.remotePort,
			rxCnt: this.#rxCnt,
			fwdCnt: this.#fwdCnt,
			sentFwd: this.#sentFwd,
			peerBufAlloc: this.#peerBufAlloc,
			peerFwdCnt: this.#peerFwdCnt,
			txCnt: this.#txCnt
		};
	}
	loadState(s) {
		this.#rxCnt = s.rxCnt >>> 0;
		this.#fwdCnt = s.fwdCnt >>> 0;
		this.#sentFwd = s.sentFwd >>> 0;
		this.#peerBufAlloc = s.peerBufAlloc >>> 0;
		this.#peerFwdCnt = s.peerFwdCnt >>> 0;
		this.#txCnt = s.txCnt >>> 0;
	}
	header(op, flags = 0) {
		this.#sentFwd = this.#fwdCnt;
		return {
			srcCid: 2,
			dstCid: this.#host.guestCid,
			srcPort: this.localPort,
			dstPort: this.remotePort,
			type: 1,
			op,
			flags,
			bufAlloc: this.#host.bufferSize,
			fwdCnt: this.#fwdCnt
		};
	}
	#send(op, flags = 0, payload) {
		this.#host.sendPacket(encodeVsockPacket(this.header(op, flags), payload));
	}
	receive(h, pkt) {
		const before = this.#credit();
		this.#peerBufAlloc = h.bufAlloc;
		this.#peerFwdCnt = h.fwdCnt;
		switch (h.op) {
			case 2:
				if (this.state === "connecting") {
					this.state = "established";
					this.onEstablished?.();
					this.onEstablished = void 0;
				} else this.#violation("an unexpected RESPONSE");
				break;
			case 5:
				if (h.len) this.#data(pkt.subarray(44, 44 + h.len));
				break;
			case 4:
				if (h.flags & 2) {
					this.#peerShutSend = true;
					this.#pump();
				}
				if (h.flags & 1 && !this.#peerShutRcv) {
					this.#peerShutRcv = true;
					this.#failWrites(new VsockError("EPIPE", "the guest shut down its receiving side"));
				}
				if (this.#peerShutSend && this.#peerShutRcv) {
					this.#send(3);
					this.#end(false);
				}
				break;
			case 3:
				if (this.state === "connecting") {
					this.onEstablished?.(new VsockError("ECONNREFUSED", `vsock connect to port ${this.remotePort}: refused by the guest`));
					this.onEstablished = void 0;
					this.#end(true, true);
				} else this.#end(!(this.#peerShutSend && this.#shutSent & 2 || this.state === "closing"), true);
				return;
			case 7:
				this.#send(6);
				break;
			case 6: break;
			default:
				this.#violation(`op ${h.op}`);
				return;
		}
		if (this.#credit() > before) this.#stallDone();
		this.#flush();
	}
	#credit() {
		return this.#peerBufAlloc - (this.#txCnt - this.#peerFwdCnt >>> 0);
	}
	#stallDone() {
		this.#creditAsked = false;
		clearTimeout(this.#creditTimer);
		this.#creditTimer = void 0;
	}
	#violation(what) {
		this.#host.stats.violations++;
		this.#host.log(`[vsock] port ${this.localPort}<-${this.remotePort}: ${what}; resetting`);
		this.reset();
	}
	#data(bytes) {
		if (this.state !== "established" && this.state !== "closing") return;
		if (this.#rxBytes + bytes.length > this.#host.bufferSize) {
			this.#violation(`${bytes.length} bytes beyond the credit given`);
			return;
		}
		this.#rxCnt = this.#rxCnt + bytes.length >>> 0;
		this.#host.stats.bytesIn += bytes.length;
		if (this.#readCancelled || this.#readDone) {
			this.#consume(bytes.length);
			return;
		}
		this.#rx.push(bytes.slice());
		this.#rxBytes += bytes.length;
		this.#pump();
	}
	#pump() {
		if (this.#readDone || !this.#wantRead) return;
		const chunk = this.#rx.shift();
		if (chunk) {
			this.#wantRead = false;
			this.#rxBytes -= chunk.length;
			this.#rc.enqueue(chunk);
			this.#consume(chunk.length);
			return;
		}
		if (this.#peerShutSend || this.state === "closed") {
			this.#readDone = true;
			if (this.#resetErr && !this.#peerShutSend) this.#rc.error(this.#resetErr);
			else this.#rc.close();
			this.#maybeFinish();
		}
	}
	#consume(n) {
		this.#fwdCnt = this.#fwdCnt + n >>> 0;
		if (this.state !== "established") return;
		const buf = Math.min(this.#host.bufferSize, this.#peerBufAlloc || this.#host.bufferSize);
		if (buf - (this.#rxCnt - this.#sentFwd >>> 0) < buf / 2 && this.#fwdCnt !== this.#sentFwd) this.#send(6);
	}
	#write(data) {
		if (this.#resetErr) return Promise.reject(this.#resetErr);
		if (this.#peerShutRcv) return Promise.reject(new VsockError("EPIPE", "the guest shut down its receiving side"));
		if (this.state === "closed" || this.#shutSent & 2 || this.#closeWanted) return Promise.reject(new VsockError("EPIPE", "the connection is closed"));
		if (!data.length) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.#tx.push({
				data: data.slice(),
				at: 0,
				resolve,
				reject
			});
			this.#flush();
		});
	}
	#flush() {
		if (this.state !== "established") return;
		while (this.#tx.length) {
			const credit = this.#credit();
			if (credit <= 0) {
				if (!this.#creditAsked) {
					this.#creditAsked = true;
					this.#send(7);
					this.#creditTimer = setTimeout(() => {
						this.#creditAsked = false;
						this.#creditTimer = void 0;
						this.#flush();
					}, CREDIT_RETRY_MS);
				}
				return;
			}
			const item = this.#tx[0];
			const n = Math.min(credit, this.#host.maxPayload, item.data.length - item.at);
			this.#send(5, 0, item.data.subarray(item.at, item.at + n));
			this.#txCnt = this.#txCnt + n >>> 0;
			this.#host.stats.bytesOut += n;
			item.at += n;
			if (item.at === item.data.length) {
				this.#tx.shift();
				item.resolve();
			}
		}
		if (this.#closeWanted) this.#shutdown(3);
	}
	#failWrites(e) {
		const tx = this.#tx;
		this.#tx = [];
		for (const t of tx) t.reject(e);
	}
	#shutdown(flags) {
		if (this.state === "closed") return;
		if (this.state === "connecting") {
			this.reset();
			return;
		}
		if (flags & 2 && this.#tx.length) {
			this.#closeWanted = true;
			return;
		}
		const add = flags & ~this.#shutSent;
		if (!add) return;
		this.#shutSent |= add;
		this.#send(4, this.#shutSent);
		this.#maybeFinish();
	}
	#maybeFinish() {
		if (this.state !== "established") return;
		if (!(this.#shutSent & 2) && !this.#peerShutRcv || !this.#readDone) return;
		if (this.#shutSent !== 3) {
			this.#shutSent = 3;
			this.#send(4, this.#shutSent);
		}
		this.state = "closing";
		this.#closeTimer = setTimeout(() => {
			if (this.state === "closing") this.reset();
		}, CLOSE_TIMEOUT_MS);
	}
	close() {
		if (this.state === "closed") return;
		if (!this.#readDone) {
			this.#readDone = true;
			this.#readCancelled = true;
			this.#consume(this.#rxBytes);
			this.#rx = [];
			this.#rxBytes = 0;
			try {
				this.#rc.close();
			} catch {}
		}
		this.#closeWanted = true;
		this.#flush();
		if (!this.#tx.length) this.#shutdown(3);
	}
	reset() {
		if (this.state === "closed") return;
		this.#send(3);
		if (this.state === "connecting") {
			this.onEstablished?.(new VsockError("ECONNABORTED", "connect aborted"));
			this.onEstablished = void 0;
		}
		this.#end(true);
	}
	abort() {
		if (this.state === "closed") return;
		if (this.state === "connecting") {
			this.onEstablished?.(new VsockError("ECONNABORTED", "the kernel exited"));
			this.onEstablished = void 0;
		}
		this.#end(true, true, new VsockError("ECONNABORTED", "the kernel exited"));
	}
	#end(reset, byPeer = false, err) {
		if (this.state === "closed") return;
		const wasEstablished = this.state !== "connecting";
		this.state = "closed";
		clearTimeout(this.#closeTimer);
		this.#stallDone();
		this.#host.forget(this);
		if (reset && wasEstablished) this.#host.stats.resets++;
		if (reset) this.#resetErr = err ?? new VsockError("ECONNRESET", byPeer ? "the guest reset the connection" : "the connection was reset");
		this.#failWrites(this.#resetErr ?? new VsockError("EPIPE", "the connection is closed"));
		if (!this.#peerShutSend && !reset) this.#peerShutSend = true;
		if (reset && !byPeer) {
			this.#rx = [];
			this.#rxBytes = 0;
			if (!this.#readDone) {
				this.#readDone = true;
				try {
					this.#rc.error(this.#resetErr);
				} catch {}
			}
		} else this.#pump();
		try {
			this.writable.abort?.(this.#resetErr).catch(() => {});
		} catch {}
		this.#resolveClosed(reset ? "reset" : "closed");
	}
};
var Listener = class {
	port;
	#host;
	#queue = [];
	#waiters = [];
	#handler;
	closed = false;
	constructor(host, port, handler) {
		this.#host = host;
		this.port = port;
		this.#handler = handler;
	}
	get full() {
		return !this.#handler && !this.#waiters.length && this.#queue.length >= BACKLOG;
	}
	offer(conn) {
		if (this.#handler) {
			const h = this.#handler;
			queueMicrotask(() => {
				try {
					h(conn);
				} catch (e) {
					this.#host.log(`[vsock] listener on port ${this.port} threw: ${e?.stack ?? e}`);
				}
			});
			return;
		}
		const w = this.#waiters.shift();
		if (w) w(conn);
		else this.#queue.push(conn);
	}
	accept() {
		const c = this.#queue.shift();
		if (c) return Promise.resolve(c);
		if (this.closed) return Promise.resolve(null);
		return new Promise((r) => this.#waiters.push(r));
	}
	async *[Symbol.asyncIterator]() {
		for (;;) {
			const c = await this.accept();
			if (!c) return;
			yield c;
		}
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.#host.unlisten(this);
		for (const c of this.#queue) c.reset();
		this.#queue = [];
		for (const w of this.#waiters) w(null);
		this.#waiters = [];
	}
};
var VsockHost = class {
	guestCid = 3;
	bufferSize;
	maxPayload = 16384;
	stats = {
		open: 0,
		accepted: 0,
		connected: 0,
		refused: 0,
		resets: 0,
		bytesIn: 0,
		bytesOut: 0,
		violations: 0
	};
	log;
	#send;
	#conns = /* @__PURE__ */ new Map();
	#listeners = /* @__PURE__ */ new Map();
	#nextPort = FIRST_HOST_PORT;
	#down;
	constructor(opts) {
		this.#send = opts.send;
		this.bufferSize = Math.max(4096, Math.min(opts.bufferSize ?? 262144, 2147483647)) >>> 0;
		this.log = opts.log ?? (() => {});
	}
	deviceReady(guestCid, rxMax) {
		this.guestCid = guestCid;
		if (rxMax > 44) this.maxPayload = Math.min(rxMax - 44, 65536);
	}
	sendPacket(pkt) {
		if (!this.#down) this.#send(pkt);
	}
	forget(conn) {
		if (this.#conns.get(conn.key) === conn) {
			this.#conns.delete(conn.key);
			this.stats.open = this.#conns.size;
		}
	}
	unlisten(l) {
		if (this.#listeners.get(l.port) === l) this.#listeners.delete(l.port);
	}
	#check(port) {
		if (!Number.isInteger(port) || port < 0 || port >= 4294967295) throw new VsockError("EINVAL", `vsock port ${port}: not a port (0 to 2^32 - 2)`);
	}
	listen(port, onConnection) {
		this.#check(port);
		if (this.#down) throw new VsockError("ECONNABORTED", this.#down);
		if (this.#listeners.has(port)) throw new VsockError("EADDRINUSE", `vsock port ${port} is already listening`);
		const l = new Listener(this, port, onConnection);
		this.#listeners.set(port, l);
		return l;
	}
	connect(port, opts = {}) {
		this.#check(port);
		if (this.#down) return Promise.reject(new VsockError("ECONNABORTED", this.#down));
		let local = this.#nextPort;
		while (this.#listeners.has(local) || this.#conns.has(`${local}:${port}`)) local = local >= 4294967294 ? FIRST_HOST_PORT : local + 1;
		this.#nextPort = local >= 4294967294 ? FIRST_HOST_PORT : local + 1;
		const conn = new Connection$1(this, local, port, "connecting");
		this.#conns.set(conn.key, conn);
		this.stats.open = this.#conns.size;
		const timeout = opts.timeout ?? 1e4;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (conn.state !== "connecting") return;
				conn.onEstablished = void 0;
				conn.reset();
				reject(new VsockError("ETIMEDOUT", `vsock connect to port ${port}: no answer from the guest in ${timeout} ms`));
			}, timeout);
			conn.onEstablished = (err) => {
				clearTimeout(timer);
				if (err) {
					if (err.code === "ECONNREFUSED") this.stats.refused++;
					reject(err);
				} else {
					this.stats.connected++;
					resolve(conn);
				}
			};
			this.sendPacket(encodeVsockPacket(conn.header(1)));
		});
	}
	adopt(s) {
		if (this.#down) throw new VsockError("ECONNABORTED", this.#down);
		const c = new Connection$1(this, s.localPort >>> 0, s.remotePort >>> 0, "established");
		if (this.#conns.has(c.key)) throw new VsockError("EADDRINUSE", `vsock connection ${c.key} exists`);
		c.loadState(s);
		this.#conns.set(c.key, c);
		this.stats.open = this.#conns.size;
		return c;
	}
	#refuse(h) {
		if (h.op === 3) return;
		this.sendPacket(encodeVsockPacket({
			srcCid: 2,
			dstCid: h.srcCid,
			srcPort: h.dstPort,
			dstPort: h.srcPort,
			type: h.type,
			op: 3,
			flags: 0,
			bufAlloc: 0,
			fwdCnt: 0
		}));
	}
	receive(pkt) {
		if (this.#down || pkt.length < 44) return;
		const h = decodeVsockHeader(pkt);
		if (h.dstCid !== 2 || h.len !== pkt.length - 44) {
			this.stats.violations++;
			return;
		}
		if (h.type !== 1) {
			this.stats.violations++;
			this.#refuse(h);
			return;
		}
		const conn = this.#conns.get(`${h.dstPort}:${h.srcPort}`);
		if (conn) {
			if (h.op === 1) conn.reset();
			else conn.receive(h, pkt);
			return;
		}
		if (h.op !== 1) {
			this.#refuse(h);
			return;
		}
		const l = this.#listeners.get(h.dstPort);
		if (!l || l.full) {
			this.stats.refused++;
			this.#refuse(h);
			return;
		}
		const c = new Connection$1(this, h.dstPort, h.srcPort, "established");
		this.#conns.set(c.key, c);
		this.stats.open = this.#conns.size;
		this.stats.accepted++;
		c.receive({
			...h,
			op: 6
		}, pkt);
		this.sendPacket(encodeVsockPacket(c.header(2)));
		l.offer(c);
	}
	shutdown(reason = "the kernel exited") {
		if (this.#down) return;
		this.#down = reason;
		for (const c of [...this.#conns.values()]) c.abort();
		this.#conns.clear();
		this.stats.open = 0;
		for (const l of [...this.#listeners.values()]) l.close();
	}
};
const SHM_PAGE_SIZE = 4096;
const REQ_SIZE = 280;
const NAME_MAX = 255;
const OP_OPEN = 1;
const OP_CREATE = 2;
const OP_REFRESH = 3;
const OP_CHECK = 4;
const OP_CLOSE = 5;
const REFRESH_FORCE = 1;
const FLAG_WRITABLE = 1;
const FLAG_GUEST = 2;
const DEFAULT_TIMEOUT_MS$2 = 1e4;
const ERRNO_NAMES = {
	1: "EPERM",
	2: "ENOENT",
	5: "EIO",
	9: "EBADF",
	11: "EAGAIN",
	12: "ENOMEM",
	13: "EACCES",
	16: "EBUSY",
	17: "EEXIST",
	19: "ENODEV",
	20: "ENOTDIR",
	21: "EISDIR",
	22: "EINVAL",
	27: "EFBIG",
	28: "ENOSPC",
	30: "EROFS",
	36: "ENAMETOOLONG",
	40: "ELOOP",
	95: "EOPNOTSUPP"
};
var ShmError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "ShmError";
		this.code = code;
	}
};
function errnoError(errno, what) {
	const code = ERRNO_NAMES[errno] ?? `E${errno}`;
	return new ShmError(code, `${what}: ${code}`);
}
function toRuns(pages) {
	let n = 0;
	for (let i = 0; i < pages.length; i++) if (!i || pages[i] !== pages[i - 1] + 4096) n++;
	const runOff = new Float64Array(n), runAddr = new Uint32Array(n), runLen = new Float64Array(n);
	let r = -1;
	for (let i = 0; i < pages.length; i++) {
		if (!i || pages[i] !== pages[i - 1] + 4096) {
			r++;
			runOff[r] = i * SHM_PAGE_SIZE;
			runAddr[r] = pages[i];
		}
		runLen[r] = runLen[r] + SHM_PAGE_SIZE;
	}
	return {
		runOff,
		runAddr,
		runLen
	};
}
var ShmDevice = class {
	enabled;
	driver;
	probed = false;
	onAttach;
	onDetach;
	stats = {
		requests: 0,
		failed: 0,
		attaches: 0,
		detaches: 0,
		exports: 0,
		bytesRead: 0,
		bytesWritten: 0
	};
	#recs = /* @__PURE__ */ new Map();
	#queue = [];
	#pending = /* @__PURE__ */ new Map();
	#nextTag = 1;
	#memory;
	#raise;
	#closed = false;
	#encoder = new TextEncoder();
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.driver = opts.driver ?? true;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
	}
	imports() {
		return {
			wasm_driver_shm_init: (reqSize) => {
				this.probed = true;
				if (!this.enabled) return -19;
				if (reqSize >>> 0 !== REQ_SIZE) return -22;
				return 0;
			},
			wasm_driver_shm_request: (buf, max) => {
				const req = this.#queue.shift();
				if (!req) return 0;
				const n = Math.min(req.length, max >>> 0);
				new Uint8Array(this.#memory().buffer).set(req.subarray(0, n), Number(buf));
				return n;
			},
			wasm_driver_shm_attach: (id, flags, gen, size, pages, npages) => {
				const n = npages >>> 0;
				const list = n ? new Uint32Array(this.#memory().buffer, Number(pages), n).slice() : /* @__PURE__ */ new Uint32Array(0);
				const info = {
					id: id >>> 0,
					size: Number(size),
					pages: n,
					generation: gen >>> 0,
					writable: !!(flags & FLAG_WRITABLE),
					guest: !!(flags & FLAG_GUEST)
				};
				if (!this.#recs.has(info.id)) this.stats.exports++;
				this.#recs.set(info.id, {
					info,
					...toRuns(list)
				});
				this.stats.attaches++;
				try {
					this.onAttach?.({ ...info });
				} catch {}
			},
			wasm_driver_shm_detach: (id) => {
				if (!this.#recs.delete(id >>> 0)) return;
				this.stats.exports--;
				this.stats.detaches++;
				try {
					this.onDetach?.(id >>> 0);
				} catch {}
			},
			wasm_driver_shm_reply: (tag, result) => {
				const p = this.#pending.get(tag >>> 0);
				if (!p) return;
				this.#pending.delete(tag >>> 0);
				clearTimeout(p.timer);
				if (result < 0) {
					this.stats.failed++;
					p.reject(errnoError(-result, p.what));
				} else p.resolve(result);
			}
		};
	}
	get busy() {
		return this.#queue.length + this.#pending.size;
	}
	saveState() {
		return {
			exports: [...this.#recs.values()].map((r) => ({
				info: { ...r.info },
				runOff: [...r.runOff],
				runAddr: [...r.runAddr],
				runLen: [...r.runLen]
			})),
			nextTag: this.#nextTag
		};
	}
	restoreState(s) {
		this.probed = true;
		this.#recs.clear();
		for (const e of s.exports) this.#recs.set(e.info.id, {
			info: { ...e.info },
			runOff: Float64Array.from(e.runOff),
			runAddr: Uint32Array.from(e.runAddr),
			runLen: Float64Array.from(e.runLen)
		});
		this.stats.exports = this.#recs.size;
		this.#nextTag = s.nextTag || 1;
	}
	info(id) {
		const r = this.#recs.get(id);
		return r && { ...r.info };
	}
	request(op, what, f) {
		if (this.#closed) return Promise.reject(new ShmError("ECONNABORTED", `${what}: the kernel exited`));
		if (!this.enabled || !this.driver) return Promise.reject(new ShmError("ENODEV", `${what}: the kernel has no kwshm`));
		const req = new Uint8Array(REQ_SIZE);
		const dv = new DataView(req.buffer);
		if (f.name !== void 0) {
			const name = this.#encoder.encode(f.name);
			if (name.length > NAME_MAX) return Promise.reject(new ShmError("ENAMETOOLONG", `${what}: name longer than ${NAME_MAX} bytes`));
			if (name.includes(0)) return Promise.reject(new ShmError("EINVAL", `${what}: name contains NUL`));
			req.set(name, 24);
		}
		const tag = this.#nextTag;
		this.#nextTag = this.#nextTag % 4294967295 + 1;
		dv.setUint32(0, op, true);
		dv.setUint32(4, tag, true);
		dv.setUint32(8, f.id ?? 0, true);
		dv.setUint32(12, f.flags ?? 0, true);
		dv.setBigUint64(16, BigInt(f.size ?? 0), true);
		this.stats.requests++;
		return new Promise((resolve, reject) => {
			const timeout = f.timeout ?? DEFAULT_TIMEOUT_MS$2;
			const timer = timeout > 0 && Number.isFinite(timeout) ? setTimeout(() => {
				this.#pending.delete(tag);
				const i = this.#queue.indexOf(req);
				if (i >= 0) this.#queue.splice(i, 1);
				reject(new ShmError("ETIMEDOUT", `${what}: no answer from the kernel within ${timeout} ms`));
			}, timeout) : void 0;
			this.#pending.set(tag, {
				resolve,
				reject,
				timer,
				what
			});
			this.#queue.push(req);
			this.#raise();
		});
	}
	#rec(id, what) {
		const r = this.#recs.get(id);
		if (!r) throw new ShmError("ENOENT", `${what}: no export ${id}`);
		return r;
	}
	#check(r, offset, length, what) {
		if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > r.info.size) throw new ShmError("EINVAL", `${what}: ${offset}+${length} is outside export ${r.info.id} (${r.info.size} bytes)`);
	}
	#each(r, offset, length, fn) {
		const off = r.runOff;
		let lo = 0, hi = off.length - 1;
		while (lo < hi) {
			const mid = lo + hi + 1 >> 1;
			if (off[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		for (let i = lo, pos = 0; pos < length; i++) {
			const inRun = offset + pos - off[i];
			const n = Math.min(r.runLen[i] - inRun, length - pos);
			fn(r.runAddr[i] + inRun, pos, n);
			pos += n;
		}
	}
	read(id, offset, length, out) {
		const r = this.#rec(id, "read");
		this.#check(r, offset, length, "read");
		const dst = out ?? new Uint8Array(length);
		if (dst.length < length) throw new ShmError("EINVAL", `read: the buffer is smaller than ${length} bytes`);
		const mem = new Uint8Array(this.#memory().buffer);
		this.#each(r, offset, length, (a, pos, n) => dst.set(mem.subarray(a, a + n), pos));
		this.stats.bytesRead += length;
		return dst;
	}
	write(id, offset, data) {
		const r = this.#rec(id, "write");
		if (!r.info.writable) throw new ShmError("EACCES", `write: export ${id} is read-only for the host`);
		this.#check(r, offset, data.length, "write");
		const mem = new Uint8Array(this.#memory().buffer);
		this.#each(r, offset, data.length, (a, pos, n) => mem.set(data.subarray(pos, pos + n), a));
		this.stats.bytesWritten += data.length;
	}
	views(id, offset, length) {
		const r = this.#rec(id, "views");
		this.#check(r, offset, length, "views");
		const buf = this.#memory().buffer;
		const out = [];
		this.#each(r, offset, length, (a, _pos, n) => out.push(new Uint8Array(buf, a, n)));
		return out;
	}
	async run(call) {
		switch (call.op) {
			case "open":
			case "create": {
				const create = call.op === "create";
				if (create && (!Number.isSafeInteger(call.size) || call.size < 0)) throw new ShmError("EINVAL", `create: bad size ${call.size}`);
				const id = await this.request(create ? OP_CREATE : OP_OPEN, `${call.op} ${JSON.stringify(call.name)}`, {
					name: call.name,
					timeout: call.timeout,
					size: create ? call.size : 0,
					flags: create ? (call.mode ?? 384) & 511 : 0
				});
				return this.#infoOr(id, call.op);
			}
			case "openId": return this.#infoOr(call.id, "openId");
			case "refresh":
				this.#rec(call.id, "refresh");
				await this.request(OP_REFRESH, `refresh ${call.id}`, {
					id: call.id,
					flags: call.force ? REFRESH_FORCE : 0,
					timeout: call.timeout
				});
				return this.#infoOr(call.id, "refresh");
			case "check":
				this.#rec(call.id, "isStale");
				return await this.request(OP_CHECK, `isStale ${call.id}`, {
					id: call.id,
					timeout: call.timeout
				}) === 1;
			case "close":
				if (!this.#recs.has(call.id)) return void 0;
				await this.request(OP_CLOSE, `close ${call.id}`, {
					id: call.id,
					timeout: call.timeout
				});
				return;
			case "read": return this.read(call.id, call.offset, call.length);
			case "write":
				this.write(call.id, call.offset, call.data);
				return;
		}
	}
	#infoOr(id, what) {
		const info = this.info(id);
		if (!info) throw new ShmError("ENOENT", `${what}: no export ${id}`);
		return info;
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.reject(new ShmError("ECONNABORTED", `${p.what}: the kernel exited`));
		}
		this.#pending.clear();
		this.#queue = [];
		this.#recs.clear();
		this.stats.exports = 0;
	}
};
var Handle = class {
	id;
	name;
	origin;
	closed;
	info;
	done;
	closing = false;
	#client;
	#resolve;
	constructor(client, info, name) {
		this.#client = client;
		this.id = info.id;
		this.info = info;
		this.name = name;
		this.origin = info.guest ? "guest" : "host";
		this.closed = new Promise((r) => this.#resolve = r);
	}
	get size() {
		return this.info.size;
	}
	get pages() {
		return this.info.pages;
	}
	get writable() {
		return this.info.writable;
	}
	get generation() {
		return this.info.generation;
	}
	end(reason) {
		if (this.done) return;
		this.done = reason;
		this.#client.forget(this);
		this.#resolve(reason);
	}
	#live(what) {
		if (this.done) throw new ShmError("EBADF", `${what}: the handle is closed (${this.done})`);
	}
	async read(offset = 0, length) {
		this.#live("read");
		const n = length ?? Math.max(0, this.info.size - offset);
		const data = await this.#client.backend.run({
			op: "read",
			id: this.id,
			offset,
			length: n
		});
		this.#client.count(true, data.length);
		return data;
	}
	async write(offset, data) {
		this.#live("write");
		await this.#client.backend.run({
			op: "write",
			id: this.id,
			offset,
			data
		});
		this.#client.count(false, data.length);
	}
	async refresh(opts = {}) {
		this.#live("refresh");
		const gen = this.info.generation;
		const info = await this.#client.backend.run({
			op: "refresh",
			id: this.id,
			force: opts.force,
			timeout: opts.timeout
		});
		this.#client.update(info);
		return info.generation !== gen;
	}
	async isStale(opts = {}) {
		this.#live("isStale");
		return await this.#client.backend.run({
			op: "check",
			id: this.id,
			timeout: opts.timeout
		});
	}
	async close() {
		if (this.done) return;
		if (this.origin === "host") {
			this.closing = true;
			try {
				await this.#client.backend.run({
					op: "close",
					id: this.id
				});
			} finally {
				this.closing = false;
			}
		}
		this.end("closed");
	}
	views(offset = 0, length) {
		this.#live("views");
		const v = this.#client.backend.views;
		if (!v) throw new ShmError("EOPNOTSUPP", "views: zero-copy views exist only inline (the kernel's memory is in the worker)");
		return v(this.id, offset, length ?? Math.max(0, this.info.size - offset));
	}
};
var ShmClient = class {
	backend;
	#handles = /* @__PURE__ */ new Map();
	#exited = false;
	#stats = {
		open: 0,
		reads: 0,
		bytesRead: 0,
		writes: 0,
		bytesWritten: 0
	};
	constructor(backend) {
		this.backend = backend;
	}
	get stats() {
		return { ...this.#stats };
	}
	async open(name, opts = {}) {
		return this.#add(await this.backend.run({
			op: "open",
			name,
			timeout: opts.timeout
		}), name);
	}
	async create(name, size, opts = {}) {
		return this.#add(await this.backend.run({
			op: "create",
			name,
			size,
			mode: opts.mode,
			timeout: opts.timeout
		}), name);
	}
	async openId(id) {
		return this.#add(await this.backend.run({
			op: "openId",
			id
		}), void 0);
	}
	#add(info, name) {
		if (this.#exited) throw new ShmError("ECONNABORTED", "the kernel exited");
		const h = new Handle(this, info, name);
		let set = this.#handles.get(info.id);
		if (!set) this.#handles.set(info.id, set = /* @__PURE__ */ new Set());
		set.add(h);
		this.#stats.open++;
		return h;
	}
	forget(h) {
		const set = this.#handles.get(h.id);
		if (set?.delete(h)) this.#stats.open--;
		if (set && !set.size) this.#handles.delete(h.id);
	}
	count(read, bytes) {
		if (read) {
			this.#stats.reads++;
			this.#stats.bytesRead += bytes;
		} else {
			this.#stats.writes++;
			this.#stats.bytesWritten += bytes;
		}
	}
	update(info) {
		for (const h of this.#handles.get(info.id) ?? []) if (info.generation >= h.info.generation) h.info = { ...info };
	}
	detached(id) {
		for (const h of [...this.#handles.get(id) ?? []]) h.end(h.closing ? "closed" : "released");
	}
	shutdown() {
		this.#exited = true;
		for (const set of [...this.#handles.values()]) for (const h of [...set]) h.end("exit");
	}
};
function inlineShm(dev) {
	const client = new ShmClient({
		run: (call) => dev.run(call),
		views: (id, offset, length) => dev.views(id, offset, length)
	});
	dev.onAttach = (info) => client.update(info);
	dev.onDetach = (id) => client.detached(id);
	return client;
}
const TTY_PORT = 1022;
const TTY_VERSION = 1;
const TTY_MAX_WRITE = 4096;
const TTY_MAX_PAYLOAD = 65535;
const TTY_FEATURE_PIPES = 1;
const TTY_FEATURE_CONNECT = 2;
const TTY_SIGNALS = [
	"HUP",
	"INT",
	"QUIT",
	"ILL",
	"TRAP",
	"ABRT",
	"BUS",
	"FPE",
	"KILL",
	"USR1",
	"SEGV",
	"USR2",
	"PIPE",
	"ALRM",
	"TERM",
	"CHLD",
	"CONT",
	"STOP",
	"TSTP",
	"TTIN",
	"TTOU",
	"URG",
	"XCPU",
	"XFSZ",
	"VTALRM",
	"PROF",
	"WINCH",
	"IO",
	"PWR",
	"SYS"
];
const DEFAULT_TERM = "xterm-256color";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_TIMEOUT_MS$1 = 3e4;
const DEFAULT_MAX_BUFFER = 64 << 20;
const RETRY_MS$2 = 100;
const OPENED_SIZE = 14;
const EMPTY$2 = /* @__PURE__ */ new Uint8Array(0);
var PtyError = class extends Error {
	code;
	constructor(code, message, cause) {
		super(message, cause === void 0 ? void 0 : { cause });
		this.name = "PtyError";
		this.code = code;
	}
};
function u16(v, what) {
	const n = v ?? 0;
	if (!Number.isInteger(n) || n < 0 || n > 65535) throw new RangeError(`kwtty: ${what} ${v} is not an integer from 0 to 65535`);
	return n;
}
function encodeTtyFrame(type, payload = EMPTY$2, flags = 0) {
	const n = payload.length;
	if (n > 65535) throw new RangeError(`kwtty: a frame payload of ${n} bytes (at most ${TTY_MAX_PAYLOAD})`);
	const f = new Uint8Array(4 + n);
	f[0] = type;
	f[1] = flags;
	f[2] = n & 255;
	f[3] = n >> 8;
	f.set(payload, 4);
	return f;
}
function sizeBytes(s) {
	const b = /* @__PURE__ */ new Uint8Array(8);
	const dv = new DataView(b.buffer);
	dv.setUint16(0, u16(s.rows, "rows"), true);
	dv.setUint16(2, u16(s.cols, "cols"), true);
	dv.setUint16(4, u16(s.xpixel, "xpixel"), true);
	dv.setUint16(6, u16(s.ypixel, "ypixel"), true);
	return b;
}
function encodeTtyResize(s) {
	return sizeBytes(s);
}
function encodeTtyOpen(opts) {
	const enc = new TextEncoder();
	const parts = [];
	const head = /* @__PURE__ */ new Uint8Array(2);
	new DataView(head.buffer).setUint16(0, 1, true);
	parts.push(head, sizeBytes(opts));
	const opt = (tag, value) => {
		const h = /* @__PURE__ */ new Uint8Array(3);
		h[0] = tag;
		h[1] = value.length & 255;
		h[2] = value.length >> 8;
		parts.push(h, value);
	};
	const term = opts.term ?? (opts.pipes || opts.connect !== void 0 ? void 0 : DEFAULT_TERM);
	if (term !== void 0) {
		if (!/^[\x20-\x7e]{1,64}$/.test(term)) throw new RangeError(`kwtty: TERM ${JSON.stringify(term)} is not 1 to 64 printable ASCII characters`);
		opt(1, enc.encode(term));
	}
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		if (!k || k.includes("=") || k.includes("\0") || String(v).includes("\0")) throw new RangeError(`kwtty: environment variable ${JSON.stringify(k)}: a name must be non-empty without "=", and neither may contain NUL`);
		const kv = enc.encode(`${k}=${v}`);
		if (kv.length > 65535) throw new RangeError(`kwtty: environment variable ${k} is too long`);
		opt(2, kv);
	}
	if (opts.file !== void 0) {
		for (const a of [opts.file, ...opts.args ?? []]) {
			if (a.includes("\0")) throw new RangeError(`kwtty: argument ${JSON.stringify(a)} contains NUL`);
			opt(131, enc.encode(a));
		}
		if (!opts.file) throw new RangeError("kwtty: the program name is empty");
	} else if (opts.args?.length) throw new RangeError("kwtty: args without a program (file)");
	if (opts.cwd !== void 0) {
		if (!opts.cwd || opts.cwd.includes("\0")) throw new RangeError(`kwtty: cwd ${JSON.stringify(opts.cwd)} is empty or contains NUL`);
		opt(132, enc.encode(opts.cwd));
	}
	if (opts.pipes) opt(133, EMPTY$2);
	if (opts.connect !== void 0) {
		const port = opts.connect;
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`kwtty: TCP port ${port} is not an integer from 1 to 65535`);
		opt(134, Uint8Array.of(port & 255, port >> 8));
	}
	let n = 0;
	for (const p of parts) n += p.length;
	if (n > 65535) throw new RangeError(`kwtty: the OPEN frame would be ${n} bytes (at most ${TTY_MAX_PAYLOAD}); pass less environment`);
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) {
		out.set(p, n);
		n += p.length;
	}
	return out;
}
var TtyFrameParser = class {
	#chunks = [];
	#head = 0;
	#len = 0;
	#frames = [];
	get buffered() {
		return this.#len;
	}
	push(chunk) {
		if (!chunk.length) return;
		this.#chunks.push(chunk);
		this.#len += chunk.length;
		while (this.#len >= 4) {
			const h = this.#read(4, false);
			const n = h[2] | h[3] << 8;
			if (this.#len < 4 + n) break;
			this.#read(4, true);
			this.#frames.push({
				type: h[0],
				flags: h[1],
				payload: this.#read(n, true)
			});
		}
	}
	peek() {
		return this.#frames[0];
	}
	next() {
		return this.#frames.shift();
	}
	rest() {
		const parts = [];
		for (const f of this.#frames) parts.push(encodeTtyFrame(f.type, f.payload, f.flags));
		if (this.#len) parts.push(this.#read(this.#len, true));
		this.#frames = [];
		this.#chunks = [];
		this.#head = 0;
		this.#len = 0;
		let n = 0;
		for (const p of parts) n += p.length;
		if (parts.length === 1) return parts[0].slice();
		const out = new Uint8Array(n);
		n = 0;
		for (const p of parts) {
			out.set(p, n);
			n += p.length;
		}
		return out;
	}
	#read(n, consume) {
		if (!n) return EMPTY$2;
		const first = this.#chunks[0];
		let out;
		if (first.length - this.#head >= n) {
			out = first.subarray(this.#head, this.#head + n);
			if (consume) {
				this.#head += n;
				if (this.#head === first.length) {
					this.#chunks.shift();
					this.#head = 0;
				}
			}
		} else {
			out = new Uint8Array(n);
			let at = 0, i = 0, off = this.#head;
			while (at < n) {
				const c = this.#chunks[i];
				const k = Math.min(n - at, c.length - off);
				out.set(c.subarray(off, off + k), at);
				at += k;
				off += k;
				if (off === c.length) {
					i++;
					off = 0;
				}
			}
			if (consume) {
				this.#chunks.splice(0, i);
				this.#head = off;
			}
		}
		if (consume) this.#len -= n;
		return out;
	}
};
var Session$1 = class {
	pid;
	version;
	features;
	exitCode = null;
	ended;
	#conn;
	#reader;
	#writer;
	#parser;
	#outputs = /* @__PURE__ */ new Map();
	#resolve;
	#reject;
	#done = false;
	#running = false;
	#pumping = Promise.resolve();
	#encoder;
	constructor(conn, reader, writer, parser, opened) {
		this.#conn = conn;
		this.#reader = reader;
		this.#writer = writer;
		this.#parser = parser;
		this.pid = opened.pid;
		this.version = opened.version;
		this.features = opened.features;
		this.ended = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		this.ended.catch(() => {});
	}
	get done() {
		return this.#done;
	}
	stream(type) {
		let out;
		return new ReadableStream({
			start: (rc) => {
				out = {
					rc,
					discard: false,
					want: false
				};
				this.#outputs.set(type, out);
			},
			pull: () => {
				out.want = true;
				return this.#pull();
			},
			cancel: () => {
				out.discard = out.want = true;
				this.#pull();
			}
		}, { highWaterMark: 0 });
	}
	#pull() {
		if (!this.#running) {
			this.#running = true;
			this.#pumping = this.#pump();
		}
		return this.#pumping;
	}
	#wanted() {
		for (const o of this.#outputs.values()) if (o.want) return true;
		return false;
	}
	async #pump() {
		try {
			for (;;) {
				let queued = false;
				for (let f = this.#parser.peek(); f && !this.#done; f = this.#parser.peek()) {
					const out = this.#outputs.get(f.type);
					if (out) {
						this.#parser.next();
						if (f.payload.length && !out.discard) {
							out.rc.enqueue(f.payload);
							out.want = false;
							queued = true;
						}
						continue;
					}
					if (queued && !this.#wanted()) break;
					this.#parser.next();
					this.#frame(f);
				}
				if (this.#done || !this.#wanted()) break;
				let r;
				try {
					r = await this.#reader.read();
				} catch {
					this.#finish({ type: "lost" });
					break;
				}
				if (this.#done) break;
				if (r.done) {
					this.#finish({ type: "lost" });
					break;
				}
				this.#parser.push(r.value);
			}
		} catch (e) {
			this.#finish(new PtyError("EPROTO", `kwtty: ${e?.message ?? e}`, e));
		}
		this.#running = false;
	}
	#frame(f) {
		switch (f.type) {
			case 4: {
				if (f.payload.length < 3) throw new Error(`an EXIT frame of ${f.payload.length} bytes`);
				const [how, code, core] = f.payload;
				if (how === 0) this.#finish({
					type: "exit",
					code
				});
				else if (how === 1) this.#finish({
					type: "signal",
					signal: code,
					coreDumped: core === 1
				});
				else throw new Error(`EXIT with how ${how}`);
				return;
			}
			case 5:
				this.#finish(new PtyError("EREMOTE", `kwtty: ${new TextDecoder().decode(f.payload)}`));
				return;
			case 1: throw new Error("a second OPENED");
			default: if (f.flags & 1) throw new Error(`an unknown critical frame (type ${f.type})`);
		}
	}
	#finish(end) {
		if (this.#done) return;
		this.#done = true;
		if (!(end instanceof PtyError) && end.type === "exit") this.exitCode = end.code;
		if (end instanceof PtyError) this.#reject(end);
		else this.#resolve(end);
		for (const o of this.#outputs.values()) try {
			if (end instanceof PtyError) o.rc.error(end);
			else o.rc.close();
		} catch {}
		this.#conn.close();
	}
	send(frame) {
		return this.#writer.write(frame).catch((e) => {
			throw new PtyError("EPIPE", `kwtty: ${this.#done ? "the session has ended" : "the connection failed"}`, e);
		});
	}
	sendData(data) {
		const bytes = typeof data === "string" ? (this.#encoder ??= new TextEncoder()).encode(data) : data;
		if (this.#done) return Promise.reject(new PtyError("EPIPE", "kwtty: the session has ended"));
		const sent = [];
		for (let i = 0; i < bytes.length; i += TTY_MAX_WRITE) sent.push(this.send(encodeTtyFrame(2, bytes.subarray(i, i + TTY_MAX_WRITE))));
		return Promise.all(sent).then(() => {});
	}
	sendSignal(signal) {
		const name = signal.startsWith("SIG") ? signal.slice(3) : signal;
		if (!TTY_SIGNALS.includes(name)) throw new RangeError(`kwtty: unknown signal ${JSON.stringify(signal)}`);
		if (!this.#done) this.send(encodeTtyFrame(6, new TextEncoder().encode(name), 1)).catch(() => {});
	}
	async close() {
		this.#finish({ type: "closed" });
		this.#conn.close();
		await this.#conn.closed;
	}
	[Symbol.asyncDispose]() {
		return this.close();
	}
};
var PtySession = class extends Session$1 {
	pts;
	cols;
	rows;
	output;
	constructor(conn, reader, writer, parser, opened, size) {
		super(conn, reader, writer, parser, opened);
		this.pts = opened.pts;
		this.cols = size.cols;
		this.rows = size.rows;
		this.output = this.stream(2);
	}
	write(data) {
		return this.sendData(data);
	}
	resize(cols, rows, xpixel, ypixel) {
		const frame = encodeTtyFrame(3, encodeTtyResize({
			cols,
			rows,
			xpixel,
			ypixel
		}));
		this.cols = cols;
		this.rows = rows;
		if (!this.done) this.send(frame).catch(() => {});
	}
	kill(signal = "SIGHUP") {
		this.sendSignal(signal);
	}
};
var PipeSession = class extends Session$1 {
	stdin;
	stdout;
	stderr;
	constructor(conn, reader, writer, parser, opened) {
		super(conn, reader, writer, parser, opened);
		this.stdout = this.stream(2);
		this.stderr = this.stream(8);
		const eof = () => this.done ? Promise.resolve() : this.send(encodeTtyFrame(7)).catch(() => {});
		this.stdin = new WritableStream({
			write: (chunk) => this.sendData(chunk),
			close: eof,
			abort: eof
		});
	}
	kill(signal = "SIGTERM") {
		this.sendSignal(signal);
	}
};
function guard(p, deadline, timedOut, signal, late) {
	return new Promise((resolve, reject) => {
		let over = false;
		const stop = () => {
			over = true;
			if (timer !== void 0) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			stop();
			reject(aborted());
		};
		const timer = deadline === 1e400 ? void 0 : setTimeout(() => {
			stop();
			reject(timedOut());
		}, Math.max(0, deadline - performance.now()));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort);
		p.then((v) => {
			if (over) late?.(v);
			else {
				stop();
				resolve(v);
			}
		}, (e) => {
			if (!over) {
				stop();
				reject(e);
			}
		});
	});
}
const aborted = () => new PtyError("ABORTED", "kwtty: aborted while opening the session");
const errCode = (e) => e?.code;
async function connectRetry(vsock, port, deadline, timedOut, signal) {
	for (;;) {
		if (signal?.aborted) throw aborted();
		const left = deadline - performance.now();
		if (left <= 0) throw timedOut();
		try {
			return await guard(vsock.connect(port, { timeout: Math.max(1, Math.ceil(left)) }), deadline, timedOut, signal, (c) => c.reset());
		} catch (e) {
			if (e instanceof PtyError) throw e;
			const code = errCode(e);
			if (code === "ECONNREFUSED") {
				const wait = Math.min(RETRY_MS$2, deadline - performance.now());
				if (wait > 0) await guard(new Promise((r) => setTimeout(r, wait)), 1e400, timedOut, signal);
				continue;
			}
			if (code === "ETIMEDOUT") throw timedOut();
			if (code === "ECONNABORTED") throw new PtyError("ECONNABORTED", "kwtty: the kernel exited", e);
			throw e;
		}
	}
}
async function readOpened(reader, parser) {
	for (;;) {
		for (let f = parser.next(); f; f = parser.next()) {
			if (f.type === 1) {
				if (f.payload.length < OPENED_SIZE) throw new PtyError("EPROTO", `kwtty: an OPENED frame of ${f.payload.length} bytes`);
				const dv = new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.length);
				const version = dv.getUint16(0, true);
				if (version < 1 || version > 1) throw new PtyError("EPROTO", `kwtty: the guest chose version ${version} (this client speaks 1 to 1)`);
				return {
					version,
					features: dv.getUint32(2, true),
					pid: dv.getUint32(6, true),
					pts: dv.getUint32(10, true)
				};
			}
			if (f.type === 5) throw new PtyError("EREMOTE", `kwtty: ${new TextDecoder().decode(f.payload)}`);
			if (f.type === 2 || f.type === 4 || f.flags & 1) throw new PtyError("EPROTO", `kwtty: frame type ${f.type} before OPENED`);
		}
		let r;
		try {
			r = await reader.read();
		} catch (e) {
			throw new PtyError("ECONNRESET", "kwtty: the connection was reset before OPENED", e);
		}
		if (r.done) throw new PtyError("ECONNRESET", "kwtty: the guest closed the connection before OPENED");
		parser.push(r.value);
	}
}
async function openSession(vsock, payload, opts) {
	const open = encodeTtyFrame(1, payload);
	const port = opts.port ?? 1022;
	const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS$1;
	const signal = opts.signal;
	const deadline = performance.now() + timeout;
	const timedOut = () => new PtyError("ETIMEDOUT", `kwtty: no terminal server on vsock port ${port} within ${timeout} ms (is /usr/bin/kwtty running in the guest?)`);
	const conn = await connectRetry(vsock, port, deadline, timedOut, signal);
	try {
		const reader = conn.readable.getReader();
		const writer = conn.writable.getWriter();
		const parser = new TtyFrameParser();
		writer.write(open).catch(() => {});
		const opened = readOpened(reader, parser);
		opened.catch(() => {});
		return {
			conn,
			reader,
			writer,
			parser,
			opened: await guard(opened, deadline, timedOut, signal)
		};
	} catch (e) {
		conn.reset();
		throw e;
	}
}
async function spawnPty(vsock, file, args = [], opts = {}) {
	const size = {
		cols: opts.cols ?? DEFAULT_COLS,
		rows: opts.rows ?? DEFAULT_ROWS,
		xpixel: opts.xpixel,
		ypixel: opts.ypixel
	};
	const s = await openSession(vsock, encodeTtyOpen({
		...opts,
		...size,
		file,
		args
	}), opts);
	return new PtySession(s.conn, s.reader, s.writer, s.parser, s.opened, size);
}
async function spawnSubprocess(vsock, file, args = [], opts = {}) {
	const s = await openSession(vsock, encodeTtyOpen({
		...opts,
		cols: 0,
		rows: 0,
		file,
		args,
		pipes: true
	}), opts);
	return new PipeSession(s.conn, s.reader, s.writer, s.parser, s.opened);
}
async function execSubprocess(vsock, file, args = [], opts = {}) {
	const { input, encoding = "utf8", maxBuffer = DEFAULT_MAX_BUFFER, ...spawnOpts } = opts;
	if (!file) throw new RangeError("kwtty: exec() needs a program (file)");
	const p = await spawnSubprocess(vsock, file, args, spawnOpts);
	const signal = opts.signal;
	let failure;
	const fail = (e) => {
		if (failure) return;
		failure = e;
		p.kill("KILL");
	};
	const onAbort = () => fail(new PtyError("ABORTED", "kwtty: exec() was aborted; the program got SIGKILL"));
	signal?.addEventListener("abort", onAbort);
	if (signal?.aborted) onAbort();
	const collect = async (stream, name) => {
		const reader = stream.getReader();
		const chunks = [];
		let n = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (failure) continue;
			n += value.length;
			if (n > maxBuffer) fail(new PtyError("ENOBUFS", `kwtty: ${name} went over maxBuffer (${maxBuffer} bytes); the program got SIGKILL`));
			else chunks.push(value);
		}
		const out = new Uint8Array(failure ? 0 : n);
		if (!failure) {
			let at = 0;
			for (const c of chunks) {
				out.set(c, at);
				at += c.length;
			}
		}
		return out;
	};
	const feed = async () => {
		const w = p.stdin.getWriter();
		if (input !== void 0 && input.length) await w.write(input).catch(() => {});
		await w.close().catch(() => {});
	};
	try {
		const [stdout, stderr] = await Promise.all([
			collect(p.stdout, "stdout"),
			collect(p.stderr, "stderr"),
			feed()
		]);
		const end = await p.ended;
		if (failure) throw failure;
		if (end.type === "exit" || end.type === "signal") {
			const decode = (b) => encoding === "buffer" ? b : new TextDecoder().decode(b);
			return {
				stdout: decode(stdout),
				stderr: decode(stderr),
				exitCode: end.type === "exit" ? end.code : null,
				signal: end.type === "signal" ? end.signal : null
			};
		}
		throw new PtyError("ECONNRESET", "kwtty: the session was lost before the program exited (did the kernel exit?)");
	} catch (e) {
		await p.close().catch(() => {});
		throw failure ?? e;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
async function connectGuest(vsock, port, opts = {}) {
	const payload = encodeTtyOpen({
		cols: 0,
		rows: 0,
		connect: port
	});
	let s;
	try {
		s = await openSession(vsock, payload, {
			port: opts.ttyPort,
			timeout: opts.timeout,
			signal: opts.signal
		});
	} catch (e) {
		if (e instanceof PtyError && e.code === "EREMOTE" && e.message.startsWith("kwtty: ECONNREFUSED:")) throw new PtyError("ECONNREFUSED", e.message);
		throw e;
	}
	const { conn, reader, writer, parser, opened } = s;
	if (!(opened.features & 2)) {
		conn.reset();
		throw new PtyError("EPROTO", "kwtty: the guest opened a session without the CONNECT feature");
	}
	let rest = parser.rest();
	if (!rest.length) rest = void 0;
	writer.releaseLock();
	const readable = new ReadableStream({
		pull: async (c) => {
			if (rest) {
				c.enqueue(rest);
				rest = void 0;
				return;
			}
			const r = await reader.read();
			if (r.done) c.close();
			else c.enqueue(r.value);
		},
		cancel: (reason) => reader.cancel(reason)
	}, { highWaterMark: 0 });
	const close = async () => {
		conn.close();
		await conn.closed;
	};
	return {
		port,
		readable,
		writable: conn.writable,
		closed: conn.closed,
		close,
		[Symbol.asyncDispose]: close
	};
}
const noDevice = (what) => new PtyError("ENODEV", `${what} needs the vsock device, which this instance has not: it was created with vsock: false (or vsock.raw)`);
function spawnOn(vsock, file, args, opts) {
	if (!vsock) return Promise.reject(noDevice("spawn()"));
	if (opts?.pty === false) {
		const { pty: _, ...rest } = opts;
		return spawnSubprocess(vsock, file, args, rest);
	}
	return spawnPty(vsock, file, args, opts);
}
function execOn(vsock, file, args, opts) {
	if (!vsock) return Promise.reject(noDevice("exec()"));
	return execSubprocess(vsock, file, args, opts);
}
function connectOn(vsock, port, opts) {
	if (!vsock) return Promise.reject(noDevice("connect()"));
	return connectGuest(vsock, port, opts);
}
const HTTP_MAX_HEADER_BYTES = 65536;
const MAX_CHUNK_LINE = 4096;
const NO_BODY_STATUS = /* @__PURE__ */ new Set([
	204,
	205,
	304
]);
const SKIP_REQUEST = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"content-length",
	"upgrade",
	"te",
	"trailer"
]);
const SKIP_RESPONSE = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"trailer",
	"upgrade"
]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REASON = /^[\t\x20-\x7e\x80-\xff]*$/;
const EMPTY$1 = /* @__PURE__ */ new Uint8Array(0);
const noop = () => {};
const malformed = (what) => /* @__PURE__ */ new TypeError(`fetchOver: malformed response: ${what}`);
function latin1(b) {
	let s = "";
	for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
	return s;
}
function latin1Bytes(s) {
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return b;
}
function concat$1(a, b) {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}
var Input = class {
	#reader;
	#buf = EMPTY$1;
	eof = false;
	lineBytes = 0;
	constructor(reader) {
		this.#reader = reader;
	}
	get buffered() {
		return this.#buf.length;
	}
	async more() {
		while (!this.eof) {
			const { done, value } = await this.#reader.read();
			if (done) {
				this.eof = true;
				break;
			}
			if (!value.length) continue;
			this.#buf = this.#buf.length ? concat$1(this.#buf, value) : value;
			return true;
		}
		return false;
	}
	take(n) {
		const b = this.#buf;
		if (n >= b.length) {
			this.#buf = EMPTY$1;
			return b;
		}
		this.#buf = b.subarray(n);
		return b.subarray(0, n);
	}
	async readLine(max) {
		let from = 0;
		for (;;) {
			const i = this.#buf.indexOf(10, from);
			if (i > max || i < 0 && this.#buf.length > max) throw new TypeError(`fetchOver: response header block over ${HTTP_MAX_HEADER_BYTES} bytes, or a line too long`);
			if (i >= 0) {
				const line = this.take(i + 1);
				this.lineBytes += line.length;
				const end = line.length >= 2 && line[line.length - 2] === 13 ? line.length - 2 : line.length - 1;
				return latin1(line.subarray(0, end));
			}
			from = this.#buf.length;
			if (!await this.more()) return null;
		}
	}
};
async function readHead(input) {
	const left = () => HTTP_MAX_HEADER_BYTES - input.lineBytes;
	let line = await input.readLine(left());
	while (line === "") line = await input.readLine(left());
	if (line === null) throw new TypeError("fetchOver: the connection closed before a response");
	const m = /^HTTP\/1\.[01] ([1-9]\d\d)(?: (.*))?$/.exec(line);
	if (!m) throw malformed(`status line ${JSON.stringify(line.slice(0, 80))}`);
	const status = Number(m[1]);
	const reason = m[2] ?? "";
	const head = {
		status,
		statusText: REASON.test(reason) ? reason : "",
		headers: []
	};
	for (;;) {
		line = await input.readLine(left());
		if (line === null) throw new TypeError("fetchOver: the connection closed inside the response headers");
		if (line === "") return head;
		const colon = line.indexOf(":");
		const name = colon > 0 ? line.slice(0, colon) : "";
		if (!TOKEN.test(name)) throw malformed(`header line ${JSON.stringify(line.slice(0, 80))}`);
		head.headers.push([name.toLowerCase(), line.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/g, "")]);
	}
}
function knownLength(body) {
	return typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams || typeof Blob !== "undefined" && body instanceof Blob || typeof FormData !== "undefined" && body instanceof FormData;
}
function framing(method, status, headers) {
	if (method === "HEAD" || NO_BODY_STATUS.has(status)) return { kind: "none" };
	const te = headers.filter(([n]) => n === "transfer-encoding").map(([, v]) => v).join(",");
	if (te) {
		const codings = te.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
		return codings[codings.length - 1] === "chunked" ? { kind: "chunked" } : { kind: "eof" };
	}
	const cl = headers.filter(([n]) => n === "content-length").flatMap(([, v]) => v.split(",").map((x) => x.trim()));
	if (cl.length) {
		if (!cl.every((v) => /^\d{1,15}$/.test(v) && v === cl[0])) throw malformed(`Content-Length ${JSON.stringify(cl.join(", "))}`);
		return {
			kind: "length",
			length: Number(cl[0])
		};
	}
	return { kind: "eof" };
}
function signalReason(signal) {
	return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}
async function fetchOver(connect, input, init) {
	const streaming = init?.body != null && !knownLength(init.body);
	const req = new Request(input, streaming && !("duplex" in init) ? {
		...init,
		duplex: "half"
	} : init);
	const url = new URL(req.url);
	if (url.protocol !== "http:") throw new TypeError(`fetchOver: only http: URLs are supported, not ${url.protocol}`);
	const port = url.port ? Number(url.port) : 80;
	const method = req.method;
	const signal = req.signal;
	if (signal.aborted) throw signalReason(signal);
	let bodyBytes = null;
	let bodyStream = null;
	if (req.body) {
		if (streaming) bodyStream = req.body;
		else bodyBytes = new Uint8Array(await req.arrayBuffer());
	}
	let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${req.headers.get("host") ?? url.host}\r\n`;
	for (const [name, value] of req.headers) {
		if (name === "host" || SKIP_REQUEST.has(name)) continue;
		head += `${name}: ${value}\r\n`;
	}
	if (!req.headers.has("accept-encoding")) head += "Accept-Encoding: identity\r\n";
	if (bodyStream) head += "Transfer-Encoding: chunked\r\n";
	else if (bodyBytes) head += `Content-Length: ${bodyBytes.length}\r\n`;
	else if (method === "POST" || method === "PUT" || method === "PATCH") head += "Content-Length: 0\r\n";
	head += "Connection: close\r\n\r\n";
	const headBytes = latin1Bytes(head);
	if (signal.aborted) throw signalReason(signal);
	let onConnectAbort = noop;
	const aborted = new Promise((_, reject) => {
		onConnectAbort = () => reject(signalReason(signal));
		signal.addEventListener("abort", onConnectAbort, { once: true });
	});
	const pending = connect(port, { signal });
	let duplex;
	try {
		duplex = await Promise.race([pending, aborted]);
	} catch (e) {
		pending.then((d) => {
			d.writable.abort(e).catch(noop);
			d.readable.cancel(e).catch(noop);
		}, noop);
		throw e;
	} finally {
		signal.removeEventListener("abort", onConnectAbort);
	}
	const writer = duplex.writable.getWriter();
	const reader = duplex.readable.getReader();
	const conn = new Input(reader);
	let failure;
	let finished = false;
	let uploadDone = false;
	let source;
	let failBody = noop;
	const finish = (error) => {
		if (finished) return;
		finished = true;
		signal.removeEventListener("abort", onAbort);
		source?.cancel(error).catch(noop);
		if (error === void 0 && uploadDone) writer.close().catch(noop);
		else writer.abort(error).catch(noop);
		reader.cancel(error).catch(noop);
	};
	const fail = (e) => {
		if (finished) return;
		failure ??= e;
		failBody(e);
		finish(e);
	};
	const onAbort = () => fail(signalReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	(async () => {
		try {
			if (bodyBytes && bodyBytes.length <= 65536) await writer.write(concat$1(headBytes, bodyBytes));
			else {
				await writer.write(headBytes);
				if (bodyBytes) await writer.write(bodyBytes);
			}
			if (bodyStream) {
				source = bodyStream.getReader();
				if (finished) source.cancel(failure).catch(noop);
				for (;;) {
					let r;
					try {
						r = await source.read();
					} catch (e) {
						fail(e);
						return;
					}
					if (r.done) break;
					if (!r.value.length) continue;
					const size = latin1Bytes(`${r.value.length.toString(16)}\r\n`);
					const frame = new Uint8Array(size.length + r.value.length + 2);
					frame.set(size);
					frame.set(r.value, size.length);
					frame.set([13, 10], frame.length - 2);
					await writer.write(frame);
				}
				await writer.write(latin1Bytes("0\r\n\r\n"));
			}
			uploadDone = true;
		} catch {}
	})();
	let res;
	let body;
	try {
		for (;;) {
			res = await readHead(conn);
			if (res.status === 101) throw new TypeError("fetchOver: 101 Switching Protocols (an upgrade) is not supported");
			if (res.status >= 200) break;
		}
		if (res.status > 599) throw malformed(`status ${res.status}`);
		body = framing(method, res.status, res.headers);
	} catch (e) {
		fail(e);
		throw failure;
	}
	if (finished) throw failure;
	const headers = new Headers();
	const connectionTokens = new Set(res.headers.filter(([n]) => n === "connection").flatMap(([, v]) => v.split(",").map((t) => t.trim().toLowerCase())));
	try {
		for (const [name, value] of res.headers) {
			if (SKIP_RESPONSE.has(name) || connectionTokens.has(name)) continue;
			if (name === "content-length" && body.kind !== "length") continue;
			headers.append(name, value);
		}
	} catch {
		const e = malformed("a header value Headers does not accept");
		fail(e);
		throw e;
	}
	if (body.kind === "none") {
		finish();
		return new Response(null, {
			status: res.status,
			statusText: res.statusText,
			headers
		});
	}
	let left = body.kind === "length" ? body.length : 0;
	let chunkState = "size";
	let controller;
	const truncated = () => /* @__PURE__ */ new TypeError("fetchOver: the connection closed before the end of the response body");
	const done = () => {
		finish();
		try {
			controller.close();
		} catch {}
	};
	const pull = async () => {
		for (;;) {
			if (finished) return;
			switch (body.kind) {
				case "eof":
					if (!conn.buffered && !await conn.more()) return done();
					return controller.enqueue(conn.take(1e400));
				case "length":
					if (!left) return done();
					if (!conn.buffered && !await conn.more()) throw truncated();
					{
						const piece = conn.take(left);
						left -= piece.length;
						controller.enqueue(piece);
					}
					if (!left) done();
					return;
				case "chunked":
					if (chunkState === "size") {
						const line = await conn.readLine(MAX_CHUNK_LINE);
						if (line === null) throw truncated();
						const m = /^([0-9a-fA-F]{1,13})[\t ]*(?:;.*)?$/.exec(line);
						if (!m) throw malformed(`chunk size line ${JSON.stringify(line.slice(0, 80))}`);
						left = parseInt(m[1], 16);
						chunkState = left ? "data" : "trailers";
						continue;
					}
					if (chunkState === "data") {
						if (!conn.buffered && !await conn.more()) throw truncated();
						const piece = conn.take(left);
						left -= piece.length;
						if (!left) chunkState = "crlf";
						return controller.enqueue(piece);
					}
					if (chunkState === "crlf") {
						const line = await conn.readLine(2);
						if (line === null) throw truncated();
						if (line !== "") throw malformed("no CRLF after a chunk");
						chunkState = "size";
						continue;
					}
					{
						const line = await conn.readLine(HTTP_MAX_HEADER_BYTES);
						if (line === null || line === "") return done();
						continue;
					}
			}
		}
	};
	const stream = new ReadableStream({
		start: (c) => {
			controller = c;
			failBody = (e) => {
				try {
					c.error(e);
				} catch {}
			};
		},
		pull: async () => {
			try {
				await pull();
			} catch (e) {
				fail(e);
			}
		},
		cancel: (reason) => {
			failBody = noop;
			finish(reason ?? new DOMException("The response body was cancelled", "AbortError"));
		}
	}, { highWaterMark: 0 });
	return new Response(stream, {
		status: res.status,
		statusText: res.statusText,
		headers
	});
}
const ERRNO$1 = {
	EPERM: 1,
	ENOENT: 2,
	EINTR: 4,
	EIO: 5,
	ENXIO: 6,
	E2BIG: 7,
	ENOEXEC: 8,
	EBADF: 9,
	EAGAIN: 11,
	EWOULDBLOCK: 11,
	ENOMEM: 12,
	EACCES: 13,
	EFAULT: 14,
	EBUSY: 16,
	EEXIST: 17,
	EXDEV: 18,
	ENODEV: 19,
	ENOTDIR: 20,
	EISDIR: 21,
	EINVAL: 22,
	ENFILE: 23,
	EMFILE: 24,
	ENOTTY: 25,
	ETXTBSY: 26,
	EFBIG: 27,
	ENOSPC: 28,
	ESPIPE: 29,
	EROFS: 30,
	EMLINK: 31,
	EPIPE: 32,
	ERANGE: 34,
	EDEADLK: 35,
	ENAMETOOLONG: 36,
	ENOLCK: 37,
	ENOSYS: 38,
	ENOTEMPTY: 39,
	ELOOP: 40,
	ENODATA: 61,
	EPROTO: 71,
	EOVERFLOW: 75,
	EILSEQ: 84,
	EOPNOTSUPP: 95,
	ENOTSUP: 95,
	ECONNABORTED: 103,
	ECONNRESET: 104,
	ENOTCONN: 107,
	ETIMEDOUT: 110,
	ESTALE: 116,
	EDQUOT: 122,
	ECANCELED: 125
};
var FsError = class extends Error {
	code;
	errno;
	constructor(code, message) {
		super(message === void 0 || message === code ? code : `${code}: ${message}`);
		this.name = "FsError";
		this.code = code;
		this.errno = ERRNO$1[code] ?? ERRNO$1.EIO;
	}
};
const MSIZE = 131072;
const DEFAULT_TIMEOUT = 3e4;
const P9_VERSION = "9P2000.L";
const HDR = 7;
const WINDOW = 16;
const QUEUE = 16;
const Rlerror = 7;
const Tstatfs = 8;
const Tlopen = 12;
const Tlcreate = 14;
const Tsymlink = 16;
const Tmknod = 18;
const Trename = 20;
const Treadlink = 22;
const Tgetattr = 24;
const Tsetattr = 26;
const Txattrwalk = 30;
const Txattrcreate = 32;
const Treaddir = 40;
const Tfsync = 50;
const Tlock = 52;
const Tgetlock = 54;
const Tlink = 70;
const Tmkdir = 72;
const Trenameat = 74;
const Tunlinkat = 76;
const Tversion = 100;
const Tauth = 102;
const Tattach = 104;
const Tflush = 108;
const Twalk = 110;
const Tread = 116;
const Twrite = 118;
const Tclunk = 120;
const Tremove = 122;
const QTDIR = 128;
const QTSYMLINK = 2;
const QTFILE = 0;
const S_IFDIR = 16384;
const S_IFREG = 32768;
const S_IFLNK = 40960;
const DT_DIR = 4;
const DT_REG = 8;
const DT_LNK = 10;
const AT_REMOVEDIR = 512;
const O_ACCMODE = 3;
const O_EXCL = 128;
const O_TRUNC = 512;
const O_APPEND = 1024;
const P9_STATS_BASIC = 2047;
const V9FS_MAGIC = 16914839;
function knownErrno(e) {
	if (e instanceof FsError) return e.errno;
	const code = e?.code;
	return typeof code === "string" && ERRNO$1[code] || 0;
}
function serve9p(vsock, log = () => {}) {
	return new Server(vsock, log);
}
const enc$2 = new TextEncoder();
const lenient = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });
var Writer = class {
	buf;
	dv;
	n = HDR;
	constructor(size = 64) {
		this.buf = new Uint8Array(Math.max(size, HDR));
		this.dv = new DataView(this.buf.buffer);
	}
	room(k) {
		if (this.n + k <= this.buf.length) return;
		const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
		b.set(this.buf.subarray(0, this.n));
		this.buf = b;
		this.dv = new DataView(b.buffer);
	}
	u8(v) {
		this.room(1);
		this.dv.setUint8(this.n, v);
		this.n += 1;
		return this;
	}
	u16(v) {
		this.room(2);
		this.dv.setUint16(this.n, v, true);
		this.n += 2;
		return this;
	}
	u32(v) {
		this.room(4);
		this.dv.setUint32(this.n, v >>> 0, true);
		this.n += 4;
		return this;
	}
	u64(v) {
		this.room(8);
		this.dv.setBigUint64(this.n, typeof v === "bigint" ? BigInt.asUintN(64, v) : BigInt(Math.max(0, Math.floor(v))), true);
		this.n += 8;
		return this;
	}
	str(s) {
		const b = enc$2.encode(s);
		this.u16(b.length);
		return this.bytes(b);
	}
	bytes(b) {
		this.room(b.length);
		this.buf.set(b, this.n);
		this.n += b.length;
		return this;
	}
	qid(q) {
		return this.u8(q.type).u32(q.version).u64(q.path);
	}
	finish(type, tag) {
		this.dv.setUint32(0, this.n, true);
		this.dv.setUint8(4, type);
		this.dv.setUint16(5, tag, true);
		return this.buf.subarray(0, this.n);
	}
};
var Reader$1 = class {
	at = HDR;
	dv;
	buf;
	constructor(buf) {
		this.buf = buf;
		this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	u8() {
		const v = this.dv.getUint8(this.at);
		this.at += 1;
		return v;
	}
	u16() {
		const v = this.dv.getUint16(this.at, true);
		this.at += 2;
		return v;
	}
	u32() {
		const v = this.dv.getUint32(this.at, true);
		this.at += 4;
		return v;
	}
	u64() {
		const v = this.dv.getBigUint64(this.at, true);
		this.at += 8;
		return Number(v);
	}
	str() {
		return lenient.decode(this.bytes(this.u16()));
	}
	name() {
		try {
			return strict.decode(this.bytes(this.u16()));
		} catch (e) {
			if (e instanceof FsError) throw e;
			throw new FsError("EILSEQ", "a name that is not UTF-8");
		}
	}
	bytes(n) {
		if (this.at + n > this.buf.length) throw new FsError("EPROTO", "a message shorter than its fields");
		const b = this.buf.subarray(this.at, this.at + n);
		this.at += n;
		return b;
	}
};
const typeOf = (frame) => frame[4];
const tagOf = (frame) => frame[5] | frame[6] << 8;
const errorReply = (tag, errno) => new Writer(11).u32(errno).finish(Rlerror, tag);
var P9FrameAssembler = class {
	#chunks = [];
	#head = 0;
	#len = 0;
	maxSize;
	constructor(maxSize) {
		this.maxSize = maxSize;
	}
	get buffered() {
		return this.#len;
	}
	push(chunk) {
		if (chunk.length) {
			this.#chunks.push(chunk);
			this.#len += chunk.length;
		}
	}
	next() {
		if (this.#len < 4) return void 0;
		let size = 0;
		for (let i = 0, c = 0, off = this.#head; i < 4;) {
			const chunk = this.#chunks[c];
			if (off >= chunk.length) {
				c++;
				off = 0;
				continue;
			}
			size |= chunk[off++] << 8 * i++;
		}
		size >>>= 0;
		if (size < HDR || size > this.maxSize) throw new Error(`a 9p message of ${size} bytes (at most ${this.maxSize})`);
		if (this.#len < size) return void 0;
		const first = this.#chunks[0];
		let out;
		if (first.length - this.#head >= size) {
			out = first.subarray(this.#head, this.#head + size);
			this.#head += size;
		} else {
			out = new Uint8Array(size);
			for (let at = 0; at < size;) {
				const c = this.#chunks[0];
				const k = Math.min(size - at, c.length - this.#head);
				out.set(c.subarray(this.#head, this.#head + k), at);
				at += k;
				this.#head += k;
				if (this.#head === c.length) {
					this.#chunks.shift();
					this.#head = 0;
				}
			}
		}
		if (this.#chunks.length && this.#head === this.#chunks[0].length) {
			this.#chunks.shift();
			this.#head = 0;
		}
		this.#len -= size;
		return out;
	}
};
function join(dir, name) {
	return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
function parent(path) {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "/" : path.slice(0, i);
}
function checkName$1(name) {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new FsError("EINVAL", `bad name ${JSON.stringify(name)}`);
	if (enc$2.encode(name).length > 255) throw new FsError("ENAMETOOLONG");
}
function under(path, prefix) {
	return prefix === "/" || path === prefix || path.startsWith(prefix) && path[prefix.length] === "/";
}
function inode(path, ino, dev) {
	if (ino !== void 0) return dev !== void 0 && dev !== 0 && dev !== 0n ? BigInt.asUintN(64, BigInt(dev) << 40n ^ BigInt(ino)) : ino;
	let a = 2166136261, b = 84696351;
	for (let i = 0; i < path.length; i++) {
		const c = path.charCodeAt(i);
		a = Math.imul(a ^ c, 16777619);
		b = Math.imul(b ^ c, 16777619) ^ b >>> 15;
	}
	return 1n << 63n | BigInt(a >>> 1 | 1073741824) << 32n | BigInt(b >>> 0);
}
const qidType = (t) => t === "dir" ? QTDIR : t === "symlink" ? QTSYMLINK : QTFILE;
function qidOf(path, a) {
	let version = a.version;
	if (version === void 0) version = (Math.floor((a.mtimeMs ?? 0) * 1e3) % 4294967296 ^ Math.imul((a.size ?? 0) % 4294967296, 2654435761)) >>> 0 || 1;
	return {
		type: qidType(a.type),
		version: version >>> 0,
		path: inode(path, a.ino, a.dev)
	};
}
const MSG_NAMES = {
	[Tstatfs]: "statfs",
	[Tlopen]: "lopen",
	[Tlcreate]: "lcreate",
	[Tsymlink]: "symlink",
	[Tmknod]: "mknod",
	[Trename]: "rename",
	[Treadlink]: "readlink",
	[Tgetattr]: "getattr",
	[Tsetattr]: "setattr",
	[Treaddir]: "readdir",
	[Tfsync]: "fsync",
	[Tlink]: "link",
	[Tmkdir]: "mkdir",
	[Trenameat]: "renameat",
	[Tunlinkat]: "unlinkat",
	[Tattach]: "attach",
	[Twalk]: "walk",
	[Tread]: "read",
	[Twrite]: "write",
	[Tclunk]: "clunk",
	[Tremove]: "remove"
};
const MUTATING = /* @__PURE__ */ new Set([
	Tlcreate,
	Tsymlink,
	Tmknod,
	Trename,
	Tsetattr,
	Txattrcreate,
	Tlink,
	Tmkdir,
	Trenameat,
	Tunlinkat,
	Twrite
]);
var Export = class {
	name;
	fs;
	readOnly;
	timeout;
	stats = {
		requests: 0,
		errors: 0,
		bytesRead: 0,
		bytesWritten: 0
	};
	conn;
	connected = false;
	onConnection;
	server;
	removed = false;
	constructor(server, name, fs, readOnly, timeout) {
		this.server = server;
		this.name = name;
		this.fs = fs;
		this.readOnly = readOnly;
		this.timeout = timeout;
	}
	opened(c, open) {
		if (open) this.conn = c;
		else if (this.conn !== c || !this.connected) return;
		this.connected = open;
		try {
			this.onConnection?.(open);
		} catch (e) {
			this.server.log(`[9p] ${this.name}: onConnection threw: ${e?.stack ?? e}`);
		}
	}
	remove() {
		if (this.removed) return;
		this.removed = true;
		this.onConnection = void 0;
		this.server.forget(this);
		if (this.connected) this.conn.reset();
	}
};
var Server = class {
	log;
	#listener;
	#exports = /* @__PURE__ */ new Map();
	#users = /* @__PURE__ */ new Map();
	#conns = /* @__PURE__ */ new Set();
	next = 1;
	#closed = false;
	constructor(vsock, log) {
		this.log = log;
		this.#listener = vsock.listen(564, (conn) => {
			const c = new Connection(this, conn);
			this.#conns.add(c);
			c.run().finally(() => this.#conns.delete(c));
		});
	}
	add(fs, opts = {}) {
		if (this.#closed) throw new FsError("ECONNABORTED", "the 9p server is closed");
		const e = new Export(this, `fs${this.next++}`, fs, !!opts.readOnly, opts.timeout ?? DEFAULT_TIMEOUT);
		this.#exports.set(e.name, e);
		this.#users.set(fs, (this.#users.get(fs) ?? 0) + 1);
		return e;
	}
	exportBusy(p) {
		const e = p;
		if (e.removed || !e.connected || !e.conn) return "not attached";
		return e.conn.busy();
	}
	saveExport(p) {
		const e = p;
		return {
			name: e.name,
			...e.conn.save()
		};
	}
	async restoreExport(fs, opts, saved, conn) {
		if (this.#closed) throw new FsError("ECONNABORTED", "the 9p server is closed");
		if (this.#exports.has(saved.name)) throw new FsError("EEXIST", `export ${saved.name} exists`);
		const e = new Export(this, saved.name, fs, !!opts.readOnly, opts.timeout ?? DEFAULT_TIMEOUT);
		this.#exports.set(e.name, e);
		this.#users.set(fs, (this.#users.get(fs) ?? 0) + 1);
		const n = /^fs(\d+)$/.exec(saved.name);
		if (n) this.next = Math.max(this.next, Number(n[1]) + 1);
		const session = new Session(e, Math.max(4096, Math.min(saved.msize, MSIZE)));
		await session.restore(saved.fids);
		const c = new Connection(this, conn, session);
		this.#conns.add(c);
		e.opened(c, true);
		c.run().finally(() => this.#conns.delete(c));
		return e;
	}
	get(name) {
		return this.#exports.get(name);
	}
	forget(e) {
		if (this.#exports.get(e.name) !== e) return;
		this.#exports.delete(e.name);
		const n = (this.#users.get(e.fs) ?? 1) - 1;
		if (n > 0) {
			this.#users.set(e.fs, n);
			return;
		}
		this.#users.delete(e.fs);
		Promise.resolve().then(() => e.fs.close?.()).catch((err) => this.log(`[9p] close: ${err?.message ?? err}`));
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#listener.close();
		for (const e of [...this.#exports.values()]) e.remove();
		for (const c of [...this.#conns]) c.reset();
	}
};
var Connection = class {
	#server;
	#conn;
	#writer;
	#asm;
	#msize;
	#session;
	#queue = [];
	#inFlight = 0;
	#wake;
	#done = false;
	#gone = false;
	constructor(server, conn, session) {
		this.#server = server;
		this.#conn = conn;
		this.#writer = conn.writable.getWriter();
		this.#msize = session?.msize ?? MSIZE;
		this.#asm = new P9FrameAssembler(MSIZE);
		this.#session = session;
		conn.closed.then(() => {
			this.#gone = true;
		});
	}
	busy() {
		if (this.#done || this.#gone) return "its connection ended";
		if (this.#inFlight || this.#queue.length || this.#asm.buffered || this.#session?.busy) return "a request in flight";
		const v = saveVsockConnection(this.#conn);
		return typeof v === "string" ? `its connection: ${v}` : void 0;
	}
	save() {
		const conn = saveVsockConnection(this.#conn);
		if (typeof conn === "string" || !this.#session) throw new Error(`9p: cannot save the connection (${conn})`);
		return {
			conn,
			msize: this.#session.msize,
			fids: this.#session.save()
		};
	}
	reset() {
		this.#conn.reset();
	}
	async run() {
		const reader = this.#conn.readable.getReader();
		try {
			for (;;) {
				while (this.#queue.length >= QUEUE && !this.#gone) await Promise.race([new Promise((r) => this.#wake = r), this.#conn.closed]);
				if (this.#gone) break;
				let chunk;
				try {
					chunk = await reader.read();
				} catch {
					break;
				}
				if (chunk.done || this.#done) break;
				this.#asm.push(chunk.value);
				for (let f = this.#asm.next(); f; f = this.#asm.next()) this.#frame(f);
			}
		} catch (e) {
			this.#server.log(`[9p] ${this.#session?.exp.name ?? "connection"}: ${e?.message ?? e}; resetting`);
			this.#conn.reset();
		} finally {
			this.#done = true;
			try {
				reader.releaseLock();
			} catch {}
			this.#conn.close();
			this.#queue = [];
			this.#session?.destroy();
			this.#session?.exp.opened(this, false);
		}
	}
	#send(frame) {
		if (this.#done) return;
		const s = this.#session?.exp.stats;
		if (s) {
			const t = typeOf(frame);
			if (t === Rlerror) s.errors++;
			else if (t === 117) s.bytesRead += frame.length - HDR - 4;
		}
		this.#writer.write(frame).catch(() => {});
	}
	#frame(frame) {
		const type = typeOf(frame), tag = tagOf(frame);
		const session = this.#session;
		if (session) session.exp.stats.requests++;
		if (type === Tflush) {
			const old = frame.length >= 9 ? frame[HDR] | frame[8] << 8 : -1;
			const i = this.#queue.findIndex((q) => q.tag === old);
			if (i >= 0) this.#queue.splice(i, 1);
			if (i < 0 && session) session.flush(old);
			this.#send(new Writer(HDR).finish(109, tag));
			this.#pump();
			return;
		}
		if (!session && type === Tversion) {
			try {
				const r = new Reader$1(frame);
				this.#msize = Math.max(4096, Math.min(r.u32(), MSIZE));
				const version = r.str();
				this.#send(new Writer(32).u32(this.#msize).str(version.startsWith(P9_VERSION) ? P9_VERSION : "unknown").finish(101, tag));
			} catch {
				this.#send(errorReply(tag, ERRNO$1.EPROTO));
			}
			return;
		}
		if (!session && type === Tattach) {
			let exp;
			try {
				const r = new Reader$1(frame);
				r.u32(), r.u32(), r.str();
				exp = this.#server.get(r.str());
			} catch {}
			if (!exp || exp.removed) {
				this.#server.log("[9p] attach to a file system that is not served");
				this.#send(errorReply(tag, ERRNO$1.ENOENT));
				return;
			}
			if (exp.conn) {
				this.#server.log(`[9p] ${exp.name}: attach from a second connection refused`);
				this.#send(errorReply(tag, ERRNO$1.EBUSY));
				return;
			}
			this.#session = new Session(exp, this.#msize);
			exp.opened(this, true);
			exp.stats.requests++;
		} else if (!session) {
			this.#send(errorReply(tag, type === Tauth ? ERRNO$1.EOPNOTSUPP : ERRNO$1.EBADF));
			return;
		}
		this.#queue.push({
			frame,
			tag
		});
		this.#pump();
	}
	#pump() {
		while (this.#session && this.#inFlight < WINDOW && this.#queue.length) {
			const q = this.#queue.shift();
			this.#inFlight++;
			this.#session.call(q.frame).then((reply) => {
				if (reply) this.#send(reply);
			}).finally(() => {
				this.#inFlight--;
				this.#pump();
			});
		}
		if (this.#queue.length < QUEUE) {
			const w = this.#wake;
			this.#wake = void 0;
			w?.();
		}
	}
};
function fileOf(f) {
	if (f.stale) throw new FsError("ESTALE", `${f.path}: the file open before the snapshot is gone`);
	return f.file;
}
const big = (v) => v === void 0 ? void 0 : String(v);
const unbig = (v) => v === void 0 ? void 0 : BigInt(v);
var Session = class {
	exp;
	#fs;
	#fids = /* @__PURE__ */ new Map();
	#msize;
	#pending = /* @__PURE__ */ new Map();
	#destroyed = false;
	constructor(exp, msize) {
		this.exp = exp;
		this.#fs = exp.fs;
		this.#msize = msize;
	}
	get msize() {
		return this.#msize;
	}
	get busy() {
		return this.#pending.size > 0;
	}
	save() {
		return [...this.#fids].map(([fid, f]) => ({
			fid,
			path: f.path,
			type: f.type,
			...f.file && f.open && !f.orphan ? { open: {
				read: f.open.read,
				write: f.open.write,
				append: f.open.append,
				ino: String(f.open.ino)
			} } : {},
			...f.file && (f.orphan || !f.open) || f.stale ? { orphan: true } : {},
			...f.dir ? { dir: f.dir.map((e) => ({
				name: e.name,
				type: e.type,
				ino: big(e.ino),
				dev: big(e.dev)
			})) } : {}
		}));
	}
	async restore(saved) {
		await Promise.all(saved.map(async (s) => {
			const f = {
				path: s.path,
				type: s.type,
				chain: Promise.resolve(),
				...s.dir ? { dir: s.dir.map((e) => ({
					name: e.name,
					type: e.type,
					ino: unbig(e.ino),
					dev: unbig(e.dev)
				})) } : {}
			};
			this.#fids.set(s.fid, f);
			if (s.orphan) f.stale = true;
			if (!s.open) return;
			const o = s.open;
			let file;
			let late = false;
			let timer;
			try {
				const t = this.exp.timeout;
				const opening = (async () => {
					const opened = await this.#fs.open(s.path, {
						read: o.read,
						write: o.write,
						truncate: false,
						append: o.append
					});
					if (late) {
						await opened.close?.();
						return false;
					}
					file = opened;
					const a = opened.getattr ? await opened.getattr() : await this.#fs.getattr(s.path);
					return a.type === "file" && String(inode(s.path, a.ino, a.dev)) === o.ino && (!o.write || !!opened.write);
				})();
				if (await (t > 0 ? Promise.race([opening, new Promise((r) => timer = setTimeout(() => r(false), t))]) : opening)) {
					f.file = file;
					f.open = {
						read: o.read,
						write: o.write,
						append: o.append,
						ino: BigInt(o.ino)
					};
					return;
				}
			} catch {} finally {
				clearTimeout(timer);
			}
			late = true;
			f.stale = true;
			if (file) Promise.resolve(file.close?.()).catch(() => {});
		}));
	}
	#orphan(path) {
		for (const f of this.#fids.values()) if (f.file && f.path === path) f.orphan = true;
	}
	#log(msg) {
		this.exp.server.log(`[9p] ${this.exp.name}: ${msg}`);
	}
	destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.resolve(null);
		}
		this.#pending.clear();
		for (const f of this.#fids.values()) this.#closeFile(f);
		this.#fids.clear();
	}
	flush(tag) {
		const p = this.#pending.get(tag);
		if (!p) return;
		p.dead = true;
		clearTimeout(p.timer);
		this.#pending.delete(tag);
		p.resolve(null);
	}
	#closeFile(f) {
		const file = f.file;
		f.file = void 0;
		f.open = void 0;
		if (file?.close) this.#ordered(f, () => file.close()).catch((e) => this.#failed("close", e));
	}
	#failed(what, e) {
		const n = knownErrno(e);
		if (!n) this.#log(`${what}: ${e?.stack ?? e}`);
		return n || ERRNO$1.EIO;
	}
	call(frame) {
		const type = typeOf(frame), tag = tagOf(frame);
		if (this.#destroyed) return Promise.resolve(null);
		return new Promise((resolve) => {
			const state = {
				dead: false,
				resolve
			};
			this.#pending.set(tag, state);
			const timeout = this.exp.timeout;
			if (timeout > 0) state.timer = setTimeout(() => {
				if (state.dead) return;
				state.dead = true;
				this.#pending.delete(tag);
				this.#log(`${MSG_NAMES[type] ?? type}: the handler did not answer within ${timeout} ms; the guest gets ETIMEDOUT`);
				resolve(errorReply(tag, ERRNO$1.ETIMEDOUT));
			}, timeout);
			let run;
			try {
				run = this.#handle(type, new Reader$1(frame), state);
			} catch (e) {
				run = Promise.reject(e);
			}
			run.then((w) => w.finish(type + 1, tag), (e) => errorReply(tag, this.#failed(MSG_NAMES[type] ?? String(type), e))).then((reply) => {
				clearTimeout(state.timer);
				if (this.#pending.get(tag) === state) this.#pending.delete(tag);
				if (!state.dead) resolve(reply);
			});
		});
	}
	#fid(n) {
		const f = this.#fids.get(n);
		if (!f) throw new FsError("EBADF", `unknown fid ${n}`);
		return f;
	}
	#dir(n) {
		const f = this.#fid(n);
		if (f.type !== "dir") throw new FsError("ENOTDIR");
		return f;
	}
	#ordered(f, op) {
		const p = f.chain.then(op);
		const t = this.exp.timeout;
		let timer;
		f.chain = (t > 0 ? Promise.race([p, new Promise((r) => timer = setTimeout(r, t))]) : p).catch(() => {}).finally(() => clearTimeout(timer));
		return p;
	}
	#need(k, code = "EROFS") {
		const fn = this.#fs[k];
		if (typeof fn !== "function") throw new FsError(code);
		return fn.bind(this.#fs);
	}
	async #open(f, state, file, write) {
		const opened = await file;
		if (state.dead || write && !opened.write) {
			await opened.close?.();
			if (!state.dead) throw new FsError("EACCES", `${f.path}: not writable`);
		} else {
			if (f.file) this.#closeFile(f);
			f.file = opened;
		}
		return opened;
	}
	#renamed(from, to) {
		for (const f of this.#fids.values()) if (under(f.path, from)) f.path = to + f.path.slice(from.length);
	}
	async #handle(type, r, state) {
		const fs = this.#fs;
		if (this.exp.readOnly) {
			const flags = type === Tlopen ? new DataView(r.buf.buffer, r.buf.byteOffset).getUint32(11, true) : 0;
			if (MUTATING.has(type) || type === Tlopen && (flags & O_ACCMODE || flags & O_TRUNC)) throw new FsError("EROFS");
			if (type === Tremove) {
				const n = r.u32();
				const f = this.#fid(n);
				this.#fids.delete(n);
				this.#closeFile(f);
				throw new FsError("EROFS");
			}
		}
		switch (type) {
			case Tversion: {
				const msize = r.u32();
				const version = r.str();
				this.#msize = Math.max(4096, Math.min(msize, this.#msize));
				for (const f of this.#fids.values()) this.#closeFile(f);
				this.#fids.clear();
				return new Writer(32).u32(this.#msize).str(version.startsWith(P9_VERSION) ? P9_VERSION : "unknown");
			}
			case Tauth: throw new FsError("EOPNOTSUPP");
			case Tattach: {
				const fid = r.u32();
				r.u32(), r.str();
				if (r.str() !== this.exp.name) throw new FsError("ENOENT", "an attach to another file system on this connection");
				const a = await fs.getattr("/");
				if (a.type !== "dir") throw new FsError("ENOTDIR", "the file system's root is not a directory");
				if (!state.dead) this.#fids.set(fid, {
					path: "/",
					type: "dir",
					chain: Promise.resolve()
				});
				return new Writer(20).qid(qidOf("/", a));
			}
			case Twalk: {
				const fid = r.u32(), newfid = r.u32(), n = r.u16();
				const f = this.#fid(fid);
				let path = f.path, ftype = f.type;
				const qids = [];
				for (let i = 0; i < n; i++) {
					let a;
					try {
						const name = r.name();
						if (ftype !== "dir") throw new FsError("ENOTDIR");
						const next = name === ".." ? parent(path) : (checkName$1(name), join(path, name));
						a = await fs.getattr(next);
						path = next;
					} catch (e) {
						if (i === 0) throw e;
						break;
					}
					qids.push(qidOf(path, a));
					ftype = a.type;
				}
				if (qids.length === n && !state.dead) {
					const old = this.#fids.get(newfid);
					if (old) this.#closeFile(old);
					this.#fids.set(newfid, {
						path,
						type: ftype,
						chain: old?.chain ?? Promise.resolve()
					});
				}
				const w = new Writer(9 + 13 * qids.length).u16(qids.length);
				for (const q of qids) w.qid(q);
				return w;
			}
			case Tclunk:
			case Tremove: {
				const n = r.u32();
				const f = this.#fid(n);
				this.#fids.delete(n);
				const file = f.file;
				f.file = void 0;
				await this.#ordered(f, () => file?.close?.());
				if (type === Tremove) {
					if (f.path === "/") throw new FsError("EBUSY");
					await this.#need("remove")(f.path, f.type === "dir");
					this.#orphan(f.path);
				}
				return new Writer(HDR);
			}
			case Tstatfs: {
				this.#fid(r.u32());
				const s = await fs.statfs?.() ?? {};
				return new Writer(67).u32(V9FS_MAGIC).u32(s.bsize ?? 4096).u64(s.blocks ?? 0).u64(s.bfree ?? 0).u64(s.bavail ?? s.bfree ?? 0).u64(s.files ?? 0).u64(s.ffree ?? 0).u64(0).u32(s.namelen ?? 255);
			}
			case Tlopen: {
				const f = this.#fid(r.u32());
				const flags = r.u32();
				const write = (flags & O_ACCMODE) !== 0;
				let a = await fs.getattr(f.path);
				f.type = a.type;
				if (a.type === "file") {
					const truncate = (flags & O_TRUNC) !== 0;
					const read = (flags & O_ACCMODE) !== 1, append = (flags & O_APPEND) !== 0;
					const file = await this.#open(f, state, fs.open(f.path, {
						read,
						write,
						truncate,
						append
					}), write);
					if (truncate) a = await file.getattr?.() ?? await fs.getattr(f.path);
					if (!state.dead && f.file === file) f.open = {
						read,
						write,
						append,
						ino: inode(f.path, a.ino, a.dev)
					};
				}
				f.dir = void 0;
				return new Writer(24).qid(qidOf(f.path, a)).u32(0);
			}
			case Tlcreate: {
				const f = this.#dir(r.u32());
				const name = r.name();
				const flags = r.u32(), mode = r.u32();
				checkName$1(name);
				const path = join(f.path, name);
				let file;
				let how = {
					read: true,
					write: true,
					append: false
				};
				try {
					file = await this.#open(f, state, this.#need("create")(path, mode & 4095), false);
				} catch (e) {
					if (flags & O_EXCL || e?.code !== "EEXIST") throw e;
					const a = await fs.getattr(path);
					if (a.type !== "file") throw new FsError(a.type === "dir" ? "EISDIR" : "EEXIST");
					how = {
						read: (flags & O_ACCMODE) !== 1,
						write: true,
						append: (flags & O_APPEND) !== 0
					};
					file = await this.#open(f, state, fs.open(path, {
						...how,
						truncate: (flags & O_TRUNC) !== 0
					}), true);
				}
				const a = await file.getattr?.() ?? await fs.getattr(path);
				if (!state.dead) {
					f.path = path;
					f.type = "file";
					if (f.file === file) f.open = {
						...how,
						ino: inode(path, a.ino, a.dev)
					};
				}
				return new Writer(24).qid(qidOf(path, a)).u32(0);
			}
			case Tmkdir:
			case Tsymlink: {
				const f = this.#dir(r.u32());
				const name = r.name();
				checkName$1(name);
				const path = join(f.path, name);
				if (type === Tmkdir) await this.#need("mkdir")(path, r.u32() & 4095);
				else await this.#need("symlink", "EOPNOTSUPP")(path, r.name());
				return new Writer(20).qid(qidOf(path, await fs.getattr(path)));
			}
			case Tlink: throw new FsError("EPERM", "no hard links");
			case Tmknod: throw new FsError("EOPNOTSUPP");
			case Tunlinkat: {
				const f = this.#dir(r.u32());
				const name = r.name();
				const flags = r.u32();
				checkName$1(name);
				await this.#need("remove")(join(f.path, name), !!(flags & AT_REMOVEDIR));
				this.#orphan(join(f.path, name));
				return new Writer(HDR);
			}
			case Trenameat:
			case Trename: {
				let from, to;
				if (type === Trenameat) {
					const od = this.#dir(r.u32()), oname = r.name(), nd = this.#dir(r.u32()), nname = r.name();
					checkName$1(oname);
					checkName$1(nname);
					from = join(od.path, oname);
					to = join(nd.path, nname);
				} else {
					const f = this.#fid(r.u32()), d = this.#dir(r.u32()), name = r.name();
					checkName$1(name);
					from = f.path;
					to = join(d.path, name);
				}
				if (from === "/" || under(to, from) && to !== from) throw new FsError(from === "/" ? "EBUSY" : "EINVAL");
				if (from !== to) {
					await this.#need("rename")(from, to);
					this.#orphan(to);
					this.#renamed(from, to);
				}
				return new Writer(HDR);
			}
			case Treadlink: {
				const f = this.#fid(r.u32());
				return new Writer().str(await this.#need("readlink", "EINVAL")(f.path));
			}
			case Tgetattr: {
				const f = this.#fid(r.u32());
				const file = fileOf(f);
				const a = file?.getattr ? await file.getattr() : await fs.getattr(f.path);
				const size = a.size ?? 0;
				const perm = a.mode ?? (a.type === "dir" ? 493 : a.type === "symlink" ? 511 : 420);
				const fmt = a.type === "dir" ? S_IFDIR : a.type === "symlink" ? S_IFLNK : S_IFREG;
				const w = new Writer(160).u64(P9_STATS_BASIC).qid(qidOf(f.path, a)).u32(fmt | perm & 4095).u32(a.uid ?? 0).u32(a.gid ?? 0).u64(a.nlink ?? (a.type === "dir" ? 2 : 1)).u64(0).u64(size).u64(4096).u64(Math.ceil(size / 512));
				const m = a.mtimeMs ?? Date.now();
				for (const t of [
					a.atimeMs ?? m,
					m,
					a.ctimeMs ?? m,
					0
				]) {
					const s = Math.floor(t / 1e3);
					w.u64(s).u64(Math.min(999999999, Math.round((t - s * 1e3) * 1e6)));
				}
				return w.u64(0).u64(0);
			}
			case Tsetattr: {
				const f = this.#fid(r.u32());
				const valid = r.u32(), mode = r.u32(), uid = r.u32(), gid = r.u32(), size = r.u64();
				const as = r.u64(), an = r.u64(), ms = r.u64(), mn = r.u64();
				const attr = {};
				if (valid & 1) attr.mode = mode & 4095;
				if (valid & 2) attr.uid = uid;
				if (valid & 4) attr.gid = gid;
				if (valid & 8) attr.size = size;
				if (valid & 16) attr.atimeMs = valid & 128 ? as * 1e3 + an / 1e6 : Date.now();
				if (valid & 32) attr.mtimeMs = valid & 256 ? ms * 1e3 + mn / 1e6 : Date.now();
				const file = fileOf(f);
				if (Object.keys(attr).length) await this.#ordered(f, () => file?.setattr ? file.setattr(attr) : this.#need("setattr")(f.path, attr));
				return new Writer(HDR);
			}
			case Treaddir: {
				const f = this.#fid(r.u32());
				const offset = r.u64(), count = r.u32();
				if (f.type !== "dir") throw new FsError("ENOTDIR");
				if (offset === 0 || !f.dir) f.dir = [
					{
						name: ".",
						type: "dir"
					},
					{
						name: "..",
						type: "dir"
					},
					...await fs.readdir(f.path)
				];
				const max = Math.min(count, this.#msize - HDR - 4);
				const w = new Writer(Math.min(max, 65536) + HDR + 4);
				w.u32(0);
				const start = w.n;
				for (let i = offset; i < f.dir.length; i++) {
					const e = f.dir[i];
					const name = enc$2.encode(e.name);
					if (w.n - start + 24 + name.length > max) break;
					const path = e.name === "." ? f.path : e.name === ".." ? parent(f.path) : join(f.path, e.name);
					w.u8(qidType(e.type)).u32(0).u64(inode(path, e.ino, e.dev));
					w.u64(i + 1).u8(e.type === "dir" ? DT_DIR : e.type === "symlink" ? DT_LNK : DT_REG);
					w.u16(name.length).bytes(name);
				}
				w.dv.setUint32(HDR, w.n - start, true);
				return w;
			}
			case Tread: {
				const f = this.#fid(r.u32());
				const offset = r.u64(), count = Math.min(r.u32(), this.#msize - HDR - 4);
				const file = fileOf(f);
				if (!file) throw new FsError(f.type === "dir" ? "EISDIR" : "EBADF");
				const data = await file.read(offset, count);
				const n = Math.min(data.length, count);
				return new Writer(11 + n).u32(n).bytes(n === data.length ? data : data.subarray(0, n));
			}
			case Twrite: {
				const f = this.#fid(r.u32());
				const offset = r.u64(), count = r.u32();
				const data = r.bytes(count);
				const file = fileOf(f);
				if (!file?.write) throw new FsError(f.type === "dir" ? "EISDIR" : "EBADF");
				this.exp.stats.bytesWritten += count;
				return new Writer(11).u32(await this.#ordered(f, () => file.write(offset, data)));
			}
			case Tfsync: {
				const f = this.#fid(r.u32());
				const file = fileOf(f);
				await this.#ordered(f, () => file?.fsync?.());
				return new Writer(HDR);
			}
			case Tlock:
				this.#fid(r.u32());
				return new Writer(8).u8(0);
			case Tgetlock: {
				this.#fid(r.u32());
				r.u8();
				const start = r.u64(), length = r.u64(), procId = r.u32(), client = r.str();
				return new Writer().u8(2).u64(start).u64(length).u32(procId).str(client);
			}
			case Txattrwalk:
			case Txattrcreate: throw new FsError("EOPNOTSUPP");
			default: throw new FsError("EOPNOTSUPP", `unknown message type ${type}`);
		}
	}
};
const enc$1 = new TextEncoder();
const dec = new TextDecoder();
const EMPTY = /* @__PURE__ */ new Uint8Array(0);
function parts(path) {
	return path.split("/").filter((p) => p && p !== ".");
}
function checkName(name, path) {
	if (!name || name === ".." || name.includes("\0")) throw new FsError("EINVAL", `bad name in ${JSON.stringify(path)}`);
}
var MemoryFs = class {
	#root;
	#nextIno = 2;
	#listeners = /* @__PURE__ */ new Set();
	constructor(tree) {
		const now = Date.now();
		this.#root = {
			ino: 1,
			type: "dir",
			mode: 493,
			uid: 0,
			gid: 0,
			atimeMs: now,
			mtimeMs: now,
			ctimeMs: now,
			version: 1,
			nlink: 2,
			children: /* @__PURE__ */ new Map()
		};
		if (tree) this.#fill("", tree);
	}
	#fill(dir, tree) {
		for (const [name, v] of Object.entries(tree)) {
			const path = `${dir}/${name}`;
			if (typeof v === "string" || v instanceof Uint8Array || typeof v === "function") this.writeFile(path, v);
			else if (v && typeof v === "object") {
				this.mkdirp(path);
				this.#fill(path, v);
			} else throw new TypeError(`MemoryFs: ${path}: a file is a string, a Uint8Array or a function, a directory an object`);
		}
	}
	onChange(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#emit(type, path, to) {
		for (const l of this.#listeners) try {
			l(to === void 0 ? {
				type,
				path
			} : {
				type,
				path,
				to
			});
		} catch {}
	}
	#lookup(path) {
		let n = this.#root;
		for (const part of parts(path)) {
			if (!n.children) throw new FsError("ENOTDIR", path);
			const c = n.children.get(part);
			if (!c) throw new FsError("ENOENT", path);
			n = c;
		}
		return n;
	}
	#find(path) {
		try {
			return this.#lookup(path);
		} catch {
			return;
		}
	}
	#dirOf(path) {
		const p = parts(path);
		const name = p.pop();
		if (name === void 0) throw new FsError("EBUSY", "the root");
		checkName(name, path);
		const dir = this.#lookup(p.join("/"));
		if (!dir.children) throw new FsError("ENOTDIR", path);
		return {
			dir,
			name
		};
	}
	#node(type, mode, extra = {}) {
		const now = Date.now();
		return {
			ino: this.#nextIno++,
			type,
			mode,
			uid: 0,
			gid: 0,
			atimeMs: now,
			mtimeMs: now,
			ctimeMs: now,
			version: 1,
			nlink: type === "dir" ? 2 : 1,
			...extra
		};
	}
	#touchDir(dir) {
		dir.mtimeMs = dir.ctimeMs = Date.now();
		dir.version++;
	}
	#bytes(n) {
		if (n.dynamic) {
			const v = n.dynamic();
			return typeof v === "string" ? enc$1.encode(v) : v;
		}
		return n.data ? n.data.subarray(0, n.size ?? n.data.length) : EMPTY;
	}
	#changed(n) {
		n.mtimeMs = n.ctimeMs = Date.now();
		n.version++;
	}
	#ensure(n, size) {
		const cur = n.data ?? EMPTY;
		if (size <= cur.length) return;
		const b = new Uint8Array(Math.max(size, cur.length * 2, 4096));
		b.set(cur.subarray(0, n.size ?? cur.length));
		n.data = b;
	}
	#writeNode(n, offset, data) {
		if (n.type !== "file") throw new FsError("EISDIR");
		if (n.dynamic) throw new FsError("EACCES");
		this.#ensure(n, offset + data.length);
		n.data.set(data, offset);
		const size = n.size ?? 0;
		if (offset > size) n.data.fill(0, size, offset);
		n.size = Math.max(size, offset + data.length);
		this.#changed(n);
		return data.length;
	}
	#truncate(n, size) {
		if (n.type !== "file") throw new FsError(n.type === "dir" ? "EISDIR" : "EINVAL");
		if (n.dynamic) throw new FsError("EACCES");
		const old = n.size ?? 0;
		if (size > old) {
			this.#ensure(n, size);
			n.data.fill(0, old, size);
		}
		n.size = size;
		this.#changed(n);
	}
	#attr(n, size) {
		size ??= n.type === "file" ? n.dynamic ? this.#bytes(n).length : n.size ?? 0 : n.type === "symlink" ? enc$1.encode(n.target).length : 4096;
		return {
			type: n.type,
			mode: n.mode,
			size,
			uid: n.uid,
			gid: n.gid,
			nlink: n.nlink,
			ino: n.ino,
			atimeMs: n.atimeMs,
			mtimeMs: n.mtimeMs,
			ctimeMs: n.ctimeMs,
			version: n.dynamic ? 0 : n.version
		};
	}
	#setattr(n, attr) {
		if (attr.size !== void 0) this.#truncate(n, attr.size);
		if (attr.mode !== void 0) n.mode = attr.mode & 4095;
		if (attr.uid !== void 0) n.uid = attr.uid;
		if (attr.gid !== void 0) n.gid = attr.gid;
		if (attr.atimeMs !== void 0) n.atimeMs = attr.atimeMs;
		if (attr.mtimeMs !== void 0) {
			n.mtimeMs = attr.mtimeMs;
			n.version++;
		}
		n.ctimeMs = Date.now();
	}
	#unlinkNode(dir, name, n) {
		dir.children.delete(name);
		if (n.type === "dir") dir.nlink--;
		n.nlink--;
		n.ctimeMs = Date.now();
		this.#touchDir(dir);
	}
	writeFile(path, content, opts = {}) {
		const p = parts(path);
		if (p.length > 1) this.mkdirp(p.slice(0, -1).join("/"));
		const { dir, name } = this.#dirOf(path);
		const old = dir.children.get(name);
		if (old?.type === "dir") throw new FsError("EISDIR", path);
		const mode = opts.mode ?? old?.mode ?? 420;
		if (old && old.type === "file") {
			old.mode = mode;
			if (typeof content === "function") {
				old.dynamic = content;
				old.data = void 0;
				old.size = 0;
			} else {
				const data = typeof content === "string" ? enc$1.encode(content) : content.slice();
				old.dynamic = void 0;
				old.data = data;
				old.size = data.length;
			}
			this.#changed(old);
			return;
		}
		const n = typeof content === "function" ? this.#node("file", mode, { dynamic: content }) : (() => {
			const data = typeof content === "string" ? enc$1.encode(content) : content.slice();
			return this.#node("file", mode, {
				data,
				size: data.length
			});
		})();
		if (old) this.#unlinkNode(dir, name, old);
		dir.children.set(name, n);
		this.#touchDir(dir);
	}
	readFile(path) {
		const n = this.#lookup(path);
		if (n.type !== "file") throw new FsError(n.type === "dir" ? "EISDIR" : "EINVAL", path);
		return this.#bytes(n).slice();
	}
	readText(path) {
		return dec.decode(this.readFile(path));
	}
	mkdirp(path, opts = {}) {
		let n = this.#root;
		let cur = "";
		for (const part of parts(path)) {
			checkName(part, path);
			cur += `/${part}`;
			let c = n.children.get(part);
			if (!c) {
				c = this.#node("dir", opts.mode ?? 493, { children: /* @__PURE__ */ new Map() });
				n.children.set(part, c);
				n.nlink++;
				this.#touchDir(n);
			} else if (c.type !== "dir") throw new FsError("ENOTDIR", cur);
			n = c;
		}
	}
	writeLink(path, target) {
		const p = parts(path);
		if (p.length > 1) this.mkdirp(p.slice(0, -1).join("/"));
		const { dir, name } = this.#dirOf(path);
		const old = dir.children.get(name);
		if (old?.type === "dir") throw new FsError("EISDIR", path);
		if (old) this.#unlinkNode(dir, name, old);
		dir.children.set(name, this.#node("symlink", 511, { target }));
		this.#touchDir(dir);
	}
	rm(path, opts = {}) {
		let d;
		try {
			d = this.#dirOf(path);
		} catch (e) {
			if (opts.force && e.code === "ENOENT") return;
			throw e;
		}
		const n = d.dir.children.get(d.name);
		if (!n) {
			if (opts.force) return;
			throw new FsError("ENOENT", path);
		}
		if (n.children?.size && !opts.recursive) throw new FsError("ENOTEMPTY", path);
		this.#unlinkNode(d.dir, d.name, n);
	}
	move(from, to) {
		this.#rename(from, to);
	}
	list(path = "/") {
		const n = this.#lookup(path);
		if (!n.children) throw new FsError("ENOTDIR", path);
		return [...n.children.keys()];
	}
	stat(path) {
		const n = this.#find(path);
		return n && this.#attr(n);
	}
	exists(path) {
		return this.#find(path) !== void 0;
	}
	getattr(path) {
		return this.#attr(this.#lookup(path));
	}
	readdir(path) {
		const n = this.#lookup(path);
		if (!n.children) throw new FsError("ENOTDIR", path);
		return [...n.children].map(([name, c]) => ({
			name,
			type: c.type,
			ino: c.ino
		}));
	}
	readlink(path) {
		const n = this.#lookup(path);
		if (n.type !== "symlink") throw new FsError("EINVAL", path);
		return n.target;
	}
	open(path, flags) {
		const n = this.#lookup(path);
		if (n.type !== "file") throw new FsError("EISDIR", path);
		if (flags.write && n.dynamic) throw new FsError("EACCES", path);
		if (flags.truncate) {
			this.#truncate(n, 0);
			this.#emit("truncate", path);
		}
		return this.#file(n, path);
	}
	#file(n, path) {
		if (n.dynamic) {
			const b = this.#bytes(n);
			return {
				read: (offset, length) => b.subarray(Math.min(offset, b.length), Math.min(offset + length, b.length)),
				getattr: () => this.#attr(n, b.length),
				setattr: (attr) => {
					this.#setattr(n, attr);
					this.#emit("setattr", path);
				}
			};
		}
		return {
			read: (offset, length) => {
				const b = this.#bytes(n);
				return b.subarray(Math.min(offset, b.length), Math.min(offset + length, b.length));
			},
			write: (offset, data) => {
				const r = this.#writeNode(n, offset, data);
				this.#emit("write", path);
				return r;
			},
			getattr: () => this.#attr(n),
			setattr: (attr) => {
				this.#setattr(n, attr);
				this.#emit(attr.size !== void 0 ? "truncate" : "setattr", path);
			}
		};
	}
	create(path, mode) {
		const { dir, name } = this.#dirOf(path);
		if (dir.children.has(name)) throw new FsError("EEXIST", path);
		const n = this.#node("file", mode & 4095, {
			data: EMPTY,
			size: 0
		});
		dir.children.set(name, n);
		this.#touchDir(dir);
		this.#emit("create", path);
		return this.#file(n, path);
	}
	mkdir(path, mode) {
		const { dir, name } = this.#dirOf(path);
		if (dir.children.has(name)) throw new FsError("EEXIST", path);
		dir.children.set(name, this.#node("dir", mode & 4095, { children: /* @__PURE__ */ new Map() }));
		dir.nlink++;
		this.#touchDir(dir);
		this.#emit("mkdir", path);
	}
	symlink(path, target) {
		const { dir, name } = this.#dirOf(path);
		if (dir.children.has(name)) throw new FsError("EEXIST", path);
		dir.children.set(name, this.#node("symlink", 511, { target }));
		this.#touchDir(dir);
		this.#emit("symlink", path, target);
	}
	remove(path, dir) {
		const d = this.#dirOf(path);
		const n = d.dir.children.get(d.name);
		if (!n) throw new FsError("ENOENT", path);
		if (dir && n.type !== "dir") throw new FsError("ENOTDIR", path);
		if (!dir && n.type === "dir") throw new FsError("EISDIR", path);
		if (n.children?.size) throw new FsError("ENOTEMPTY", path);
		this.#unlinkNode(d.dir, d.name, n);
		this.#emit("remove", path);
	}
	rename(from, to) {
		this.#rename(from, to);
		this.#emit("rename", from, to);
	}
	#rename(from, to) {
		const a = this.#dirOf(from), b = this.#dirOf(to);
		const n = a.dir.children.get(a.name);
		if (!n) throw new FsError("ENOENT", from);
		if (n.type === "dir") {
			let p = this.#root;
			for (const part of parts(to).slice(0, -1)) {
				if (p === n) break;
				p = p.children.get(part);
			}
			if (p === n) throw new FsError("EINVAL", `${from} into itself`);
		}
		const old = b.dir.children.get(b.name);
		if (old === n) return;
		if (old) {
			if (old.type === "dir" && n.type !== "dir") throw new FsError("EISDIR", to);
			if (old.type !== "dir" && n.type === "dir") throw new FsError("ENOTDIR", to);
			if (old.children?.size) throw new FsError("ENOTEMPTY", to);
			this.#unlinkNode(b.dir, b.name, old);
		}
		a.dir.children.delete(a.name);
		b.dir.children.set(b.name, n);
		if (n.type === "dir" && a.dir !== b.dir) {
			a.dir.nlink--;
			b.dir.nlink++;
		}
		n.ctimeMs = Date.now();
		this.#touchDir(a.dir);
		if (b.dir !== a.dir) this.#touchDir(b.dir);
	}
	setattr(path, attr) {
		this.#setattr(this.#lookup(path), attr);
		this.#emit(attr.size !== void 0 ? "truncate" : "setattr", path);
	}
	statfs() {
		let files = 0, bytes = 0;
		const walk = (n) => {
			files++;
			bytes += n.data?.length ?? 0;
			if (n.children) for (const c of n.children.values()) walk(c);
		};
		walk(this.#root);
		const blocks = Math.max(1 << 18, Math.ceil(bytes / 4096) * 2);
		return {
			bsize: 4096,
			blocks,
			bfree: blocks - Math.ceil(bytes / 4096),
			files: Math.max(65536, files * 2),
			ffree: Math.max(65536, files * 2) - files
		};
	}
};
var MountError = class extends Error {
	code;
	constructor(code, message, cause) {
		super(message, cause === void 0 ? void 0 : { cause });
		this.name = "MountError";
		this.code = code;
	}
};
function snapshotMountMismatch(saved, given) {
	for (const m of saved?.mounts ?? []) {
		const g = given.find((x) => x.path === m.path);
		if (!g) return `the snapshot has a host file system at ${m.path}, which this machine is not given (mounts)`;
		if (!!g.opts.readOnly !== m.readOnly) return `the host file system at ${m.path} is ${m.readOnly ? "" : "not "}read-only in the snapshot`;
	}
	return null;
}
const BOOT_TIMEOUT_MS = 12e4;
const DEFAULT_TIMEOUT_MS = 3e4;
const SPEC_KEYS = /* @__PURE__ */ new Set([
	"fs",
	"readOnly",
	"timeout",
	"requestTimeout"
]);
const isFs = (v) => !!v && typeof v === "object" && typeof v.getattr === "function";
function isSpec(v) {
	if (!v || typeof v !== "object" || isFs(v) || !("fs" in v)) return false;
	const fs = v.fs;
	return !!fs && typeof fs === "object" && Object.keys(v).every((k) => SPEC_KEYS.has(k));
}
function toFs(src) {
	if (isFs(src)) return src;
	if (src && typeof src === "object" && !(src instanceof Uint8Array)) return new MemoryFs(src);
	throw new MountError("EINVAL", "a file system is an Fs (MemoryFs, nodeFs(), your own) or an object tree of files");
}
function normalizeMountPath(path) {
	if (typeof path !== "string" || !path.startsWith("/") || /[\0,]/.test(path)) throw new MountError("EINVAL", `mount path ${JSON.stringify(path)}: an absolute guest path`);
	const parts = path.split("/").filter((p) => p && p !== ".");
	if (parts.includes("..")) throw new MountError("EINVAL", `mount path ${JSON.stringify(path)}: no ".." parts`);
	if (!parts.length) throw new MountError("EINVAL", "mount path \"/\": not over the root");
	return `/${parts.join("/")}`;
}
function parseMounts(mounts, vsock) {
	if (!mounts) return [];
	const list = Object.entries(mounts).map(([path, v]) => {
		const { fs, ...opts } = isSpec(v) ? v : { fs: v };
		toFs(fs);
		return {
			path: normalizeMountPath(path),
			fs,
			opts
		};
	});
	if (list.length && !vsock) throw new MountError("ENODEV", "createKernel({ mounts }) needs the vsock device (the 9p server and kwtty run over it); it was turned off (vsock: false)");
	return list;
}
var MountHandle = class {
	path;
	exp;
	readOnly;
	state = "mounting";
	#table;
	constructor(table, exp, path, readOnly) {
		this.#table = table;
		this.exp = exp;
		this.path = path;
		this.readOnly = readOnly;
	}
	get mounted() {
		return this.state === "mounted" || this.state === "unmounting";
	}
	get stats() {
		return { ...this.exp.stats };
	}
	gone() {
		this.state = "gone";
		this.#table.release(this);
		this.exp.remove();
	}
	unmount(opts = {}) {
		return this.#table.unmount(this, opts);
	}
};
async function guestRun(vsock, file, args, timeout) {
	const ac = new AbortController();
	let timer;
	try {
		return await Promise.race([execSubprocess(vsock, file, args, {
			timeout,
			signal: ac.signal
		}), new Promise((_, rej) => timer = setTimeout(() => {
			ac.abort();
			rej(new PtyError("ETIMEDOUT", `${file} did not finish within ${timeout} ms (it was killed)`));
		}, timeout))]);
	} finally {
		clearTimeout(timer);
	}
}
var MountTable = class {
	#vsock;
	#log;
	#server;
	#mounts = /* @__PURE__ */ new Map();
	#boot;
	#down = false;
	constructor(vsock, log) {
		this.#vsock = vsock;
		this.#log = log;
	}
	get mounts() {
		return this.#mounts;
	}
	snapshotBlocker(keep = false) {
		if (this.#boot) return "createKernel's mounts are still being mounted";
		if (!keep && this.#mounts.size) return `host file systems are mounted (${[...this.#mounts.keys()].join(", ")}); unmount them first (only an inline instance's snapshot keeps them)`;
		for (const h of this.#mounts.values()) if (h.state !== "mounted") return `${h.path} is being ${h.state === "mounting" ? "mounted" : "unmounted"}`;
	}
	snapshotBusy() {
		const why = this.snapshotBlocker(true);
		if (why) return why;
		for (const h of this.#mounts.values()) {
			const b = this.#server.exportBusy(h.exp);
			if (b) return `host file system ${h.path}: ${b}`;
		}
		return "";
	}
	save() {
		if (!this.#mounts.size || !this.#server) return void 0;
		return {
			next: this.#server.next,
			mounts: [...this.#mounts.values()].map((h) => ({
				path: h.path,
				readOnly: h.readOnly,
				export: this.#server.saveExport(h.exp)
			}))
		};
	}
	async restore(saved, given) {
		const keep = /* @__PURE__ */ new Set();
		if (!saved?.mounts.length) return {
			keep,
			rest: given
		};
		const vsock = this.#vsock;
		if (!(vsock instanceof VsockHost)) throw new MountError("ENODEV", "host file systems in a snapshot need this instance's vsock host");
		this.#server ??= serve9p(vsock, this.#log);
		this.#server.next = Math.max(this.#server.next, saved.next);
		for (const m of saved.mounts) {
			const g = given.find((x) => x.path === m.path);
			const conn = vsock.adopt(m.export.conn);
			keep.add(`${m.export.conn.remotePort}:${m.export.conn.localPort}`);
			const exp = await this.#server.restoreExport(toFs(g.fs), {
				readOnly: m.readOnly,
				timeout: g.opts.requestTimeout
			}, m.export, conn);
			const h = new MountHandle(this, exp, m.path, m.readOnly);
			h.state = "mounted";
			this.#mounts.set(m.path, h);
			this.#watch(h);
		}
		return {
			keep,
			rest: given.filter((g) => !saved.mounts.some((m) => m.path === g.path))
		};
	}
	#watch(h) {
		h.exp.onConnection = (connected) => {
			if (!connected && h.state === "mounted") {
				this.#log(`[host] ${h.path} was unmounted in the guest`);
				h.gone();
			}
		};
	}
	gate(fn) {
		return this.#boot ? this.#boot.then(fn) : fn();
	}
	mountAll(list) {
		if (!list.length) return;
		const boot = Promise.allSettled(list.map((m) => this.mount(m.path, m.fs, {
			timeout: BOOT_TIMEOUT_MS,
			...m.opts
		}))).then((rs) => {
			if (this.#boot === boot) this.#boot = void 0;
			const failed = rs.flatMap((r) => r.status === "rejected" ? [r.reason] : []);
			for (const e of failed) this.#log(`[host] ${e?.message ?? e}`);
			if (failed.length) throw failed[0];
		});
		boot.catch(() => {});
		this.#boot = boot;
	}
	async mount(path, src, opts = {}) {
		const vsock = this.#vsock;
		if (!vsock) throw new MountError("ENODEV", "host file systems need the vsock device, which this instance has not: it was created with vsock: false");
		if (this.#down) throw new MountError("ECONNABORTED", "the kernel exited");
		const p = normalizeMountPath(path);
		const fs = toFs(src);
		if (this.#mounts.has(p)) throw new MountError("EBUSY", `${p}: already mounted by this SDK`);
		if (!this.#server) try {
			this.#server = serve9p(vsock, this.#log);
		} catch (e) {
			throw new MountError("EBUSY", `cannot serve 9p on vsock port 564: ${e?.message ?? e}`, e);
		}
		const exp = this.#server.add(fs, {
			readOnly: opts.readOnly,
			timeout: opts.requestTimeout
		});
		const h = new MountHandle(this, exp, p, !!opts.readOnly);
		this.#mounts.set(p, h);
		this.#watch(h);
		const fail = (e) => {
			h.gone();
			throw e;
		};
		const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
		let r;
		try {
			r = await guestRun(vsock, "kw9p", [
				exp.name,
				p,
				...opts.readOnly ? ["ro"] : []
			], timeout);
		} catch (e) {
			const code = e instanceof PtyError ? e.code : "";
			const msg = e?.message ?? String(e);
			if (this.#down || code === "ECONNABORTED" || code === "ECONNRESET") fail(new MountError("ECONNABORTED", `mount ${p}: the kernel exited`, e));
			if (code === "ETIMEDOUT") fail(new MountError("ETIMEDOUT", `mount ${p}: ${/killed/.test(msg) ? msg : `no answer from the guest's kwtty within ${timeout} ms (an image without kwtty, or still booting?)`}`, e));
			if (code === "EREMOTE" && /exec kw9p: No such file/.test(msg)) fail(new MountError("ENOENT", `mount ${p}: the guest has no /usr/bin/kw9p (an image from before host file systems)`, e));
			fail(new MountError("EREMOTE", `mount ${p}: ${msg}`, e));
		}
		if (r.exitCode !== 0) {
			const text = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
			const errno = Number(/\(errno (\d+)\)\s*$/.exec(text)?.[1] ?? 0);
			const why = `mount ${p}: ${text.replace(/^kw9p: /, "").replace(/\s*\(errno \d+\)\s*$/, "") || `kw9p exited with ${r.exitCode ?? `signal ${r.signal}`}`}`;
			if (errno === 19) fail(new MountError("ENODEV", `${why} (the guest's kernel has no 9p file system, CONFIG_9P_FS)`));
			if (errno === 16) fail(new MountError("EBUSY", why));
			if (errno === 20) fail(new MountError("ENOTDIR", why));
			fail(new MountError("EREMOTE", why));
		}
		if (this.#down) fail(new MountError("ECONNABORTED", `mount ${p}: the kernel exited`));
		if (h.state === "mounting") h.state = "mounted";
		return h;
	}
	release(h) {
		if (this.#mounts.get(h.path) === h) this.#mounts.delete(h.path);
	}
	async unmount(h, opts) {
		const vsock = this.#vsock;
		if (h.state === "gone" || h.state === "mounting" || !vsock || this.#down) return h.gone();
		if (h.state === "unmounting") throw new MountError("EBUSY", `${h.path}: an unmount is already running`);
		h.state = "unmounting";
		let r;
		try {
			r = await guestRun(vsock, "umount", [h.path], opts.timeout ?? DEFAULT_TIMEOUT_MS);
		} catch (e) {
			if (this.#down || e.code === "ECONNABORTED") return h.gone();
			h.state = "mounted";
			throw new MountError(e.code === "ETIMEDOUT" ? "ETIMEDOUT" : "EREMOTE", `unmount ${h.path}: ${e?.message ?? e}`, e);
		}
		const text = (r.stderr || r.stdout).trim();
		if (r.exitCode !== 0 && !/not mounted|Invalid argument|No such file/i.test(text)) {
			h.state = "mounted";
			throw new MountError(/busy/i.test(text) ? "EBUSY" : "EREMOTE", `unmount ${h.path}: ${text || `umount exited with ${r.exitCode}`}`);
		}
		const end = performance.now() + 2e3;
		while (h.exp.connected && performance.now() < end && !this.#down) await new Promise((res) => setTimeout(res, 10));
		h.gone();
	}
	shutdown() {
		if (this.#down) return;
		this.#down = true;
		for (const h of [...this.#mounts.values()]) h.state = "gone";
		this.#mounts.clear();
		this.#server?.close();
	}
};
const KWSPARSE_MAGIC = "KWSPARS1";
const HEADER = 24;
function isZeroBlock(b) {
	if ((b.byteOffset & 3) === 0 && (b.length & 3) === 0) {
		const w = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
		for (let i = 0; i < w.length; i++) if (w[i]) return false;
		return true;
	}
	for (let i = 0; i < b.length; i++) if (b[i]) return false;
	return true;
}
function kwsparseHeader(size, blockSize, indices) {
	const out = new Uint8Array(HEADER + 8 * indices.length);
	const dv = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) out[i] = KWSPARSE_MAGIC.charCodeAt(i);
	dv.setBigUint64(8, BigInt(size), true);
	dv.setUint32(16, blockSize, true);
	dv.setUint32(20, indices.length, true);
	let prev = -1;
	indices.forEach((b, i) => {
		if (!(b > prev) || !Number.isSafeInteger(b) || (b + 1) * blockSize > size) throw new Error(`kwsparse: bad block index ${b}`);
		prev = b;
		dv.setBigUint64(HEADER + 8 * i, BigInt(b), true);
	});
	return out;
}
function encodeKwsparse({ size, blockSize = 4096, blocks }) {
	const list = [...blocks].filter(([, d]) => {
		if (d.length !== blockSize) throw new Error(`kwsparse: block of ${d.length} bytes, expected ${blockSize}`);
		return !isZeroBlock(d);
	}).sort((a, b) => a[0] - b[0]);
	const head = kwsparseHeader(size, blockSize, list.map(([b]) => b));
	const out = new Uint8Array(head.length + list.length * blockSize);
	out.set(head);
	list.forEach(([, d], i) => out.set(d, head.length + i * blockSize));
	return out;
}
function decodeKwsparse(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (u8.length < HEADER) throw new Error("kwsparse: truncated header");
	for (let i = 0; i < 8; i++) if (u8[i] !== "KWSPARS1".charCodeAt(i)) throw new Error("not a kwsparse image (bad magic)");
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const size = Number(dv.getBigUint64(8, true));
	const blockSize = dv.getUint32(16, true);
	const n = dv.getUint32(20, true);
	if (!blockSize || blockSize & blockSize - 1 || blockSize < 512) throw new Error(`kwsparse: bad block size ${blockSize}`);
	const dataAt = HEADER + 8 * n;
	if (u8.length !== dataAt + n * blockSize) throw new Error(`kwsparse: ${u8.length} bytes, expected ${dataAt + n * blockSize} for ${n} blocks`);
	const indices = new Array(n);
	let prev = -1;
	for (let i = 0; i < n; i++) {
		const b = Number(dv.getBigUint64(HEADER + 8 * i, true));
		if (!(b > prev) || (b + 1) * blockSize > size) throw new Error(`kwsparse: bad or unsorted block index ${b}`);
		indices[i] = prev = b;
	}
	const data = u8.subarray(dataAt);
	const block = (i) => data.subarray(i * blockSize, (i + 1) * blockSize);
	return {
		size,
		blockSize,
		indices,
		data,
		block,
		map: () => new Map(indices.map((b, i) => [b, block(i)]))
	};
}
const isGzip = (u8) => u8.length >= 2 && u8[0] === 31 && u8[1] === 139;
async function gunzipIfNeeded(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (!isGzip(u8)) return u8;
	const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readKwsparse(bytes) {
	return decodeKwsparse(await gunzipIfNeeded(bytes));
}
function gzipBlob(parts) {
	return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}
const OP_READ = 0;
const OP_WRITE = 1;
const OP_FLUSH = 2;
const OP_DISCARD = 3;
const OP_WRITE_ZEROES = 4;
const F_RO = 1;
const F_FLUSH = 2;
const F_DISCARD = 4;
const F_WRITE_ZEROES = 8;
const MAX_DEVS = 16;
const REQ_STATUS = 28;
const REQ_SEGS = 32;
function scatter(views, src) {
	let o = 0;
	for (const v of views) {
		v.set(src.subarray(o, o + v.length));
		o += v.length;
	}
}
function gather(views) {
	if (views.length === 1) return views[0].slice();
	let n = 0;
	for (const v of views) n += v.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const v of views) {
		out.set(v, o);
		o += v.length;
	}
	return out;
}
var BlockHost = class {
	k;
	disks;
	done;
	inflight;
	stats;
	constructor(kernel, disks = []) {
		this.k = kernel;
		this.disks = disks.slice(0, MAX_DEVS);
		this.done = [];
		this.inflight = 0;
		this.stats = {
			reads: 0,
			writes: 0,
			flushes: 0,
			discards: 0,
			async: 0,
			bytesRead: 0,
			bytesWritten: 0
		};
	}
	imports() {
		const h = this;
		return {
			wasm_driver_block_info(dev, info) {
				const d = h.disks[dev];
				if (!d) return -19;
				const dv = h.k.dv();
				const p = Number(info);
				let flags = d.flags ?? 0;
				if (d.readOnly) flags |= 1;
				dv.setBigUint64(p, BigInt(d.size), true);
				dv.setUint32(p + 8, flags, true);
				dv.setUint32(p + 12, d.blockSize ?? 512, true);
				return 0;
			},
			wasm_driver_block_submit: (req) => h.submit(req),
			wasm_driver_block_reap: () => h.done.length ? h.done.shift() : 0n
		};
	}
	submit(reqPtr) {
		const dv = this.k.dv();
		const p = Number(reqPtr);
		const dev = dv.getUint32(p, true);
		const op = dv.getUint32(p + 4, true);
		const off = Number(dv.getBigUint64(p + 8, true)) * 512;
		const bytes = Number(dv.getBigUint64(p + 16, true));
		const nseg = dv.getUint32(p + 24, true);
		const d = this.disks[dev];
		if (!d) return -19;
		if (op !== OP_FLUSH && off + bytes > d.size) return -5;
		const views = [];
		if (op === OP_READ || op === OP_WRITE) {
			const u8 = this.k.u8();
			for (let i = 0; i < nseg; i++) {
				const a = Number(dv.getBigUint64(p + REQ_SEGS + 16 * i, true));
				const l = Number(dv.getBigUint64(p + REQ_SEGS + 16 * i + 8, true));
				views.push(u8.subarray(a, a + l));
			}
		}
		let r;
		try {
			switch (op) {
				case OP_READ:
					this.stats.reads++;
					this.stats.bytesRead += bytes;
					r = d.read(off, views);
					break;
				case OP_WRITE:
					if (d.readOnly) return -30;
					this.stats.writes++;
					this.stats.bytesWritten += bytes;
					r = d.write(off, views);
					break;
				case OP_FLUSH:
					this.stats.flushes++;
					r = d.flush?.();
					break;
				case OP_DISCARD:
					this.stats.discards++;
					if (!d.discard) return -95;
					r = d.discard(off, bytes);
					break;
				case OP_WRITE_ZEROES:
					if (!d.writeZeroes) return -95;
					r = d.writeZeroes(off, bytes);
					break;
				default: return -95;
			}
		} catch (e) {
			this.k.log(`[host] block: wd${String.fromCharCode(97 + dev)} op ${op} @${off}+${bytes}: ${e?.message ?? e}`);
			return -5;
		}
		if (!(r instanceof Promise)) return 0;
		this.stats.async++;
		this.inflight++;
		r.then(() => 0, (e) => {
			this.k.log(`[host] block: wd${String.fromCharCode(97 + dev)} op ${op} @${off}+${bytes}: ${e?.message ?? e}`);
			return -5;
		}).then((status) => {
			this.inflight--;
			this.k.dv().setInt32(p + REQ_STATUS, status, true);
			this.done.push(BigInt(p));
			this.raise();
		});
		return 1;
	}
	raise() {
		const k = this.k;
		if (k.irqAddr === void 0) return;
		k.setIrqBits(8);
		k.wake();
	}
};
var FlushTracker = class {
	flushSeq = 0;
	flushedSeq = 0;
	waiters = [];
	begin() {
		return ++this.flushSeq;
	}
	done(seq) {
		if (seq <= this.flushedSeq) return;
		this.flushedSeq = seq;
		this.waiters = this.waiters.filter((w) => w.after < seq ? (w.resolve(), false) : true);
	}
	whenFlushed(after) {
		if (this.flushedSeq > after) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push({
			after,
			resolve
		}));
	}
};
const BLOCK = 4096;
const ZERO_BLOCK = /* @__PURE__ */ new Uint8Array(0);
const ZERO = ZERO_BLOCK;
var ZeroBase = class {
	size;
	zero = true;
	identity = "";
	constructor(size) {
		this.size = size;
	}
	read(_off, len) {
		return new Uint8Array(len);
	}
};
var SparseBase = class SparseBase {
	size;
	blocks;
	identity = "";
	constructor(size, blocks) {
		this.size = size;
		this.blocks = blocks;
	}
	static fromKwsparse(img) {
		if (img.blockSize !== BLOCK) throw new Error(`kwsparse block size ${img.blockSize}, need ${BLOCK}`);
		return new SparseBase(img.size, img.map());
	}
	read(off, len) {
		const out = new Uint8Array(len);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		for (let b = b0; b <= b1; b++) {
			const blk = this.blocks.get(b);
			if (!blk || !blk.length) continue;
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			out.set(blk.subarray(s - b * BLOCK, e - b * BLOCK), s - off);
		}
		return out;
	}
	keys() {
		return [...this.blocks.keys()].sort((a, b) => a - b);
	}
};
function copyPart(out, off, blk, b, s, e) {
	if (blk === ZERO || !blk.length) out.fill(0, s - off, e - off);
	else out.set(blk.subarray(s - b * BLOCK, e - b * BLOCK), s - off);
}
var CowDisk = class CowDisk {
	base;
	size;
	flags;
	store;
	log;
	onError;
	mem = /* @__PURE__ */ new Map();
	stored = /* @__PURE__ */ new Set();
	dirty = /* @__PURE__ */ new Set();
	frozen = /* @__PURE__ */ new WeakSet();
	loading = /* @__PURE__ */ new Map();
	ahead = /* @__PURE__ */ new Map();
	aheadPending = /* @__PURE__ */ new Set();
	#raEnd = -2;
	#raSize = 0;
	busy = /* @__PURE__ */ new Map();
	saving = null;
	saveDisabled = false;
	flushes = new FlushTracker();
	stats = {
		storeReads: 0,
		storeBlocksRead: 0,
		aheadBlocks: 0,
		aheadHits: 0,
		saves: 0,
		blocksSaved: 0,
		blocksDeleted: 0,
		rmw: 0,
		saveErrors: 0
	};
	notice;
	seeded = false;
	identity;
	gen = 0;
	storedGen = 0;
	storeUid;
	storeIdentity;
	#sealed = true;
	constructor(base, { store = null, log, onError } = {}) {
		this.base = base;
		this.size = base.size;
		this.flags = 14;
		this.store = store;
		this.log = log ?? ((m) => console.warn(m));
		this.onError = onError ?? null;
	}
	async open({ onMismatch = "clear" } = {}) {
		if (!this.store) return this;
		const st = await this.store.open(this.base.identity ?? "", { onMismatch });
		if (st.mismatch !== void 0) {
			const e = /* @__PURE__ */ new Error(`saved data belongs to "${st.mismatch}", expected "${this.base.identity ?? ""}"`);
			e.name = "StoreMismatchError";
			throw e;
		}
		this.adoptStore(st, this.base.identity ?? "");
		return this;
	}
	adoptStore(st, identity) {
		this.stored = st.keys;
		this.gen = this.storedGen = st.gen ?? 0;
		this.storeUid = st.uid;
		this.storeIdentity = identity;
	}
	get persistent() {
		return !!this.store && !this.saveDisabled;
	}
	get flushSeq() {
		return this.flushes.flushSeq;
	}
	whenFlushed(after) {
		return this.flushes.whenFlushed(after);
	}
	get overlayBlocks() {
		let n = this.stored.size;
		for (const b of this.mem.keys()) if (!this.stored.has(b)) n++;
		return n;
	}
	get memBytes() {
		let n = 0;
		for (const v of this.mem.values()) n += v.length;
		return n;
	}
	read(off, views) {
		const len = views.reduce((n, v) => n + v.length, 0);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		const out = new Uint8Array(len);
		const fromStore = [], fromBase = [];
		for (let b = b0; b <= b1; b++) {
			const blk = this.mem.get(b) ?? this.#takeAhead(b);
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			if (blk) copyPart(out, off, blk, b, s, e);
			else if (this.stored.has(b)) fromStore.push(b);
			else fromBase.push(b);
		}
		const waits = [];
		if (fromStore.length) waits.push(this.#loadAhead(fromStore).then((m) => {
			for (const b of fromStore) {
				const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
				copyPart(out, off, m.get(b), b, s, e);
			}
		}));
		if (fromBase.length) {
			const lo = Math.max(off, fromBase[0] * BLOCK), hi = Math.min(off + len, (fromBase.at(-1) + 1) * BLOCK);
			const put = (buf) => {
				for (const b of fromBase) {
					const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
					out.set(buf.subarray(s - lo, e - lo), s - off);
				}
			};
			const r = this.base.read(lo, hi - lo);
			if (r instanceof Promise) waits.push(r.then(put));
			else put(r);
		}
		if (!waits.length) return scatter(views, out);
		return Promise.all(waits).then(() => scatter(views, out));
	}
	#load(blocks) {
		const want = blocks.filter((b) => !this.loading.has(b));
		if (want.length) {
			this.stats.storeReads++;
			this.stats.storeBlocksRead += want.length;
			const p = this.store.getBlocks(want);
			for (const b of want) {
				const one = p.then((m) => {
					const v = m.get(b);
					if (v === void 0) throw new Error(`block ${b} is missing from the store`);
					return v.length ? v : ZERO;
				});
				one.catch(() => {});
				this.loading.set(b, one);
				const clear = () => {
					if (this.loading.get(b) === one) this.loading.delete(b);
				};
				one.then(clear, clear);
			}
		}
		return Promise.all(blocks.map((b) => this.loading.get(b))).then((vals) => new Map(blocks.map((b, i) => [b, vals[i]])));
	}
	static RA_MIN = 8;
	static RA_MAX = 128;
	static AHEAD_MAX = 1024;
	#takeAhead(b) {
		const v = this.ahead.get(b);
		if (v === void 0) return void 0;
		this.ahead.delete(b);
		this.stats.aheadHits++;
		return v;
	}
	#dropAhead(b) {
		this.ahead.delete(b);
		this.aheadPending.delete(b);
	}
	#loadAhead(blocks) {
		const first = blocks[0], last = blocks.at(-1);
		const seq = first > this.#raEnd - this.#raSize && first <= this.#raEnd + 1;
		this.#raSize = seq ? Math.min(this.#raSize * 2, CowDisk.RA_MAX) : CowDisk.RA_MIN;
		this.#raEnd = Math.min(last + this.#raSize, Math.ceil(this.size / BLOCK) - 1);
		const extra = [];
		for (let b = last + 1; b <= this.#raEnd; b++) if (this.stored.has(b) && !this.mem.has(b) && !this.ahead.has(b) && !this.aheadPending.has(b) && !this.loading.has(b)) extra.push(b);
		if (!extra.length) return this.#load(blocks);
		for (const b of extra) this.aheadPending.add(b);
		this.stats.aheadBlocks += extra.length;
		const all = this.#load([...blocks, ...extra]);
		all.then((m) => {
			for (const b of extra) {
				if (!this.aheadPending.delete(b)) continue;
				this.ahead.set(b, m.get(b));
			}
			for (const b of this.ahead.keys()) {
				if (this.ahead.size <= CowDisk.AHEAD_MAX) break;
				this.ahead.delete(b);
			}
		}, () => {
			for (const b of extra) this.aheadPending.delete(b);
		});
		return all;
	}
	#serial(b0, b1, fn) {
		const waits = [];
		for (let b = b0; b <= b1; b++) {
			const p = this.busy.get(b);
			if (p && waits.at(-1) !== p) waits.push(p);
		}
		const r = waits.length ? Promise.all(waits).then(fn) : fn();
		if (r instanceof Promise) {
			const tail = r.then(() => {}, () => {});
			for (let b = b0; b <= b1; b++) this.busy.set(b, tail);
			tail.then(() => {
				for (let b = b0; b <= b1; b++) if (this.busy.get(b) === tail) this.busy.delete(b);
			});
		}
		return r;
	}
	#touch() {
		if (!this.#sealed) return;
		this.#sealed = false;
		this.gen++;
	}
	write(off, views) {
		this.#touch();
		const data = gather(views);
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + data.length - 1) / BLOCK);
		return this.#serial(b0, b1, () => this.#writeNow(off, data));
	}
	#writeNow(off, data) {
		const len = data.length;
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		const partial = [];
		for (let b = b0; b <= b1; b++) {
			const s = Math.max(off, b * BLOCK), e = Math.min(off + len, (b + 1) * BLOCK);
			if (e - s === BLOCK || this.mem.has(b)) this.#put(b, data.subarray(s - off, e - off), s - b * BLOCK);
			else partial.push([
				b,
				s,
				e
			]);
		}
		if (!partial.length) return;
		this.stats.rmw += partial.length;
		const pending = [];
		for (const [b, s, e] of partial) {
			const apply = (cur) => {
				if (!this.mem.has(b)) this.mem.set(b, cur);
				this.#put(b, data.subarray(s - off, e - off), s - b * BLOCK);
			};
			const r = this.#current(b);
			if (r instanceof Promise) pending.push(r.then(apply));
			else apply(r);
		}
		if (pending.length) return Promise.all(pending);
	}
	#current(b) {
		const fresh = (src) => {
			const blk = new Uint8Array(BLOCK);
			if (src !== ZERO) blk.set(src);
			return blk;
		};
		const ahead = this.#takeAhead(b);
		if (ahead) return fresh(ahead);
		if (this.stored.has(b)) return this.#load([b]).then((m) => fresh(m.get(b)));
		const r = this.base.read(b * BLOCK, Math.min(BLOCK, this.size - b * BLOCK));
		return r instanceof Promise ? r.then(fresh) : fresh(r);
	}
	#put(b, src, at) {
		let blk = this.mem.get(b);
		if (src.length === BLOCK) {
			if (!blk || blk === ZERO || this.frozen.has(blk)) blk = new Uint8Array(BLOCK);
		} else if (blk === void 0) throw new Error("internal: partial put of a block not in memory");
		else if (blk === ZERO) blk = new Uint8Array(BLOCK);
		else if (this.frozen.has(blk)) blk = blk.slice();
		blk.set(src, at);
		this.mem.set(b, blk);
		this.dirty.add(b);
		this.loading.delete(b);
		this.#dropAhead(b);
	}
	#zero(b) {
		this.#dropAhead(b);
		const cur = this.mem.get(b);
		if (this.base.zero && !this.stored.has(b) && !(cur && this.frozen.has(cur))) {
			this.mem.delete(b);
			this.dirty.delete(b);
			return;
		}
		this.mem.set(b, ZERO);
		this.dirty.add(b);
		this.loading.delete(b);
	}
	discard(off, len) {
		return this.writeZeroes(off, len);
	}
	writeZeroes(off, len) {
		this.#touch();
		const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + len - 1) / BLOCK);
		return this.#serial(b0, b1, () => {
			const f0 = Math.ceil(off / BLOCK), f1 = Math.floor((off + len) / BLOCK);
			if (f0 >= f1) return this.#writeNow(off, new Uint8Array(len));
			for (let b = f0; b < f1; b++) this.#zero(b);
			const ps = [];
			if (off < f0 * BLOCK) ps.push(this.#writeNow(off, new Uint8Array(f0 * BLOCK - off)));
			if (off + len > f1 * BLOCK) ps.push(this.#writeNow(f1 * BLOCK, new Uint8Array(off + len - f1 * BLOCK)));
			const p = ps.filter((x) => x instanceof Promise);
			if (p.length) return Promise.all(p);
		});
	}
	flush() {
		const seq = this.flushes.begin();
		if (!this.store || this.saveDisabled || !this.saving && !this.#pending()) {
			this.flushes.done(seq);
			return;
		}
		return this.#chain(() => this.#commit(this.#take())).then(() => this.flushes.done(seq));
	}
	#pending() {
		return this.dirty.size > 0 || this.gen !== this.storedGen;
	}
	#chain(fn) {
		const p = (this.saving ?? Promise.resolve()).catch(() => {}).then(fn);
		this.saving = p;
		const clear = () => {
			if (this.saving === p) this.saving = null;
		};
		p.then(clear, clear);
		return p;
	}
	#take() {
		const entries = [];
		for (const b of this.dirty) {
			const v = this.mem.get(b);
			entries.push([b, v]);
			if (v !== ZERO) this.frozen.add(v);
		}
		this.dirty.clear();
		return {
			entries,
			gen: this.gen
		};
	}
	async #commit({ entries, gen }) {
		if (!this.store || this.saveDisabled || !entries.length && gen === this.storedGen) return;
		const puts = [], dels = [];
		for (const [b, v] of entries) if (v === ZERO && this.base.zero) dels.push(b);
		else puts.push([b, v]);
		try {
			await this.store.save(puts, dels, gen !== this.storedGen ? { gen } : void 0);
		} catch (e) {
			this.stats.saveErrors++;
			for (const [b, v] of entries) {
				if (this.mem.get(b) === v) this.dirty.add(b);
				if (v !== ZERO) this.frozen.delete(v);
			}
			const err = e;
			this.log(`[host] block: saving ${entries.length} blocks failed: ${err?.name ?? ""} ${err?.message ?? e}`);
			try {
				this.onError?.(e);
			} catch {}
			throw e;
		}
		if (gen > this.storedGen) this.storedGen = gen;
		this.stats.saves++;
		this.stats.blocksSaved += puts.length;
		this.stats.blocksDeleted += dels.length;
		for (const [b, v] of entries) {
			if (v === ZERO && this.base.zero) this.stored.delete(b);
			else this.stored.add(b);
			if (v !== ZERO) this.frozen.delete(v);
			this.loading.delete(b);
			if (!this.dirty.has(b) && this.mem.get(b) === v) this.mem.delete(b);
		}
	}
	snapshotState() {
		if (this.persistent) {
			const name = this.store.name ?? "store";
			return {
				name,
				identity: `store ${name} ${this.storeIdentity ?? ""} uid=${this.storeUid ?? "-"}`,
				gen: this.gen
			};
		}
		const name = this.base.identity || "an in-memory disk";
		if (this.gen || this.mem.size) throw new Error(`${name} keeps its writes in memory only, and a snapshot does not save them`);
		if (!this.base.identity) throw new Error("its base image has no identity to check on restore");
		return {
			name,
			identity: `base ${this.base.identity}`,
			gen: 0
		};
	}
	snapshotSeal() {
		const state = this.snapshotState();
		if (!this.persistent) return {
			state,
			done: Promise.resolve()
		};
		if (this.saving) throw new Error(`${state.name}: a save is in flight`);
		const taken = this.#take();
		this.#sealed = true;
		return {
			state,
			done: this.#chain(() => this.#commit(taken))
		};
	}
	detach() {
		this.saveDisabled = true;
	}
	async reset() {
		this.mem.clear();
		this.dirty.clear();
		this.stored.clear();
		this.ahead.clear();
		this.aheadPending.clear();
		if (this.store) await this.store.clear();
	}
	async exportParts({ batch = 256 } = {}) {
		if (!this.base.zero && !this.base.keys) throw new Error("export needs a zero or sparse base");
		const sorted = [.../* @__PURE__ */ new Set([
			...this.base.keys?.() ?? [],
			...this.stored,
			...this.mem.keys()
		])].sort((a, b) => a - b);
		const indices = [], parts = [];
		for (let i = 0; i < sorted.length; i += batch) {
			const part = sorted.slice(i, i + batch);
			const vals = /* @__PURE__ */ new Map();
			const fromStore = [];
			for (const b of part) {
				const m = this.mem.get(b);
				if (m) vals.set(b, m === ZERO ? m : m.slice());
				else if (this.stored.has(b)) fromStore.push(b);
				else vals.set(b, this.base.read(b * BLOCK, BLOCK));
			}
			if (fromStore.length) for (const [b, v] of await this.#load(fromStore)) vals.set(b, v);
			const list = [];
			for (const b of part) {
				const v = vals.get(b);
				if (!v || v === ZERO || !v.length || isZeroBlock(v)) continue;
				indices.push(b);
				list.push(v);
			}
			if (list.length) parts.push(new Blob(list));
		}
		const head = kwsparseHeader(this.size, BLOCK, indices);
		return {
			size: this.size,
			blocks: indices.length,
			parts: [head, ...parts]
		};
	}
};
var HttpBase = class HttpBase {
	url = "";
	size = 0;
	identity = "";
	chunkSize = 0;
	maxChunks = 0;
	chunks = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Map();
	stats = {
		requests: 0,
		bytes: 0
	};
	static async open(url, { chunkSize = 262144, maxRequest = 4194304 } = {}) {
		const r = await fetch(url, {
			headers: { range: "bytes=0-0" },
			cache: "no-store"
		});
		if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
		const cr = r.headers.get("content-range");
		await r.arrayBuffer();
		const m = cr && /\/(\d+)\s*$/.exec(cr);
		if (r.status !== 206 || !m) throw new Error(`${url}: server does not support Range requests`);
		const b = new HttpBase();
		b.url = url;
		b.size = Number(m[1]);
		b.identity = `${url} ${b.size} ${r.headers.get("etag") ?? r.headers.get("last-modified") ?? ""}`;
		b.chunkSize = chunkSize;
		b.maxChunks = Math.max(1, Math.floor(maxRequest / chunkSize));
		return b;
	}
	read(off, len) {
		const cs = this.chunkSize;
		const c0 = Math.floor(off / cs), c1 = Math.floor((off + len - 1) / cs);
		const waits = [];
		let runStart = -1;
		const flushRun = (end) => {
			if (runStart >= 0) waits.push(this.#fetchRun(runStart, end));
			runStart = -1;
		};
		for (let c = c0; c <= c1; c++) {
			if (this.chunks.has(c)) {
				flushRun(c);
				continue;
			}
			const p = this.pending.get(c);
			if (p) {
				flushRun(c);
				waits.push(p);
				continue;
			}
			if (runStart < 0) runStart = c;
			if (c - runStart + 1 >= this.maxChunks) flushRun(c + 1);
		}
		flushRun(c1 + 1);
		const assemble = () => {
			if (c0 === c1) {
				const s = off - c0 * cs;
				return this.chunks.get(c0).subarray(s, s + len);
			}
			const out = new Uint8Array(len);
			for (let c = c0; c <= c1; c++) {
				const s = Math.max(off, c * cs), e = Math.min(off + len, (c + 1) * cs);
				out.set(this.chunks.get(c).subarray(s - c * cs, e - c * cs), s - off);
			}
			return out;
		};
		if (!waits.length) return assemble();
		return Promise.all(waits).then(assemble);
	}
	#fetchRun(c0, c1) {
		const cs = this.chunkSize;
		const start = c0 * cs, end = Math.min(this.size, c1 * cs);
		const p = (async () => {
			this.stats.requests++;
			const r = await fetch(this.url, { headers: { range: `bytes=${start}-${end - 1}` } });
			if (r.status !== 206) throw new Error(`${this.url}: range ${start}-${end - 1}: HTTP ${r.status}`);
			const buf = new Uint8Array(await r.arrayBuffer());
			if (buf.length !== end - start) throw new Error(`${this.url}: short range read`);
			this.stats.bytes += buf.length;
			for (let c = c0; c < c1; c++) {
				const s = (c - c0) * cs;
				let chunk = buf.subarray(s, Math.min(buf.length, s + cs));
				if (chunk.length < cs) {
					const full = new Uint8Array(cs);
					full.set(chunk);
					chunk = full;
				}
				this.chunks.set(c, chunk);
			}
		})();
		for (let c = c0; c < c1; c++) this.pending.set(c, p);
		const clear = () => {
			for (let c = c0; c < c1; c++) this.pending.delete(c);
		};
		p.then(clear, clear);
		return p;
	}
};
const HEAD = 0;
const TAIL = 1;
const WAITING = 2;
const SPACE = 3;
const CLOSED = 4;
const LOCK = 5;
const BATCH = 6;
const BATCHES = 7;
const DROPPED = 8;
const TAKEN = 9;
const CTL_BYTES$1 = 64;
const MAX_BATCHES = 16;
const STALL_MS = 50;
const LAZY_MS = 2;
function newConsoleRing() {
	return new SharedArrayBuffer(262208);
}
var ConsoleRing = class {
	buffer;
	ctl;
	#words;
	#data;
	#cap;
	#maxRecord;
	#lazyBytes;
	#stalledAt = -1;
	constructor(buffer) {
		this.buffer = buffer;
		this.#cap = buffer.byteLength - CTL_BYTES$1;
		if (this.#cap <= 0 || this.#cap & this.#cap - 1) throw new Error(`console ring: bad size ${buffer.byteLength}`);
		this.ctl = new Int32Array(buffer, 0, CTL_BYTES$1 / 4);
		this.#words = new Int32Array(buffer, CTL_BYTES$1, this.#cap / 4);
		this.#data = new Uint8Array(buffer, CTL_BYTES$1, this.#cap);
		this.#maxRecord = this.#cap >> 2;
		this.#lazyBytes = this.#cap >> 3;
	}
	get closed() {
		return Atomics.load(this.ctl, CLOSED) !== 0;
	}
	get dropped() {
		return Atomics.load(this.ctl, DROPPED);
	}
	get used() {
		return this.ctl[HEAD] - this.ctl[TAIL] | 0;
	}
	get quiet() {
		const c = this.ctl;
		return Atomics.load(c, HEAD) === Atomics.load(c, TAIL) && Atomics.load(c, BATCHES) === 0;
	}
	get pending() {
		return this.ctl[HEAD] !== this.ctl[TAIL];
	}
	tryWrite(src, p, len) {
		const c = this.ctl, cap = this.#cap;
		const need = 4 + (len + 3 & -4);
		let head = Atomics.load(c, HEAD);
		let used;
		for (;;) {
			used = (head - Atomics.load(c, TAIL) | 0) + need;
			if (used > cap) return false;
			const was = Atomics.compareExchange(c, HEAD, head, head + need | 0);
			if (was === head) break;
			head = was;
		}
		const mask = cap - 1;
		const at = head + 4 & mask;
		const first = Math.min(len, cap - at);
		this.#data.set(src.subarray(p, p + first), at);
		if (len > first) this.#data.set(src.subarray(p + first, p + len), 0);
		Atomics.store(this.#words, (head & mask) >> 2, len);
		const w = Atomics.load(c, WAITING);
		if (w !== 0 && (w === 1 || used >= this.#lazyBytes)) this.kick(w);
		return true;
	}
	committedAtTail() {
		const c = this.ctl;
		const tail = Atomics.load(c, TAIL);
		return tail !== Atomics.load(c, HEAD) && Atomics.load(this.#words, (tail & this.#cap - 1) >> 2) !== 0;
	}
	kick(w = Atomics.load(this.ctl, WAITING)) {
		if (w !== 0 && Atomics.compareExchange(this.ctl, WAITING, w, 0) === w) Atomics.notify(this.ctl, WAITING);
	}
	write(src, p, len, full, sink) {
		for (let off = 0; off < len;) {
			const n = Math.min(len - off, this.#maxRecord);
			if (!this.tryWrite(src, p + off, n) && !(full === "wait" ? this.#waitWrite(src, p + off, n) : this.#takeWrite(src, p + off, n, sink, full === "post"))) {
				Atomics.add(this.ctl, DROPPED, len - off);
				return len - off;
			}
			off += n;
		}
		return 0;
	}
	#waitWrite(src, p, len) {
		const c = this.ctl;
		Atomics.add(c, SPACE, 1);
		try {
			for (;;) {
				if (Atomics.load(c, CLOSED)) return false;
				const tail = Atomics.load(c, TAIL);
				if (this.tryWrite(src, p, len)) return true;
				this.kick();
				Atomics.wait(c, TAIL, tail, 100);
			}
		} finally {
			Atomics.sub(c, SPACE, 1);
		}
	}
	#takeWrite(src, p, len, sink, post) {
		const c = this.ctl;
		for (let idle = 0;;) {
			if (Atomics.load(c, CLOSED)) return false;
			if (this.tryWrite(src, p, len)) return true;
			if (post && Atomics.load(c, BATCHES) >= MAX_BATCHES) {
				const taken = Atomics.load(c, TAKEN);
				if (taken === this.#stalledAt) return false;
				const deadline = performance.now() + STALL_MS;
				let left = STALL_MS;
				while (Atomics.load(c, TAKEN) === taken && left > 0 && !Atomics.load(c, CLOSED)) {
					Atomics.wait(c, TAKEN, taken, left);
					left = deadline - performance.now();
				}
				if (Atomics.load(c, TAKEN) === taken) {
					this.#stalledAt = taken;
					return false;
				}
				continue;
			}
			const b = this.take(true);
			if (b) {
				if (post) Atomics.add(c, BATCHES, 1);
				sink(b);
				idle = 0;
				continue;
			}
			if (++idle > 200) return false;
			Atomics.wait(c, CLOSED, 0, .1);
		}
	}
	batchTaken() {
		Atomics.sub(this.ctl, BATCHES, 1);
		Atomics.add(this.ctl, TAKEN, 1);
		Atomics.notify(this.ctl, TAKEN);
	}
	take(spin = false) {
		const c = this.ctl;
		for (let i = 0; Atomics.compareExchange(c, LOCK, 0, 1) !== 0; i++) {
			if (!spin || i > 100) return null;
			Atomics.wait(c, LOCK, 1, 1);
		}
		try {
			const cap = this.#cap, mask = cap - 1, words = this.#words, data = this.#data;
			const tail0 = Atomics.load(c, TAIL), head = Atomics.load(c, HEAD);
			let tail = tail0, total = 0;
			while (tail !== head) {
				const len = Atomics.load(words, (tail & mask) >> 2);
				if (!len) break;
				total += len;
				tail = tail + 4 + (len + 3 & -4) | 0;
			}
			if (tail === tail0) return null;
			const out = new Uint8Array(total);
			for (let t = tail0, o = 0; t !== tail;) {
				const len = words[(t & mask) >> 2];
				const at = t + 4 & mask;
				const first = Math.min(len, cap - at);
				out.set(data.subarray(at, at + first), o);
				if (len > first) out.set(data.subarray(0, len - first), o + first);
				o += len;
				t = t + 4 + (len + 3 & -4) | 0;
			}
			const a = tail0 & mask, n = tail - tail0 | 0;
			if (a + n <= cap) data.fill(0, a, a + n);
			else {
				data.fill(0, a);
				data.fill(0, 0, a + n - cap);
			}
			const seq = Atomics.add(c, BATCH, 1);
			Atomics.store(c, TAIL, tail);
			if (Atomics.load(c, SPACE) > 0) Atomics.notify(c, TAIL);
			return {
				seq,
				bytes: out
			};
		} finally {
			Atomics.store(c, LOCK, 0);
			Atomics.notify(c, LOCK);
		}
	}
	close() {
		Atomics.store(this.ctl, CLOSED, 1);
		Atomics.notify(this.ctl, TAIL);
		Atomics.notify(this.ctl, TAKEN);
		this.kick();
	}
};
var ConsoleRingReader = class {
	ring;
	#deliver;
	#stopped = false;
	#armed = false;
	#timer;
	constructor(ring, deliver) {
		this.ring = ring;
		this.#deliver = deliver;
	}
	take() {
		const b = this.ring.take();
		if (!b) return false;
		this.#deliver(b);
		return true;
	}
	start() {
		this.#loop();
	}
	stop() {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.ring.kick();
	}
	#loop() {
		if (this.#stopped || this.#armed) return;
		const mode = this.take() ? 2 : 1;
		const c = this.ring.ctl;
		Atomics.store(c, WAITING, mode);
		if (mode === 1 && this.ring.committedAtTail()) {
			Atomics.store(c, WAITING, 0);
			queueMicrotask(() => this.#loop());
			return;
		}
		const again = () => {
			this.#armed = false;
			Atomics.compareExchange(c, WAITING, mode, 0);
			this.#loop();
		};
		this.#armed = true;
		const wait = Atomics.waitAsync;
		if (typeof wait === "function") {
			const r = wait(c, WAITING, mode, mode === 2 ? LAZY_MS : 6e4);
			if (r.async) r.value.then(again);
			else queueMicrotask(again);
		} else this.#timer = setTimeout(again, mode === 2 ? LAZY_MS : 4);
	}
};
const MIRROR_KEYS = [
	"compiled",
	"live",
	"maxLive",
	"freed",
	"failed",
	"compileMs",
	"bytes",
	"collected",
	"retained",
	"maxRetained",
	"gcNudges",
	"refused",
	"maxCompileMs"
];
const JIT_MIRROR_WORDS = 2 + MIRROR_KEYS.length + 1;
function jitStatsFromMirror(m) {
	const st = {
		enabled: m[0] === 1,
		requested: m[1] === 1
	};
	MIRROR_KEYS.forEach((k, i) => st[k] = m[2 + i] ?? 0);
	return st;
}
function jitBufFromMirror(m) {
	return m[JIT_MIRROR_WORDS - 1] || void 0;
}
function sumJitStats(first, rest) {
	const st = { ...first };
	for (const o of rest) {
		st.enabled ||= o.enabled;
		st.requested ||= o.requested;
		for (const k of MIRROR_KEYS) st[k] = k === "maxCompileMs" ? Math.max(st[k], o[k]) : st[k] < 0 || o[k] < 0 ? -1 : st[k] + o[k];
	}
	return st;
}
const CAP_AVAILABLE = 1;
const CAP_MEM32 = 2;
const CAP_SHARED = 8;
const WARM = 1;
const MAX_MODULE = 1 << 20;
const MAX_LOGGED = 5;
const KWEMU_STATS_WORDS = 501;
const KW_CPU_ICOUNT = 32;
const RETAINED_NUDGE = 256;
const RETAINED_LIMIT = 2048;
const NUDGE_BYTES = 64 << 20;
const NUDGE_MAX = 2 ** 32;
const NUDGE_PATIENCE_MS = 250;
var JitHost = class {
	stats;
	#opts;
	#table;
	#big = false;
	#saved = /* @__PURE__ */ new Map();
	#logged = 0;
	#fin;
	#nudgeAt;
	#limit;
	#nudgeBytes = NUDGE_BYTES;
	#nudgeCheckAt = 0;
	#nudgeCheckCollected = 0;
	#debugStats;
	#cpuOfBuf;
	#buf;
	constructor(opts) {
		this.#opts = opts;
		const enabled = opts.enabled !== false && typeof WebAssembly === "object" && typeof WebAssembly.Module === "function" && typeof WebAssembly.Instance === "function";
		const tracked = typeof FinalizationRegistry === "function";
		this.stats = {
			enabled,
			requested: false,
			compiled: 0,
			live: 0,
			maxLive: 0,
			freed: 0,
			failed: 0,
			compileMs: 0,
			maxCompileMs: 0,
			bytes: 0,
			collected: tracked ? 0 : -1,
			retained: tracked ? 0 : -1,
			maxRetained: tracked ? 0 : -1,
			gcNudges: 0,
			refused: 0
		};
		if (tracked) this.#fin = new FinalizationRegistry(() => this.#collected());
		this.#nudgeAt = opts.retainedNudge ?? RETAINED_NUDGE;
		this.#limit = opts.retainedLimit ?? RETAINED_LIMIT;
		this.#publish();
	}
	#publish() {
		const m = this.#opts.mirror;
		if (!m) return;
		const st = this.stats;
		m[0] = st.enabled ? 1 : 0;
		m[1] = st.requested ? 1 : 0;
		MIRROR_KEYS.forEach((k, i) => m[2 + i] = st[k]);
		m[JIT_MIRROR_WORDS - 1] = this.#buf ?? 0;
	}
	attach(exports) {
		const t = exports.__indirect_function_table;
		this.#table = t instanceof WebAssembly.Table ? t : void 0;
		this.#big = typeof this.#table?.length === "bigint";
		const ds = exports.kw_debug_stats, cb = exports.kw_debug_cpu_of_jit_buf;
		this.#debugStats = typeof ds === "function" ? ds : void 0;
		this.#cpuOfBuf = typeof cb === "function" ? cb : void 0;
		this.#buf = void 0;
	}
	kwemuStats(of = this.#buf) {
		if (!this.#debugStats || !this.#cpuOfBuf || this.#buf === void 0 || of === void 0) return void 0;
		const cpu = this.#cpuOfBuf(BigInt(of));
		this.#debugStats(cpu, BigInt(this.#buf));
		const v = new DataView(this.#opts.memory().buffer);
		const words = [];
		for (let i = 0; i < KWEMU_STATS_WORDS; i++) words.push(Number(v.getBigUint64(this.#buf + 8 * i, true)));
		return {
			icount: Number(v.getBigUint64(Number(cpu) + KW_CPU_ICOUNT, true)),
			words
		};
	}
	imports() {
		return {
			kw_host_jit_caps: () => this.caps(),
			kw_host_jit_compile: (ptr, len, slot, flags) => this.compile(ptr, len, slot, flags ?? 0),
			kw_host_jit_free: (slot) => this.free(slot)
		};
	}
	caps() {
		this.stats.requested = true;
		this.#publish();
		if (!this.stats.enabled) return 0;
		if (!this.#table) {
			this.#warn("the kernel exports no __indirect_function_table; JIT off");
			return 0;
		}
		const shared = typeof SharedArrayBuffer !== "undefined" && this.#opts.memory().buffer instanceof SharedArrayBuffer;
		return CAP_AVAILABLE | (this.#opts.memory64() ? 0 : CAP_MEM32) | (shared ? CAP_SHARED : 0);
	}
	compile(ptr, len, slot, flags = 0) {
		const st = this.stats;
		if (st.retained >= this.#nudgeAt) this.#nudge();
		if (st.retained >= this.#limit) {
			if (st.refused++ === 0) this.#opts.log?.(`[jit] ${st.retained} freed modules not collected by the engine yet; refusing compiles until it catches up`);
			this.#publish();
			return -1;
		}
		const t0 = performance.now();
		try {
			const table = this.#table;
			if (!st.enabled || !table) throw new Error("JIT not enabled");
			if (!this.#validSlot(slot)) throw new Error(`bad slot ${slot}`);
			const p = Number(ptr), n = Number(len);
			this.#buf ??= p;
			const mem = this.#opts.memory();
			if (!(n > 0 && n <= MAX_MODULE && p >= 0 && p + n <= mem.buffer.byteLength)) throw new Error(`bad module range ${p}+${n}`);
			const view = new Uint8Array(mem.buffer, p, n);
			const module = new WebAssembly.Module(mem.buffer instanceof ArrayBuffer ? view : view.slice());
			const f = new WebAssembly.Instance(module, { env: { memory: mem } }).exports.f;
			if (typeof f !== "function") throw new Error("the module exports no function f");
			if (flags & WARM) f(0n, 0n, 0n, 0n);
			const idx = this.#big ? BigInt(slot) : slot;
			const prev = table.get(idx);
			table.set(idx, f);
			this.#fin?.register(module, 0);
			if (this.#saved.has(slot)) this.#freed();
			else this.#saved.set(slot, prev);
			st.compiled++;
			st.bytes += n;
			return 0;
		} catch (e) {
			st.failed++;
			this.#warn(`compile into slot ${slot} failed: ${e?.message ?? e}`);
			return -1;
		} finally {
			const ms = performance.now() - t0;
			st.compileMs += ms;
			if (ms > st.maxCompileMs) st.maxCompileMs = ms;
			st.live = this.#saved.size;
			if (st.live > st.maxLive) st.maxLive = st.live;
			this.#publish();
		}
	}
	free(slot) {
		try {
			const orig = this.#saved.get(slot);
			if (!this.#saved.has(slot) || !this.#table) throw new Error(`free of slot ${slot}, which holds no compiled block`);
			this.#table.set(this.#big ? BigInt(slot) : slot, orig);
			this.#saved.delete(slot);
			this.#freed();
		} catch (e) {
			this.stats.failed++;
			this.#warn(e?.message ?? String(e));
		} finally {
			this.stats.live = this.#saved.size;
			this.#publish();
		}
	}
	#freed() {
		const st = this.stats;
		st.freed++;
		if (!this.#fin) return;
		st.retained = st.freed - st.collected;
		if (st.retained > st.maxRetained) st.maxRetained = st.retained;
	}
	#collected() {
		const st = this.stats;
		st.collected++;
		st.retained = Math.max(0, st.freed - st.collected);
		this.#publish();
	}
	#nudge() {
		const now = performance.now();
		if (this.stats.collected !== this.#nudgeCheckCollected) {
			this.#nudgeCheckCollected = this.stats.collected;
			this.#nudgeCheckAt = now;
		} else if (now - this.#nudgeCheckAt >= NUDGE_PATIENCE_MS) {
			if (this.#nudgeCheckAt > 0 && this.#nudgeBytes < NUDGE_MAX) this.#nudgeBytes *= 2;
			this.#nudgeCheckAt = now;
		}
		try {
			new ArrayBuffer(this.#nudgeBytes).transfer?.(0);
			this.stats.gcNudges++;
		} catch {
			if (this.#nudgeBytes > 1 << 20) this.#nudgeBytes >>= 1;
		}
	}
	#validSlot(slot) {
		const table = this.#table;
		if (!Number.isInteger(slot) || slot <= 0 || slot >= Number(table.length)) return false;
		return this.#saved.has(slot) || typeof table.get(this.#big ? BigInt(slot) : slot) === "function";
	}
	#warn(msg) {
		if (this.#logged >= MAX_LOGGED) return;
		this.#logged++;
		this.#opts.log?.(`[jit] ${msg}${this.#logged === MAX_LOGGED ? " (further JIT messages suppressed)" : ""}`);
	}
};
const ERRNO = {
	SUCCESS: 0,
	AGAIN: 6,
	BADF: 8,
	INVAL: 28,
	NOENT: 44,
	NOTDIR: 54,
	NOTSUP: 58,
	ROFS: 69
};
const CLOCK_REALTIME = 0;
const CLOCK_THREAD_CPUTIME = 3;
const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTTYPE_FD_WRITE = 2;
const SUBCLOCK_ABSTIME = 1;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const OFLAGS_DIRECTORY = 2;
const encoder$1 = new TextEncoder();
const decoder$1 = new TextDecoder();
function never() {
	return new Promise(() => {});
}
function realtimeNs() {
	return BigInt(Date.now()) * 1000000n;
}
function yieldToEventLoop() {
	if (typeof setImmediate === "function") return new Promise((r) => setImmediate(r));
	return new Promise((r) => {
		const ch = new MessageChannel();
		ch.port1.onmessage = () => {
			ch.port1.close();
			r();
		};
		ch.port2.postMessage(0);
	});
}
var WasiHost = class {
	k;
	args;
	stderr;
	fds;
	buf;
	dvCache;
	u8Cache;
	monoOffset = 0;
	constructor(k, { args, files = {} }) {
		this.k = k;
		this.args = args.map((a) => encoder$1.encode(`${a}\0`));
		this.stderr = "";
		this.fds = /* @__PURE__ */ new Map([
			[0, { type: "stdin" }],
			[1, { type: "stdout" }],
			[2, { type: "stderr" }],
			[3, {
				type: "dir",
				name: encoder$1.encode("/"),
				files: new Map(Object.entries(files))
			}]
		]);
		this.buf = null;
		this.dvCache = null;
		this.u8Cache = null;
	}
	monotonicMs() {
		return performance.now() + this.monoOffset;
	}
	clockNs(id) {
		return id === CLOCK_REALTIME ? realtimeNs() : BigInt(Math.round(this.monotonicMs() * 1e6));
	}
	views() {
		if (!this.buf || this.buf.byteLength === 0) {
			this.buf = this.k.memory.buffer;
			this.dvCache = new DataView(this.buf);
			this.u8Cache = new Uint8Array(this.buf);
		}
	}
	dv() {
		this.views();
		return this.dvCache;
	}
	u8() {
		this.views();
		return this.u8Cache;
	}
	iovecs(iovs, n) {
		const dv = this.dv();
		const out = [];
		for (let i = 0; i < n; i++) out.push([dv.getUint32(iovs + 8 * i, true), dv.getUint32(iovs + 8 * i + 4, true)]);
		return out;
	}
	stdinQueued() {
		const k = this.k;
		let n = -k.inputOffset;
		for (const c of k.input) n += c.length;
		return n;
	}
	readStdin(dst, want) {
		const k = this.k;
		const u8 = this.u8();
		let n = 0;
		while (n < want && k.input.length) {
			const head = k.input[0];
			const take = Math.min(want - n, head.length - k.inputOffset);
			u8.set(head.subarray(k.inputOffset, k.inputOffset + take), dst + n);
			n += take;
			k.inputOffset += take;
			if (k.inputOffset >= head.length) {
				k.input.shift();
				k.inputOffset = 0;
			}
		}
		return n;
	}
	subscriptions(inp, n) {
		const dv = this.dv();
		const subs = [];
		for (let i = 0; i < n; i++) {
			const b = inp + 48 * i;
			const sub = {
				userdata: dv.getBigUint64(b, true),
				tag: dv.getUint8(b + 8)
			};
			if (sub.tag === EVENTTYPE_CLOCK) {
				sub.clock = dv.getUint32(b + 16, true);
				const timeout = dv.getBigUint64(b + 24, true);
				sub.deadline = dv.getUint16(b + 40, true) & SUBCLOCK_ABSTIME ? timeout : this.clockNs(sub.clock) + timeout;
			} else sub.fd = dv.getUint32(b + 16, true);
			subs.push(sub);
		}
		return subs;
	}
	ready(subs) {
		const events = [];
		for (const s of subs) {
			const ev = {
				userdata: s.userdata,
				type: s.tag,
				error: 0,
				nbytes: 0n
			};
			if (s.tag === EVENTTYPE_CLOCK) {
				if (this.clockNs(s.clock) >= s.deadline) events.push(ev);
				continue;
			}
			const f = this.fds.get(s.fd);
			if (!f || f.type === "dir") ev.error = ERRNO.BADF;
			else if (s.tag === EVENTTYPE_FD_READ) {
				if (f.type === "stdin") {
					const q = this.stdinQueued();
					if (!q) continue;
					ev.nbytes = BigInt(q);
				} else if (f.type === "file") ev.nbytes = BigInt(f.data.length - f.pos);
				else ev.error = ERRNO.BADF;
			} else if (s.tag !== EVENTTYPE_FD_WRITE || f.type === "stdin") ev.error = ERRNO.BADF;
			events.push(ev);
		}
		return events;
	}
	writeEvents(out, nevents, events) {
		const dv = this.dv();
		events.forEach((ev, i) => {
			const b = out + 32 * i;
			for (let j = 0; j < 32; j += 8) dv.setBigUint64(b + j, 0n, true);
			dv.setBigUint64(b, ev.userdata, true);
			dv.setUint16(b + 8, ev.error, true);
			dv.setUint8(b + 10, ev.type);
			dv.setBigUint64(b + 16, ev.nbytes, true);
		});
		dv.setUint32(nevents, events.length, true);
	}
	exit(code) {
		const k = this.k;
		if (code === 253) {
			const msg = this.stderr.trim();
			k.log(`[host] kernel panic: ${msg}`);
			k.exit({
				code,
				reason: `panic: ${msg}`,
				kind: "panic"
			});
		} else k.exit({
			code,
			reason: "halt",
			kind: "halt"
		});
	}
	imports() {
		const w = this;
		const k = this.k;
		return {
			args_sizes_get(argc, size) {
				const dv = w.dv();
				dv.setUint32(argc, w.args.length, true);
				dv.setUint32(size, w.args.reduce((n, a) => n + a.length, 0), true);
				return ERRNO.SUCCESS;
			},
			args_get(argv, buf) {
				const dv = w.dv();
				const u8 = w.u8();
				w.args.forEach((a, i) => {
					dv.setUint32(argv + 4 * i, buf, true);
					u8.set(a, buf);
					buf += a.length;
				});
				return ERRNO.SUCCESS;
			},
			clock_time_get(id, _precision, time) {
				const dv = w.dv();
				if (id === CLOCK_REALTIME) {
					dv.setBigUint64(time, realtimeNs(), true);
					return ERRNO.SUCCESS;
				}
				if (id > CLOCK_THREAD_CPUTIME) return ERRNO.INVAL;
				const p = k.poller;
				if (p !== null) p.poll();
				const ns = Math.round((performance.now() + w.monoOffset) * 1e6);
				dv.setUint32(time, ns >>> 0, true);
				dv.setUint32(time + 4, Math.floor(ns / 4294967296), true);
				return ERRNO.SUCCESS;
			},
			random_get(buf, len) {
				const u8 = w.u8();
				for (let off = 0; off < len; off += 65536) {
					const n = Math.min(len - off, 65536);
					u8.set(crypto.getRandomValues(new Uint8Array(n)), buf + off);
				}
				return ERRNO.SUCCESS;
			},
			fd_write(fd, iovs, n, nwritten) {
				const f = w.fds.get(fd);
				if (!f || f.type !== "stdout" && f.type !== "stderr") return ERRNO.BADF;
				const u8 = w.u8();
				let total = 0;
				for (const [p, len] of w.iovecs(iovs, n)) {
					if (!len) continue;
					if (f.type === "stdout") k.consoleWrite(u8, p, len);
					else w.stderr = (w.stderr + decoder$1.decode(u8.slice(p, p + len))).slice(-4096);
					total += len;
				}
				w.dv().setUint32(nwritten, total, true);
				return ERRNO.SUCCESS;
			},
			fd_read(fd, iovs, n, nread) {
				const f = w.fds.get(fd);
				if (!f) return ERRNO.BADF;
				let total = 0;
				if (f.type === "stdin") {
					for (const [p, len] of w.iovecs(iovs, n)) {
						const got = w.readStdin(p, len);
						total += got;
						if (got < len) break;
					}
					if (!total && n) return ERRNO.AGAIN;
				} else if (f.type === "file") {
					const u8 = w.u8();
					for (const [p, len] of w.iovecs(iovs, n)) {
						const take = Math.min(len, f.data.length - f.pos);
						u8.set(f.data.subarray(f.pos, f.pos + take), p);
						f.pos += take;
						total += take;
						if (take < len) break;
					}
				} else return ERRNO.BADF;
				w.dv().setUint32(nread, total, true);
				return ERRNO.SUCCESS;
			},
			fd_close(fd) {
				const f = w.fds.get(fd);
				if (!f || f.type !== "file") return ERRNO.BADF;
				w.fds.delete(fd);
				return ERRNO.SUCCESS;
			},
			fd_filestat_get(fd, buf) {
				const f = w.fds.get(fd);
				if (!f) return ERRNO.BADF;
				const dv = w.dv();
				for (let j = 0; j < 64; j += 8) dv.setBigUint64(buf + j, 0n, true);
				dv.setUint8(buf + 16, f.type === "file" ? FILETYPE_REGULAR_FILE : f.type === "dir" ? FILETYPE_DIRECTORY : FILETYPE_CHARACTER_DEVICE);
				dv.setBigUint64(buf + 24, 1n, true);
				if (f.type === "file") dv.setBigUint64(buf + 32, BigInt(f.data.length), true);
				return ERRNO.SUCCESS;
			},
			fd_prestat_get(fd, buf) {
				const f = w.fds.get(fd);
				if (!f || f.type !== "dir") return ERRNO.BADF;
				const dv = w.dv();
				dv.setUint32(buf, 0, true);
				dv.setUint32(buf + 4, f.name.length, true);
				return ERRNO.SUCCESS;
			},
			fd_prestat_dir_name(fd, path, len) {
				const f = w.fds.get(fd);
				if (!f || f.type !== "dir") return ERRNO.BADF;
				w.u8().set(f.name.subarray(0, len), path);
				return ERRNO.SUCCESS;
			},
			path_open(dirfd, _dirflags, path, pathLen, oflags, _rightsBase, _rightsInheriting, _fdflags, opened) {
				const d = w.fds.get(dirfd);
				if (!d) return ERRNO.BADF;
				if (d.type !== "dir") return ERRNO.NOTDIR;
				if (oflags & 9) return ERRNO.ROFS;
				const name = decoder$1.decode(w.u8().slice(path, path + pathLen)).replace(/^(\.?\/)+/, "");
				const data = d.files.get(name);
				if (!data) return ERRNO.NOENT;
				if (oflags & OFLAGS_DIRECTORY) return ERRNO.NOTDIR;
				let fd = 4;
				while (w.fds.has(fd)) fd++;
				w.fds.set(fd, {
					type: "file",
					data,
					pos: 0
				});
				w.dv().setUint32(opened, fd, true);
				return ERRNO.SUCCESS;
			},
			poll_oneoff: new WebAssembly.Suspending((inp, out, nsubs, nevents) => {
				if (k.result) return never();
				if (!nsubs) return ERRNO.INVAL;
				const subs = w.subscriptions(inp, nsubs);
				const now = w.ready(subs);
				if (now.length) {
					w.writeEvents(out, nevents, now);
					return ERRNO.SUCCESS;
				}
				if (k.poller?.idle()) {
					w.writeEvents(out, nevents, w.ready(subs));
					return ERRNO.SUCCESS;
				}
				k.stats.idles++;
				let wait = 1e400;
				for (const s of subs) if (s.tag === EVENTTYPE_CLOCK) wait = Math.min(wait, Number(s.deadline - w.clockNs(s.clock)) / 1e6);
				return new Promise((resolve) => {
					let timer = null;
					let settled = false;
					const done = () => {
						if (settled) return;
						settled = true;
						if (timer !== null) clearTimeout(timer);
						k.idleWake = null;
						k.poller?.awake();
						if (k.result) return;
						w.writeEvents(out, nevents, w.ready(subs));
						resolve(ERRNO.SUCCESS);
					};
					k.idleWake = done;
					if (wait !== 1e400) timer = setTimeout(done, Math.max(0, wait));
					k.watchIrqWord(done, wait === 1e400 ? 6e4 : Math.max(0, wait));
				});
			}),
			sched_yield: new WebAssembly.Suspending(() => {
				if (k.result) return never();
				k.stats.yields++;
				return yieldToEventLoop().then(() => k.result ? never() : ERRNO.SUCCESS);
			}),
			proc_exit: new WebAssembly.Suspending((code) => {
				w.exit(code);
				return never();
			})
		};
	}
};
var ConsoleOrder = class {
	next = 0;
	held = /* @__PURE__ */ new Map();
	emit;
	constructor(emit) {
		this.emit = emit;
	}
	get empty() {
		return this.held.size === 0;
	}
	put(seq, bytes) {
		if (seq !== this.next) {
			if ((seq - this.next | 0) < 0) this.emit(bytes);
			else this.held.set(seq, bytes);
			return;
		}
		this.next = seq + 1 | 0;
		this.emit(bytes);
		if (!this.held.size) return;
		for (let b = this.held.get(this.next); b; b = this.held.get(this.next)) {
			this.held.delete(this.next);
			this.next = this.next + 1 | 0;
			this.emit(b);
		}
	}
	flush() {
		if (!this.held.size) return;
		const base = this.next;
		const seqs = [...this.held.keys()].sort((a, b) => (a - base | 0) - (b - base | 0));
		for (const s of seqs) {
			const b = this.held.get(s);
			this.held.delete(s);
			this.next = s + 1 | 0;
			this.emit(b);
		}
	}
};
const FOURCC_XRGB8888 = 875713112;
const ENODEV$2 = 19;
const DEFAULT_DISPLAY_SIZE = {
	width: 640,
	height: 480
};
var DisplayHost = class {
	enabled;
	#size;
	#offered = null;
	addr = 0;
	mode = null;
	probed = false;
	stats = {
		attaches: 0,
		detaches: 0
	};
	#memory;
	#onChange;
	#log;
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.#size = opts.enabled ?? false;
		this.#memory = opts.memory;
		this.#onChange = opts.onChange;
		this.#log = opts.log ?? (() => {});
	}
	#physical(mode) {
		const o = this.#offered;
		if (!o?.dpi || !(o.dpi > 0) || !mode.width || !mode.height) return 0;
		const scale = Math.min(o.width / mode.width, o.height / mode.height);
		const mm = (px) => Math.min(65535, Math.max(1, Math.round(px * scale * 25.4 / o.dpi)));
		return (mm(mode.width) << 16 | mm(mode.height)) >>> 0;
	}
	imports() {
		return {
			wasm_driver_fb_init: () => {
				this.probed = true;
				return this.enabled ? 0n : -BigInt(ENODEV$2);
			},
			wasm_driver_fb_mode: () => {
				let s = DEFAULT_DISPLAY_SIZE;
				try {
					const o = this.#size;
					if (typeof o === "function") s = o();
					else if (typeof o === "object") s = o;
				} catch (e) {
					this.#log(`[display] size callback failed: ${e}`);
				}
				this.#offered = s;
				const w = Math.min(65535, Math.max(1, Math.round(s.width) || DEFAULT_DISPLAY_SIZE.width));
				const h = Math.min(65535, Math.max(1, Math.round(s.height) || DEFAULT_DISPLAY_SIZE.height));
				return (w << 16 | h) >>> 0;
			},
			wasm_driver_fb_attach: (pixels, width, height, stride, format) => {
				const addr = Number(pixels);
				if (addr) {
					const mode = {
						width: width >>> 0,
						height: height >>> 0,
						stride: stride >>> 0,
						format: format >>> 0
					};
					if (mode.format !== 875713112 || mode.stride < mode.width * 4 || addr % 4 || addr + mode.stride * mode.height > this.#memory().buffer.byteLength) {
						this.#log(`[display] unusable framebuffer at 0x${addr.toString(16)}: ${JSON.stringify(mode)}`);
						return 0;
					}
					this.addr = addr;
					this.mode = mode;
					this.stats.attaches++;
				} else {
					this.addr = 0;
					this.mode = null;
					this.stats.detaches++;
				}
				try {
					this.#onChange?.(this.mode);
				} catch {}
				return this.mode ? this.#physical(this.mode) : 0;
			}
		};
	}
	saveState() {
		const o = this.#offered;
		return {
			addr: this.addr,
			mode: this.mode && { ...this.mode },
			offered: o && {
				width: o.width,
				height: o.height,
				dpi: o.dpi
			}
		};
	}
	restoreState(s) {
		this.probed = true;
		this.#offered = s.offered;
		this.addr = s.mode ? s.addr : 0;
		this.mode = s.mode && this.addr ? { ...s.mode } : null;
		if (this.mode) try {
			this.#onChange?.(this.mode);
		} catch {}
	}
	pixels() {
		const m = this.mode;
		if (!m || !this.addr) return null;
		return new Uint8Array(this.#memory().buffer, this.addr, m.stride * m.height);
	}
	readRGBA(out) {
		const m = this.mode;
		if (!m || !this.addr) return null;
		const { width, height, stride } = m;
		const data = out && out.length === width * height * 4 ? out : new Uint8ClampedArray(width * height * 4);
		const dst = new Uint32Array(data.buffer, data.byteOffset, width * height);
		const buf = this.#memory().buffer;
		for (let y = 0; y < height; y++) {
			const src = new Uint32Array(buf, this.addr + y * stride, width);
			const o = y * width;
			for (let x = 0; x < width; x++) {
				const p = src[x];
				dst[o + x] = 4278190080 | (p & 255) << 16 | p & 65280 | p >>> 16 & 255;
			}
		}
		return {
			width,
			height,
			data
		};
	}
};
function xrgbToRgba(src, width, height, out) {
	const n = width * height;
	const data = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
	const dst = new Uint32Array(data.buffer, data.byteOffset, n);
	const s = new Uint32Array(src.buffer, src.byteOffset, n);
	for (let i = 0; i < n; i++) {
		const p = s[i];
		dst[i] = 4278190080 | (p & 255) << 16 | p & 65280 | p >>> 16 & 255;
	}
	return data;
}
function frameToPpm(frame) {
	const header = new TextEncoder().encode(`P6\n${frame.width} ${frame.height}\n255\n`);
	const n = frame.width * frame.height;
	const out = new Uint8Array(header.length + n * 3);
	out.set(header);
	for (let i = 0, o = header.length; i < n; i++, o += 3) {
		out[o] = frame.data[i * 4];
		out[o + 1] = frame.data[i * 4 + 1];
		out[o + 2] = frame.data[i * 4 + 2];
	}
	return out;
}
const EV_SYN = 0;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;
const REL_X = 0;
const REL_Y = 1;
const REL_WHEEL = 8;
const ABS_X = 0;
const ABS_Y = 1;
const ABS_MAX = 32767;
const BTN_LEFT = 272;
const BTN_RIGHT = 273;
const BTN_MIDDLE = 274;
const INPUT_KEYBOARD = 0;
const INPUT_MOUSE = 1;
const INPUT_TABLET = 2;
const ENODEV$1 = 19;
const MAX_QUEUED = 4096;
var InputHost = class {
	enabled;
	probed = false;
	mask = 0;
	stats = {
		delivered: 0,
		dropped: 0
	};
	#queue = [];
	#keys = /* @__PURE__ */ new Set();
	#buttons = /* @__PURE__ */ new Set();
	#tabletButtons = /* @__PURE__ */ new Set();
	#abs = [-1, -1];
	#memory;
	#raise;
	#onChange;
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
		this.#onChange = opts.onChange;
	}
	get keyboardOpen() {
		return !!(this.mask & 1);
	}
	get mouseOpen() {
		return !!(this.mask & 2);
	}
	get tabletOpen() {
		return !!(this.mask & 4);
	}
	get state() {
		return {
			keyboard: this.keyboardOpen,
			mouse: this.mouseOpen,
			tablet: this.tabletOpen
		};
	}
	key(code, down) {
		if (down) {
			if (!this.keyboardOpen) return this.#drop();
			if (this.#keys.has(code)) return true;
			this.#keys.add(code);
		} else if (!this.#keys.delete(code)) return false;
		return this.#send(0, [
			1,
			code,
			down ? 1 : 0
		]);
	}
	button(code, down) {
		if (down) {
			if (!this.mouseOpen) return this.#drop();
			if (this.#buttons.has(code)) return true;
			this.#buttons.add(code);
		} else if (!this.#buttons.delete(code)) return false;
		return this.#send(1, [
			1,
			code,
			down ? 1 : 0
		]);
	}
	move(dx, dy) {
		dx = Math.round(dx);
		dy = Math.round(dy);
		if (!this.mouseOpen || this.#queue.length >= MAX_QUEUED * 4) return this.#drop();
		const ev = [];
		if (dx) ev.push(2, 0, dx);
		if (dy) ev.push(2, 1, dy);
		return ev.length ? this.#send(1, ev) : true;
	}
	wheel(clicks) {
		clicks = Math.round(clicks);
		if (!this.mouseOpen) return this.#drop();
		return clicks ? this.#send(1, [
			2,
			8,
			clicks
		]) : true;
	}
	moveTo(x, y) {
		if (!this.tabletOpen || this.#queue.length >= MAX_QUEUED * 4) return this.#drop();
		const ax = Math.min(ABS_MAX, Math.max(0, Math.floor(x * 32768)));
		const ay = Math.min(ABS_MAX, Math.max(0, Math.floor(y * 32768)));
		const ev = [];
		if (ax !== this.#abs[0]) ev.push(3, 0, ax);
		if (ay !== this.#abs[1]) ev.push(3, 1, ay);
		this.#abs = [ax, ay];
		return ev.length ? this.#send(2, ev) : true;
	}
	tabletButton(code, down) {
		if (down) {
			if (!this.tabletOpen) return this.#drop();
			if (this.#tabletButtons.has(code)) return true;
			this.#tabletButtons.add(code);
		} else if (!this.#tabletButtons.delete(code)) return false;
		return this.#send(2, [
			1,
			code,
			down ? 1 : 0
		]);
	}
	tabletWheel(clicks) {
		clicks = Math.round(clicks);
		if (!this.tabletOpen) return this.#drop();
		return clicks ? this.#send(2, [
			2,
			8,
			clicks
		]) : true;
	}
	releaseAll() {
		for (const c of [...this.#keys]) this.key(c, false);
		for (const b of [...this.#buttons]) this.button(b, false);
		for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
	}
	saveState() {
		return {
			mask: this.mask,
			keys: [...this.#keys],
			buttons: [...this.#buttons],
			tabletButtons: [...this.#tabletButtons],
			queue: this.#queue.slice()
		};
	}
	restoreState(s) {
		this.probed = true;
		this.mask = s.mask >>> 0;
		this.#queue = s.queue.slice(0, MAX_QUEUED * 4);
		this.#keys = new Set(s.keys);
		this.#buttons = new Set(s.buttons);
		this.#tabletButtons = new Set(s.tabletButtons);
		this.#abs = [-1, -1];
		this.releaseAll();
		if (this.#queue.length) this.#raise();
		try {
			this.#onChange?.(this.state);
		} catch {}
	}
	#drop() {
		this.stats.dropped++;
		return false;
	}
	#send(dev, triples) {
		for (let i = 0; i < triples.length; i += 3) this.#queue.push(dev, triples[i], triples[i + 1], triples[i + 2]);
		this.#queue.push(dev, 0, 0, 0);
		this.#raise();
		return true;
	}
	imports() {
		return {
			wasm_driver_input_init: () => {
				this.probed = true;
				return this.enabled ? 0n : -BigInt(ENODEV$1);
			},
			wasm_driver_input_read: (buf, max) => {
				const n = Math.min(Number(max), this.#queue.length / 4);
				if (!n) return 0n;
				const dv = new DataView(this.#memory().buffer, Number(buf), n * 12);
				const q = this.#queue;
				for (let i = 0; i < n; i++) {
					dv.setUint16(i * 12, q[i * 4], true);
					dv.setUint16(i * 12 + 2, q[i * 4 + 1], true);
					dv.setUint16(i * 12 + 4, q[i * 4 + 2], true);
					dv.setUint16(i * 12 + 6, 0, true);
					dv.setInt32(i * 12 + 8, q[i * 4 + 3], true);
				}
				q.splice(0, n * 4);
				this.stats.delivered += n;
				return BigInt(n);
			},
			wasm_driver_input_state: (mask) => {
				const closed = this.mask & ~mask;
				this.mask = mask >>> 0;
				if (closed & 1) for (const c of [...this.#keys]) this.key(c, false);
				if (closed & 2) for (const b of [...this.#buttons]) this.button(b, false);
				if (closed & 4) for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
				if (closed & 4) this.#abs = [-1, -1];
				try {
					this.#onChange?.(this.state);
				} catch {}
			}
		};
	}
};
const DOM_CODE_TO_LINUX = (() => {
	const m = {
		Escape: 1,
		Minus: 12,
		Equal: 13,
		Backspace: 14,
		Tab: 15,
		BracketLeft: 26,
		BracketRight: 27,
		Enter: 28,
		ControlLeft: 29,
		Semicolon: 39,
		Quote: 40,
		Backquote: 41,
		ShiftLeft: 42,
		Backslash: 43,
		Comma: 51,
		Period: 52,
		Slash: 53,
		ShiftRight: 54,
		NumpadMultiply: 55,
		AltLeft: 56,
		Space: 57,
		CapsLock: 58,
		NumLock: 69,
		ScrollLock: 70,
		Numpad7: 71,
		Numpad8: 72,
		Numpad9: 73,
		NumpadSubtract: 74,
		Numpad4: 75,
		Numpad5: 76,
		Numpad6: 77,
		NumpadAdd: 78,
		Numpad1: 79,
		Numpad2: 80,
		Numpad3: 81,
		Numpad0: 82,
		NumpadDecimal: 83,
		IntlBackslash: 86,
		F11: 87,
		F12: 88,
		IntlRo: 89,
		NumpadEnter: 96,
		ControlRight: 97,
		NumpadDivide: 98,
		PrintScreen: 99,
		AltRight: 100,
		Home: 102,
		ArrowUp: 103,
		PageUp: 104,
		ArrowLeft: 105,
		ArrowRight: 106,
		End: 107,
		ArrowDown: 108,
		PageDown: 109,
		Insert: 110,
		Delete: 111,
		AudioVolumeMute: 113,
		AudioVolumeDown: 114,
		AudioVolumeUp: 115,
		Power: 116,
		NumpadEqual: 117,
		Pause: 119,
		NumpadComma: 121,
		IntlYen: 124,
		MetaLeft: 125,
		MetaRight: 126,
		ContextMenu: 127
	};
	"1234567890".split("").forEach((d, i) => m[`Digit${d}`] = 2 + i);
	for (const [keys, base] of [
		["QWERTYUIOP", 16],
		["ASDFGHJKL", 30],
		["ZXCVBNM", 44]
	]) keys.split("").forEach((k, i) => m[`Key${k}`] = base + i);
	for (let i = 1; i <= 10; i++) m[`F${i}`] = 58 + i;
	for (let i = 13; i <= 24; i++) m[`F${i}`] = 170 + i;
	return Object.freeze(m);
})();
function domCodeToLinux(code) {
	return DOM_CODE_TO_LINUX[code];
}
function domButtonToLinux(button) {
	return button === 0 ? 272 : button === 1 ? 274 : button === 2 ? 273 : void 0;
}
const ENODEV = 19;
const SOUND_FORMAT_U8 = 1;
const SOUND_FORMAT_S16_LE = 2;
const EV_NAMES = [
	"close",
	"open",
	"prepare",
	"start",
	"stop"
];
var SoundHost = class {
	enabled;
	probed = false;
	state = {
		open: false,
		playing: false,
		format: null
	};
	stats = {
		opens: 0,
		starts: 0,
		stops: 0,
		chunks: 0,
		frames: 0,
		maxLagMs: 0
	};
	#sink;
	#memory;
	#log;
	#t0 = 0;
	#received = 0;
	constructor(opts) {
		this.enabled = !!opts.enabled;
		this.#sink = typeof opts.enabled === "object" ? opts.enabled : {};
		this.#memory = opts.memory;
		this.#log = opts.log ?? (() => {});
	}
	get playing() {
		return this.state.playing;
	}
	#event(ev, format) {
		const s = this.state;
		if (ev === "open") this.stats.opens++;
		if (ev === "start") {
			this.stats.starts++;
			this.#t0 = performance.now();
			this.#received = 0;
		}
		if (ev === "stop") this.stats.stops++;
		this.state = {
			open: ev !== "close",
			playing: ev === "start",
			format: ev === "prepare" ? format : ev === "open" || ev === "close" ? null : s.format
		};
		try {
			this.#sink.onState?.(this.state, ev);
		} catch (e) {
			this.#log(`[sound] onState failed: ${e}`);
		}
	}
	saveState() {
		const s = this.state;
		return { state: {
			open: s.open,
			playing: s.playing,
			format: s.format && { ...s.format }
		} };
	}
	restoreState(s) {
		this.probed = true;
		this.state = {
			open: false,
			playing: false,
			format: null
		};
		this.#t0 = performance.now();
		this.#received = 0;
		const notify = (state, ev) => {
			this.state = state;
			try {
				this.#sink.onState?.(state, ev);
			} catch (e) {
				this.#log(`[sound] onState failed: ${e}`);
			}
		};
		const { open, playing, format } = s.state;
		if (!open) return;
		notify({
			open: true,
			playing: false,
			format: null
		}, "open");
		if (format) notify({
			open: true,
			playing: false,
			format: { ...format }
		}, "prepare");
		if (format && playing) notify({
			open: true,
			playing: true,
			format: { ...format }
		}, "start");
	}
	imports() {
		return {
			wasm_driver_sound_init: () => {
				this.probed = true;
				if (!this.enabled) return -BigInt(ENODEV);
				const r = Math.round(this.#sink.rate ?? 0);
				return BigInt(r > 0 && r < 1e6 ? r : 0);
			},
			wasm_driver_sound_event: (event, rate, channels, format) => {
				let ev = EV_NAMES[event];
				if (!ev) return;
				let f = null;
				if (ev === "prepare") {
					const size = format === 1 ? 1 : format === 2 ? 2 : 0;
					if (!size || channels < 1 || channels > 2 || !rate) {
						this.#log(`[sound] unexpected format: rate ${rate}, ${channels} channels, format ${format}`);
						return;
					}
					f = {
						rate,
						channels,
						format,
						frameBytes: size * channels
					};
				}
				if (ev === "stop" && rate === 1) ev = "drain";
				this.#event(ev, f);
			},
			wasm_driver_sound_write: (buf, bytes) => {
				const f = this.state.format;
				const n = Number(bytes);
				if (!f || n <= 0) return 0n;
				const addr = Number(buf);
				const mem = this.#memory().buffer;
				if (addr + n > mem.byteLength) return 0n;
				const frames = Math.floor(n / f.frameBytes);
				const lag = ((performance.now() - this.#t0) * f.rate / 1e3 - this.#received) * 1e3 / f.rate;
				if (lag > this.stats.maxLagMs) this.stats.maxLagMs = lag;
				this.#received += frames;
				this.stats.chunks++;
				this.stats.frames += frames;
				const onChunk = this.#sink.onChunk;
				if (!onChunk) return 0n;
				const data = new Uint8Array(mem, addr, frames * f.frameBytes).slice();
				let queued = 0;
				try {
					queued = onChunk({
						format: f,
						data,
						frames
					});
				} catch (e) {
					this.#log(`[sound] onChunk failed: ${e}`);
				}
				return BigInt(Math.max(0, Math.round(queued || 0)));
			}
		};
	}
};
function pcmToFloat32(data, format, out) {
	const n = format.format === 1 ? data.length : data.length >> 1;
	const f = out && out.length === n ? out : new Float32Array(n);
	if (format.format === 1) for (let i = 0; i < n; i++) f[i] = (data[i] - 128) / 128;
	else {
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
	}
	return f;
}
function wavHeader(format, dataBytes) {
	const h = /* @__PURE__ */ new Uint8Array(44);
	const dv = new DataView(h.buffer);
	const ascii = (o, s) => {
		for (let i = 0; i < 4; i++) h[o + i] = s.charCodeAt(i);
	};
	ascii(0, "RIFF");
	dv.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, format.channels, true);
	dv.setUint32(24, format.rate, true);
	dv.setUint32(28, format.rate * format.frameBytes, true);
	dv.setUint16(32, format.frameBytes, true);
	dv.setUint16(34, format.frameBytes / format.channels * 8, true);
	ascii(36, "data");
	dv.setUint32(40, dataBytes, true);
	return h;
}
function convertPcm(data, from, to) {
	if (from.rate === to.rate && from.channels === to.channels && from.format === to.format) return data;
	const src = pcmToFloat32(data, from);
	const inFrames = Math.floor(src.length / from.channels);
	const outFrames = Math.floor(inFrames * to.rate / from.rate);
	const out = new Uint8Array(outFrames * to.frameBytes);
	const dv = new DataView(out.buffer);
	const sample = (frame, ch) => {
		const c = Math.min(ch, from.channels - 1);
		if (to.channels === 1 && from.channels === 2) return (src[frame * 2] + src[frame * 2 + 1]) / 2;
		return src[frame * from.channels + c];
	};
	for (let i = 0; i < outFrames; i++) {
		const x = i * from.rate / to.rate;
		const i0 = Math.floor(x), i1 = Math.min(i0 + 1, inFrames - 1), t = x - i0;
		for (let ch = 0; ch < to.channels; ch++) {
			const v = Math.max(-1, Math.min(1, sample(i0, ch) * (1 - t) + sample(i1, ch) * t));
			const o = i * to.frameBytes + ch * (to.frameBytes / to.channels);
			if (to.format === 1) out[o] = Math.round(v * 127 + 128);
			else dv.setInt16(o, Math.round(v * 32767), true);
		}
	}
	return out;
}
const DEVICE_KINDS = [
	"display",
	"sound",
	"vsock",
	"shm",
	"network"
];
function snapshotDeviceMismatch(saved, present, mac) {
	for (const kind of DEVICE_KINDS) {
		const had = kind in saved && saved[kind] !== void 0;
		if (had && !present[kind]) return `the snapshot has a ${kind} device, which this machine is not given`;
		if (!had && present[kind]) return `the snapshot has no ${kind} device, but this machine is given one`;
	}
	const m = saved.network?.mac;
	if (m && mac && (m.length !== mac.length || m.some((b, i) => b !== mac[i]))) return "the network device has another MAC than in the snapshot";
	return null;
}
const diskName = (i) => `wd${String.fromCharCode(97 + i)}`;
function snapshotDiskMismatch(saved, disks) {
	for (let i = 0; i < Math.max(saved.length, disks.length); i++) {
		const s = saved[i], d = disks[i];
		if (!d) return `disk ${diskName(i)} (${s.name}) is missing: the snapshot has ${saved.length} disk(s), ${disks.length} given`;
		if (!s) return `disk ${diskName(i)} was not in the snapshot: it has ${saved.length} disk(s), ${disks.length} given`;
		if (typeof d.snapshotState !== "function") return `disk ${diskName(i)} cannot be checked against the snapshot (no snapshotState)`;
		let now;
		try {
			now = d.snapshotState();
		} catch (e) {
			return `disk ${diskName(i)}: ${e.message}`;
		}
		if (now.identity !== s.identity) return `disk ${diskName(i)} (${now.name}) is not the disk of the snapshot (${s.name})`;
		if (now.gen !== s.gen) return `disk ${diskName(i)} (${now.name}) was written after the snapshot (generation ${now.gen}, the snapshot has ${s.gen})`;
		if ((now.stamp ?? "") !== (s.stamp ?? "")) return `disk ${diskName(i)} (${now.name}) was changed by another program after the snapshot (${s.stamp ?? "-"}, now ${now.stamp ?? "-"})`;
	}
	return null;
}
const PAGE = 4096;
function copySnapshotMemory(mem, free, bits) {
	if (!free || !bits) return {
		memory: mem.slice(),
		freeBytes: 0
	};
	const out = new Uint8Array(mem.byteLength);
	const pages = Math.min(bits, Math.floor(mem.byteLength / PAGE), free.length * 8);
	let runStart = -1, skipped = 0;
	const flush = (end) => {
		if (runStart >= 0) out.set(mem.subarray(runStart * PAGE, end * PAGE), runStart * PAGE);
		runStart = -1;
	};
	for (let p = 0; p < pages;) {
		const b = free[p >> 3];
		if ((p & 7) === 0 && p + 8 <= pages && (b === 0 || b === 255)) {
			if (b === 0) {
				if (runStart < 0) runStart = p;
			} else {
				flush(p);
				skipped += 8;
			}
			p += 8;
			continue;
		}
		if (b & 1 << (p & 7)) {
			flush(p);
			skipped++;
		} else if (runStart < 0) runStart = p;
		p++;
	}
	flush(pages);
	if (pages * PAGE < mem.byteLength) out.set(mem.subarray(pages * PAGE), pages * PAGE);
	return {
		memory: out,
		freeBytes: skipped * PAGE
	};
}
const MAGIC = "KWSNAP1\n";
const CHUNK = 65536;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function isZero(u8, off) {
	const w = new Int32Array(u8.buffer, u8.byteOffset + off, CHUNK / 4);
	for (let i = 0; i < w.length; i++) if (w[i] !== 0) return false;
	return true;
}
function encodeSnapshot(s) {
	const mem = s.memory;
	if (mem.byteLength % CHUNK || mem.byteOffset % 4) throw new Error("snapshot memory must be whole 64 KiB pages");
	const chunks = [];
	for (let off = 0; off < mem.byteLength; off += CHUNK) if (!isZero(mem, off)) chunks.push(off / CHUNK);
	const header = encoder.encode(JSON.stringify({
		version: s.version,
		fingerprint: s.fingerprint,
		memory64: s.memory64,
		memoryBytes: mem.byteLength,
		freeBytes: s.freeBytes ?? 0,
		monotonicMs: s.monotonicMs,
		consoleSize: s.consoleSize,
		inputBytes: s.input.length,
		chunks: chunks.length,
		disks: s.disks,
		devices: s.devices
	}));
	const out = new Uint8Array(12 + header.length + s.input.length + chunks.length * 65540);
	const dv = new DataView(out.buffer);
	let p = 0;
	out.set(encoder.encode(MAGIC), p);
	p += 8;
	dv.setUint32(p, header.length, true);
	p += 4;
	out.set(header, p);
	p += header.length;
	out.set(s.input, p);
	p += s.input.length;
	for (const c of chunks) {
		dv.setUint32(p, c, true);
		out.set(mem.subarray(c * CHUNK, (c + 1) * CHUNK), p + 4);
		p += 65540;
	}
	return out;
}
function decodeSnapshot(bytes) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (decoder.decode(bytes.subarray(0, 8)) !== MAGIC) throw new Error("not an unkernel snapshot");
	let p = 8;
	const hlen = dv.getUint32(p, true);
	p += 4;
	const h = JSON.parse(decoder.decode(bytes.subarray(p, p + hlen)));
	p += hlen;
	if (h.version !== 1) throw new Error(`unsupported snapshot version ${h.version}`);
	const input = bytes.slice(p, p + h.inputBytes);
	p += h.inputBytes;
	const memory = new Uint8Array(h.memoryBytes);
	for (let i = 0; i < h.chunks; i++) {
		const c = dv.getUint32(p, true);
		memory.set(bytes.subarray(p + 4, p + 4 + CHUNK), c * CHUNK);
		p += 65540;
	}
	return {
		version: 1,
		fingerprint: h.fingerprint,
		memory64: h.memory64,
		memory,
		freeBytes: h.freeBytes ?? 0,
		monotonicMs: h.monotonicMs,
		consoleSize: h.consoleSize,
		input,
		disks: Array.isArray(h.disks) ? h.disks : [],
		devices: h.devices && typeof h.devices === "object" ? h.devices : {}
	};
}
const IRQ_SYNC = 4;
const IRQ_INPUT = 5;
const IRQ_VSOCK = 6;
const IRQ_SHM = 7;
const IRQ_SNAPSHOT = 8;
const textDecoder = new TextDecoder();
function moduleIsMemory64(module) {
	const secs = WebAssembly.Module.customSections(module, "target_features");
	if (!secs.length) return true;
	const b = new Uint8Array(secs[0]);
	let p = 0;
	const leb = () => {
		let v = 0, s = 0, c;
		do {
			c = b[p++];
			v |= (c & 127) << s;
			s += 7;
		} while (c & 128);
		return v;
	};
	for (let n = leb(); n > 0 && p < b.length; n--) {
		const prefix = String.fromCharCode(b[p++]);
		const len = leb();
		const name = textDecoder.decode(b.subarray(p, p + len));
		p += len;
		if (name === "memory64") return prefix !== "-";
	}
	return false;
}
function bundledBoot(module) {
	const sec = (name) => WebAssembly.Module.customSections(module, name)[0];
	const initrd = sec("unkernel.initrd");
	const cmdline = sec("unkernel.cmdline");
	const datadisk = sec("unkernel.datadisk");
	return {
		initrd: initrd ? new Uint8Array(initrd) : void 0,
		cmdline: cmdline ? textDecoder.decode(cmdline) : void 0,
		datadisk: datadisk ? new Uint8Array(datadisk) : void 0
	};
}
var Kernel = class Kernel {
	opts;
	log;
	input;
	inputOffset;
	consoleSize;
	idleWake;
	resumers;
	onStage;
	exited;
	exit;
	result;
	stats;
	block;
	jit;
	netRx;
	display;
	evdev;
	sound;
	vsock;
	shm;
	memory;
	memory64 = false;
	sharedMemory = false;
	wasi;
	exports;
	irqAddr;
	retFromFork;
	bootTime = 0;
	poller = null;
	fingerprint = "";
	netMac = null;
	snapshotWaiter = null;
	cpus = 1;
	secondaries = [];
	jitMirrors = [];
	conRing = null;
	conFull = "wait";
	conReader = null;
	consoleOrder = null;
	conDropped = 0;
	constructor(opts) {
		this.opts = opts;
		this.log = opts.log ?? ((m) => console.error(m));
		this.input = [];
		this.inputOffset = 0;
		this.consoleSize = 0;
		this.idleWake = null;
		this.resumers = /* @__PURE__ */ new Map();
		this.onStage = opts.onStage ?? (() => {});
		this.result = void 0;
		this.exited = new Promise((r) => this.exit = (res) => {
			if (this.result) return;
			this.consoleFlush(true);
			this.result = res;
			try {
				this.onStage("exit", res);
			} catch {}
			r(res);
		});
		this.stats = {
			switches: 0,
			idles: 0,
			yields: 0
		};
		this.block = new BlockHost(this, opts.disks ?? []);
		const smp = WebAssembly.Module.imports(opts.module).some((i) => i.module === "unkernel" && i.name === "wasm_cpu_start");
		const cpus = Math.max(1, Math.floor(opts.cpus ?? 1));
		if (cpus > 1 && !smp) this.log(`[host] this kernel is not SMP: ${cpus} CPUs asked, it runs on one`);
		else if (cpus > 1 && !opts.spawnCpu) this.log("[host] this platform cannot start CPU threads: the SMP kernel runs on one CPU");
		else if (smp) {
			const why = cpus > 1 ? opts.whyNoCpus?.() : void 0;
			if (why) this.log(`[host] cannot start CPU threads here (${why}): the SMP kernel runs on one CPU`);
			else this.cpus = cpus;
		}
		if (this.cpus > 1) this.initConsoleRing();
		this.jit = new JitHost({
			enabled: opts.jit,
			memory: () => this.memory,
			memory64: () => this.memory64,
			log: this.log
		});
		this.netRx = [];
		this.display = new DisplayHost({
			enabled: opts.display,
			memory: () => this.memory,
			onChange: opts.onDisplay,
			log: this.log
		});
		this.evdev = new InputHost({
			enabled: !!opts.display,
			memory: () => this.memory,
			raise: () => this.raiseIrq(IRQ_INPUT),
			onChange: opts.onInput
		});
		this.sound = new SoundHost({
			enabled: opts.sound,
			memory: () => this.memory,
			log: this.log
		});
		this.vsock = new VsockDevice({
			enabled: opts.vsock,
			memory: () => this.memory,
			raise: () => this.raiseIrq(IRQ_VSOCK),
			onPacket: opts.onVsockPacket,
			onInit: opts.onVsockInit
		});
		this.shm = new ShmDevice({
			enabled: opts.shm,
			memory: () => this.memory,
			raise: () => this.raiseIrq(IRQ_SHM),
			driver: WebAssembly.Module.imports(opts.module).some((i) => i.module === "unkernel" && i.name === "wasm_driver_shm_init")
		});
		this.exited.then(() => {
			this.vsock.close();
			this.shm.close();
			for (const c of this.secondaries) c.terminate();
		});
		this.exports = void 0;
		this.irqAddr = void 0;
	}
	receiveFrame(frame) {
		this.netRx.push(frame);
		this.setIrqBits(4);
		this.wake();
	}
	raiseIrq(bit) {
		if (!this.result) this.setIrqBits(1 << bit);
		this.wake();
	}
	setIrqBits(bits) {
		if (this.irqAddr === void 0) return;
		if (this.sharedMemory) Atomics.or(new Int32Array(this.memory.buffer), this.irqAddr >> 2, bits);
		else {
			const dv = this.dv();
			dv.setUint32(this.irqAddr, dv.getUint32(this.irqAddr, true) | bits, true);
		}
	}
	clearIrqBits(bits) {
		if (this.irqAddr === void 0) return;
		if (this.sharedMemory) Atomics.and(new Int32Array(this.memory.buffer), this.irqAddr >> 2, ~bits);
		else {
			const dv = this.dv();
			dv.setUint32(this.irqAddr, dv.getUint32(this.irqAddr, true) & ~bits, true);
		}
	}
	watchIrqWord(done, timeoutMs) {
		if (!this.secondaries.length || this.irqAddr === void 0) return;
		const r = Atomics.waitAsync(new Int32Array(this.memory.buffer), this.irqAddr >> 2, 0, timeoutMs);
		if (r.async) r.value.then(done);
		else if (r.value === "not-equal") queueMicrotask(done);
	}
	jitStatsPerCpu() {
		return [{ ...this.jit.stats }, ...this.jitMirrors.map(jitStatsFromMirror)];
	}
	jitStatsAll() {
		return sumJitStats(this.jit.stats, this.jitMirrors.map(jitStatsFromMirror));
	}
	kwemuStatsPerCpu() {
		return [this.jit.kwemuStats(), ...this.jitMirrors.map((m) => this.jit.kwemuStats(jitBufFromMirror(m)))];
	}
	startCpu(cpu, idle) {
		const spawn = this.opts.spawnCpu;
		if (!spawn || cpu < 1 || cpu >= this.cpus || this.result) return -38;
		const flag = this.exports?.__wasm_init_memory_flag;
		const jitMirror = new Float64Array(new SharedArrayBuffer(JIT_MIRROR_WORDS * 8));
		let ep;
		try {
			ep = spawn({
				cpu,
				idle,
				module: this.opts.module,
				memory: this.memory,
				cpus: this.cpus,
				initFlag: flag instanceof WebAssembly.Global ? Number(flag.value) : 0,
				irqWord0: this.irqAddr ?? 0,
				epochMs: performance.timeOrigin - this.wasi.monoOffset,
				jit: this.jit.stats.enabled,
				memory64: this.memory64,
				jitMirror,
				console: this.conRing.buffer,
				consoleFull: this.conReader ? "post" : "wait"
			});
		} catch (e) {
			this.log(`[host] cannot start CPU ${cpu}: ${e?.message ?? e}`);
			return -38;
		}
		this.secondaries.push(ep);
		this.jitMirrors.push(jitMirror);
		ep.listen({
			message: (m) => this.onCpuMessage(m),
			error: (e) => this.fatal(`CPU ${cpu}: ${e?.stack ?? e}`)
		});
		return 0;
	}
	consoleWrite(mem, p, len) {
		const r = this.conRing;
		if (r === null || this.conReader !== null && r.quiet && this.consoleOrder.empty) {
			this.opts.write(mem.slice(p, p + len));
			return;
		}
		r.write(mem, p, len, this.conFull, this.conDeliver);
		this.conReader?.take();
	}
	initConsoleRing() {
		const theirs = this.opts.consoleRing;
		this.conRing = new ConsoleRing(theirs ?? newConsoleRing());
		if (theirs) return;
		const ring = this.conRing;
		this.conFull = "take";
		this.consoleOrder = new ConsoleOrder((bytes) => this.opts.write(bytes));
		const reader = this.conReader = new ConsoleRingReader(ring, this.conDeliver);
		const POLL_MS = 1, POLL_BYTES = 16384;
		let last = 0;
		this.poller ??= {
			poll: () => {
				if (!ring.pending) return;
				const now = performance.now();
				if (now - last < POLL_MS && ring.used < POLL_BYTES) return;
				last = now;
				if (reader.take()) this.opts.flushOutput?.();
			},
			idle: () => {
				reader.take();
				return false;
			},
			awake: () => {}
		};
		reader.start();
	}
	conDeliver = (b) => {
		if (this.result) return;
		this.consoleOrder?.put(b.seq, b.bytes);
		const d = this.conRing?.dropped ?? 0;
		if (d !== this.conDropped) {
			this.log(`[host] console: ${d - this.conDropped} bytes from other CPUs dropped (CPU 0 did not read them)`);
			this.conDropped = d;
		}
	};
	consoleFlush(end = false) {
		const reader = this.conReader;
		if (!reader) return;
		const b = reader.ring.take(true);
		if (b) this.conDeliver(b);
		if (!end) return;
		this.consoleOrder?.flush();
		reader.stop();
		reader.ring.close();
	}
	onCpuMessage(m) {
		switch (m.t) {
			case "out":
				this.conRing?.batchTaken();
				this.conDeliver(m);
				break;
			case "log":
				this.log(m.msg);
				break;
			case "err":
				this.wasi.stderr = (this.wasi.stderr + textDecoder.decode(m.bytes)).slice(-4096);
				break;
			case "exit":
				this.wasi.exit(m.code);
				this.wake();
				break;
			case "fatal":
				this.fatal(m.msg);
				this.wake();
				break;
			case "trap":
				this.log(`[host] wasm trap: ${m.error}`);
				this.exit({
					code: 254,
					reason: m.error,
					kind: "trap",
					error: m.error
				});
				this.wake();
		}
	}
	netImports() {
		const k = this;
		return {
			wasm_driver_net_init(mac) {
				const net = k.opts.net;
				if (!net) return -1n;
				k.netMac = (net.mac ?? /* @__PURE__ */ new Uint8Array(6)).slice(0, 6);
				k.u8().set(k.netMac, Number(mac));
				net.attach?.(k);
				return 0n;
			},
			wasm_driver_net_send(buf, len) {
				const p = Number(buf);
				k.opts.net?.send(k.u8().slice(p, p + Number(len)));
				return len;
			},
			wasm_driver_net_rx_len: () => BigInt(k.netRx.length ? k.netRx[0].length : 0),
			wasm_driver_net_recv(buf, max) {
				const f = k.netRx.shift();
				if (!f) return 0n;
				if (buf) k.u8().set(f.subarray(0, Number(max)), Number(buf));
				return BigInt(f.length);
			}
		};
	}
	u8() {
		return new Uint8Array(this.memory.buffer);
	}
	dv() {
		return new DataView(this.memory.buffer);
	}
	cstr(ptr, max = 4096) {
		const u8 = this.u8();
		const p = Number(ptr);
		let end = p;
		while (end < p + max && u8[end] !== 0) end++;
		return textDecoder.decode(u8.slice(p, end));
	}
	fatal(msg) {
		this.log(`[host] fatal: ${msg}`);
		this.exit({
			code: 255,
			reason: msg,
			kind: "fatal"
		});
	}
	stop(res = {}) {
		this.exit({
			code: res.code ?? 0,
			reason: res.reason ?? "stopped by the host",
			kind: res.kind ?? "stopped",
			error: res.error
		});
		this.wake();
	}
	sendInput(data) {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		if (!bytes.length) return;
		this.input.push(bytes);
		this.setIrqBits(2);
		this.wake();
	}
	setConsoleSize(cols, rows) {
		const size = (Math.min(rows, 65535) << 16 | Math.min(cols, 65535)) >>> 0;
		if (!cols || !rows || size === this.consoleSize) return;
		this.consoleSize = size;
		this.setIrqBits(2);
		this.wake();
	}
	requestSync({ timeout = 3e3 } = {}) {
		const disks = this.block.disks.filter((d) => d.persistent && typeof d.whenFlushed === "function");
		if (!disks.length) return Promise.resolve(true);
		if (this.irqAddr === void 0 || this.result) return Promise.all(disks.map((d) => d.saving?.catch(() => {}))).then(() => true);
		const marks = disks.map((d) => d.flushSeq ?? 0);
		this.setIrqBits(16);
		this.wake();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (!this.result) this.clearIrqBits(16);
				resolve(false);
			}, timeout);
			Promise.all(disks.map((d, i) => d.whenFlushed(marks[i]))).then(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}
	snapshot({ stop = false } = {}) {
		if (this.irqAddr === void 0 || this.result) return Promise.reject(/* @__PURE__ */ new Error("snapshot: the kernel is not running"));
		if (this.snapshotWaiter) return Promise.reject(/* @__PURE__ */ new Error("snapshot: one is in progress"));
		if (!this.exports?.kw_resume) return Promise.reject(/* @__PURE__ */ new Error("snapshot: this kernel cannot resume one (no kw_resume)"));
		for (const [i, d] of this.block.disks.entries()) {
			const why = typeof d.snapshotSeal !== "function" ? "it does not support snapshots" : (() => {
				try {
					d.snapshotState();
					return "";
				} catch (e) {
					return e.message;
				}
			})();
			if (why) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: disk wd${String.fromCharCode(97 + i)}: ${why}`));
		}
		const p = new Promise((resolve, reject) => this.snapshotWaiter = {
			resolve,
			reject,
			stop
		});
		this.raiseIrq(IRQ_SNAPSHOT);
		return p;
	}
	loadSnapshot(s) {
		if (s.version !== 1) throw new Error(`snapshot: unsupported version ${s.version}`);
		if (!this.exports?.kw_resume) throw new Error("snapshot: this kernel cannot resume one (no kw_resume)");
		if (s.fingerprint !== this.fingerprint) throw new Error(`snapshot: saved by another kernel build ("${s.fingerprint}", this one is "${this.fingerprint}")`);
		this.u8().set(s.memory);
		const resized = !!this.consoleSize && this.consoleSize !== s.consoleSize;
		this.dv().setUint32(this.irqAddr, resized ? 2 : 0, true);
		if (!this.consoleSize) this.consoleSize = s.consoleSize;
		this.wasi.monoOffset = s.monotonicMs - performance.now();
		this.restoreDevices(s.devices ?? {});
	}
	devicesPresent() {
		return {
			display: this.display.enabled,
			sound: this.sound.enabled,
			vsock: this.vsock.enabled,
			shm: this.shm.enabled,
			network: !!this.opts.net
		};
	}
	saveDevices() {
		const d = {};
		if (this.display.enabled) d.display = this.display.probed ? this.display.saveState() : null;
		if (this.evdev.enabled) d.input = this.evdev.probed ? this.evdev.saveState() : null;
		if (this.sound.enabled) d.sound = this.sound.probed ? this.sound.saveState() : null;
		if (this.vsock.enabled) d.vsock = this.vsock.probed ? this.vsock.saveState() : null;
		if (this.shm.enabled) d.shm = this.shm.probed ? this.shm.saveState() : null;
		if (this.opts.net) d.network = this.netMac ? { mac: [...this.netMac] } : null;
		return d;
	}
	restoreDevices(d) {
		if (d.display) this.display.restoreState(d.display);
		if (d.input) this.evdev.restoreState(d.input);
		if (d.sound) this.sound.restoreState(d.sound);
		if (d.vsock) this.vsock.restoreState(d.vsock);
		if (d.shm) this.shm.restoreState(d.shm);
		if (d.network && this.opts.net) {
			this.netMac = Uint8Array.from(d.network.mac);
			this.opts.net.attach?.(this);
		}
	}
	snapshotPoint(result, blocker, freeMap, freeBits) {
		const w = this.snapshotWaiter;
		this.snapshotWaiter = null;
		if (!w) return -16;
		const who = this.cstr(blocker, 64);
		if (result) {
			w.reject(/* @__PURE__ */ new Error(`snapshot: errno ${-result}${who && who !== "-" ? `, ${who} did not park` : ""}`));
			return 0;
		}
		const busy = [
			this.block.inflight || this.block.done.length ? "block requests" : "",
			this.netRx.length ? "network frames" : "",
			this.vsock.blocker(),
			this.shm.busy ? "shm requests" : ""
		].filter(Boolean);
		if (busy.length) {
			w.reject(/* @__PURE__ */ new Error(`snapshot: ${busy.join(", ")} in flight`));
			return -16;
		}
		const sealed = [];
		try {
			for (const d of this.block.disks) sealed.push(d.snapshotSeal());
		} catch (e) {
			w.reject(/* @__PURE__ */ new Error(`snapshot: disk wd${String.fromCharCode(97 + sealed.length)}: ${e.message}`));
			return -16;
		}
		const pending = this.input.map((c, i) => i ? c : c.subarray(this.inputOffset));
		const input = new Uint8Array(pending.reduce((n, c) => n + c.length, 0));
		pending.reduce((off, c) => (input.set(c, off), off + c.length), 0);
		const snap = {
			version: 1,
			fingerprint: this.fingerprint,
			memory64: this.memory64,
			...copySnapshotMemory(this.u8(), freeBits ? this.u8().subarray(Number(freeMap), Number(freeMap) + Math.ceil(Number(freeBits) / 8)) : null, Number(freeBits ?? 0)),
			monotonicMs: this.wasi.monotonicMs(),
			consoleSize: this.consoleSize,
			input,
			disks: sealed.map((s) => s.state),
			devices: this.saveDevices()
		};
		if (w.stop) this.stop({ reason: "stopped after a snapshot" });
		Promise.all(sealed.map((s) => s.done)).then(() => w.resolve(snap), (e) => w.reject(/* @__PURE__ */ new Error(`snapshot: saving a disk failed: ${e?.message ?? e}`)));
		return 0;
	}
	wake() {
		const w = this.idleWake;
		this.idleWake = null;
		if (w) w();
	}
	imports() {
		const k = this;
		const unkernel = {
			wasm_dump_stacktrace(buf, max) {
				const s = new TextEncoder().encode((/* @__PURE__ */ new Error()).stack ?? "");
				const n = Math.min(s.length, Number(max) - 1);
				k.u8().set(s.subarray(0, n), Number(buf));
				k.u8()[Number(buf) + n] = 0;
			},
			wasm_driver_console_size: () => k.consoleSize,
			wasm_init_flag() {
				const flag = k.exports?.__wasm_init_memory_flag;
				return flag instanceof WebAssembly.Global ? BigInt(flag.value) : 0n;
			},
			wasm_cpu_count: () => k.cpus,
			wasm_cpu_start: (cpu, idle) => k.startCpu(cpu, idle),
			wasm_stack_drop(task) {
				k.resumers.delete(task);
			},
			wasm_snapshot_point: (result, blocker, freeMap, freeBits) => k.snapshotPoint(result, blocker, freeMap, freeBits),
			wasm_switch_to: new WebAssembly.Suspending((prev, next, isNew, prevDead) => {
				if (k.result) return never();
				k.stats.switches++;
				const parked = prevDead ? never() : new Promise((r) => k.resumers.set(prev, r));
				if (isNew) {
					k.resumers.delete(next);
					queueMicrotask(() => {
						k.retFromFork(prev, next).then(() => k.fatal("task returned from ret_from_fork"), (e) => k.onTrap(e));
					});
				} else {
					const resume = k.resumers.get(next);
					if (!resume) k.fatal(`switch to unknown task 0x${next.toString(16)}`);
					else {
						k.resumers.delete(next);
						resume(prev);
					}
				}
				return parked;
			})
		};
		Object.assign(unkernel, this.block.imports());
		Object.assign(unkernel, this.netImports());
		Object.assign(unkernel, this.display.imports());
		Object.assign(unkernel, this.evdev.imports());
		Object.assign(unkernel, this.sound.imports());
		Object.assign(unkernel, this.vsock.imports());
		Object.assign(unkernel, this.shm.imports());
		Object.assign(unkernel, this.jit.imports());
		const imports = {
			env: { memory: this.memory },
			unkernel,
			wasi_snapshot_preview1: this.wasi.imports()
		};
		const missing = [];
		for (const imp of WebAssembly.Module.imports(this.opts.module)) {
			const mod = imports[imp.module] ??= {};
			if (!(imp.name in mod)) {
				missing.push(`${imp.module}.${imp.name}`);
				mod[imp.name] = () => {
					throw new Error(`unresolved kernel import ${imp.module}.${imp.name} called`);
				};
			}
		}
		if (missing.length) this.log(`[host] warning: unresolved imports: ${missing.join(", ")}`);
		return imports;
	}
	onTrap(e) {
		this.log(`[host] wasm trap: ${e?.stack ?? e}`);
		this.exit({
			code: 254,
			reason: String(e),
			kind: "trap",
			error: e
		});
	}
	static newMemory(pages, memory64, shared = false) {
		return memory64 ? new WebAssembly.Memory({
			initial: BigInt(pages),
			maximum: BigInt(pages),
			address: "i64",
			shared
		}) : new WebAssembly.Memory({
			initial: pages,
			maximum: pages,
			shared
		});
	}
	allocateMemory(memoryMiB, initrdBytes) {
		const want = [memoryMiB, ...(this.opts.memoryFallbackMiB ?? []).filter((m) => m < memoryMiB)];
		const failures = [];
		for (const mib of want) {
			const pages = Math.ceil(mib * 1024 * 1024 / 65536);
			try {
				if (!this.memory64 && pages > 65536) throw new RangeError("more than 4 GiB needs the wasm64 (memory64) kernel");
				const memory = Kernel.newMemory(pages, this.memory64, this.sharedMemory);
				if (failures.length) this.log(`[host] allocated ${mib} MiB after failing: ${failures.join("; ")}`);
				this.onStage("memory", {
					mib,
					requestedMiB: memoryMiB,
					failures,
					memory64: this.memory64
				});
				return memory;
			} catch (e) {
				failures.push(`${mib} MiB: ${e.message}`);
				if (initrdBytes && mib * 1048576 < initrdBytes + 41943040) break;
			}
		}
		const err = /* @__PURE__ */ new Error(`cannot allocate the kernel's memory (WebAssembly.Memory, ${this.memory64 ? "memory64" : "32-bit"}): ${failures.join("; ")}`);
		err.name = "MemoryAllocationError";
		throw err;
	}
	async boot() {
		const { module, restore } = this.opts;
		if (restore) {
			const why = snapshotDiskMismatch(restore.disks ?? [], this.block.disks) ?? snapshotDeviceMismatch(restore.devices ?? {}, this.devicesPresent(), this.opts.net?.mac);
			if (why) throw new Error(`snapshot: ${why}`);
		}
		const memoryMiB = restore ? restore.memory.byteLength / 1048576 : this.opts.memoryMiB ?? 512;
		const bundled = bundledBoot(module);
		const initrd = restore ? null : this.opts.initrd === void 0 ? bundled.initrd : this.opts.initrd;
		const cmdline = this.opts.cmdline ?? bundled.cmdline ?? "";
		if (!WebAssembly.Module.imports(module).find((i) => i.kind === "memory")) throw new Error("vmlinux must import its memory");
		const guessed = this.opts.memory64 === void 0 && !restore;
		this.memory64 = restore ? restore.memory64 : guessed ? moduleIsMemory64(module) : !!this.opts.memory64;
		if (restore) {
			this.memory = Kernel.newMemory(restore.memory.byteLength / 65536, this.memory64, this.sharedMemory);
			this.onStage("memory", {
				mib: memoryMiB,
				requestedMiB: memoryMiB,
				failures: [],
				memory64: this.memory64
			});
		} else this.memory = this.allocateMemory(memoryMiB, initrd?.length ?? 0);
		this.wasi = new WasiHost(this, {
			args: cmdline ? ["vmlinux", cmdline] : ["vmlinux"],
			files: initrd?.length ? { initrd } : {}
		});
		this.onStage("instantiate");
		let instance;
		let flippedShared = false, flippedType = !guessed;
		while (!instance) try {
			instance = await WebAssembly.instantiate(module, this.imports());
		} catch (e) {
			if (!(e instanceof WebAssembly.LinkError)) throw e;
			const pages = this.memory.buffer.byteLength / 65536;
			let memory64 = this.memory64, shared = this.sharedMemory;
			if (!flippedShared && /\bshared\b/i.test(e.message)) {
				flippedShared = true;
				shared = !shared;
			} else if (!flippedType) {
				flippedType = true;
				memory64 = !memory64;
			} else throw e;
			try {
				this.memory = Kernel.newMemory(pages, memory64, shared);
			} catch {
				throw e;
			}
			if (memory64 !== this.memory64) this.log(`[host] memory type guess was wrong (${e.message}); using a ${memory64 ? "64" : "32"}-bit memory`);
			this.memory64 = memory64;
			this.sharedMemory = shared;
		}
		const ex = this.exports = instance.exports;
		const addr = (name) => {
			const g = ex[name];
			if (!(g instanceof WebAssembly.Global)) throw new Error(`missing export ${name}`);
			return Number(g.value);
		};
		this.irqAddr = addr("wasm_host_irqs");
		this.fingerprint = ex.linux_banner instanceof WebAssembly.Global ? this.cstr(addr("linux_banner"), 512).trim() : "";
		this.jit.attach(ex);
		if (initrd?.length) {
			const memSize = this.memory.buffer.byteLength;
			const start = Math.floor((memSize - initrd.length) / 4096) * 4096;
			const kernelEnd = addr("_end");
			if (start < kernelEnd + 33554432) throw new Error(`not enough memory for the ${(initrd.length / 1048576).toFixed(1)} MiB initrd (have ${memSize / 1048576} MiB, need at least ${Math.ceil((kernelEnd + 33554432 + initrd.length) / 1048576) + 1} MiB)`);
		}
		this.retFromFork = WebAssembly.promising(ex.ret_from_fork);
		if (restore) this.loadSnapshot(restore);
		const entry = restore ? "kw_resume" : "_start";
		const start = WebAssembly.promising(ex[entry]);
		this.bootTime = performance.now();
		this.onStage("start");
		start().then(() => this.fatal(`${entry} returned`), (e) => this.onTrap(e));
		if (restore?.input.length) this.sendInput(restore.input.slice());
		return this.exited;
	}
};
function decodeRemap(r) {
	const map = () => {
		const n = r.uleb();
		const m = new Int32Array(n);
		let prev = -1;
		for (let i = 0; i < n; i++) m[i] = prev = prev + 1 + r.zig();
		return m;
	};
	const funcs = map(), globals = map(), types = map();
	const nd = r.uleb();
	const data = new Float64Array(nd * 3);
	let at = 0;
	for (let i = 0; i < nd; i++) {
		data[i * 3] = at += r.uleb();
		data[i * 3 + 1] = at += r.uleb();
		data[i * 3 + 2] = r.zig();
	}
	return {
		funcs,
		globals,
		types,
		data
	};
}
var Out = class {
	buf;
	n = 0;
	constructor(size) {
		this.buf = new Uint8Array(size);
	}
	grow(k) {
		if (this.n + k <= this.buf.length) return;
		const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
		b.set(this.buf.subarray(0, this.n));
		this.buf = b;
	}
	bytes(u8) {
		this.grow(u8.length);
		this.buf.set(u8, this.n);
		this.n += u8.length;
	}
	uleb(v) {
		this.grow(10);
		do {
			let b = v % 128;
			v = Math.floor(v / 128);
			if (v) b |= 128;
			this.buf[this.n++] = b;
		} while (v);
	}
	sleb(v) {
		this.grow(11);
		if (typeof v === "number") for (;;) {
			const b = (v % 128 + 128) % 128;
			v = (v - b) / 128;
			if (v === 0 && !(b & 64) || v === -1 && b & 64) {
				this.buf[this.n++] = b;
				return;
			}
			this.buf[this.n++] = b | 128;
		}
		for (;;) {
			const b = Number(v & 127n);
			v >>= 7n;
			if (v === 0n && !(b & 64) || v === -1n && b & 64) {
				this.buf[this.n++] = b;
				return;
			}
			this.buf[this.n++] = b | 128;
		}
	}
};
function moduleSections(w) {
	let p = 8;
	const out = [];
	while (p < w.length) {
		const start = p, id = w[p++];
		let size = 0, s = 1, c;
		do {
			c = w[p++];
			size += (c & 127) * s;
			s *= 128;
		} while (c & 128);
		out.push([
			id,
			start,
			p,
			p + size
		]);
		p += size;
	}
	return out;
}
function walkBody(w, p, end, imm) {
	const uleb = () => {
		let v = 0, s = 1, c;
		do {
			c = w[p++];
			v += (c & 127) * s;
			s *= 128;
		} while (c & 128);
		return v;
	};
	const sleb = () => {
		const s0 = p;
		let v = 0, mul = 1, c;
		do {
			c = w[p++];
			if (p - s0 > 7) {
				p = s0;
				let b = 0n, sh = 0n;
				do {
					c = w[p++];
					b |= BigInt(c & 127) << sh;
					sh += 7n;
				} while (c & 128);
				if (c & 64) b -= 1n << sh;
				return b;
			}
			v += (c & 127) * mul;
			mul *= 128;
		} while (c & 128);
		if (c & 64) v -= mul;
		return v;
	};
	const memarg = () => {
		if (uleb() & 64) uleb();
		const s = p;
		imm("offset", uleb(), s, p);
	};
	const blocktype = () => {
		const b = w[p];
		if (b === 64 || b >= 111 && b <= 127) {
			p++;
			return;
		}
		const s = p;
		imm("blocktype", Number(sleb()), s, p);
	};
	const nl = uleb();
	for (let i = 0; i < nl; i++) {
		uleb();
		p++;
	}
	while (p < end) {
		const op = w[p++];
		if (op <= 1 || op === 5 || op === 11 || op === 15 || op === 26 || op === 27 || op >= 69 && op <= 196 || op === 209) continue;
		switch (op) {
			case 2:
			case 3:
			case 4:
				blocktype();
				break;
			case 12:
			case 13:
			case 32:
			case 33:
			case 34:
			case 37:
			case 38:
				uleb();
				break;
			case 14: {
				const n = uleb();
				for (let i = 0; i <= n; i++) uleb();
				break;
			}
			case 16:
			case 18:
			case 210: {
				const s = p;
				imm("func", uleb(), s, p);
				break;
			}
			case 17:
			case 19: {
				const s = p;
				imm("type", uleb(), s, p);
				uleb();
				break;
			}
			case 28: {
				const n = uleb();
				p += n;
				break;
			}
			case 35:
			case 36: {
				const s = p;
				imm("global", uleb(), s, p);
				break;
			}
			case 63:
			case 64:
				uleb();
				break;
			case 65: {
				const s = p;
				imm("const32", sleb(), s, p);
				break;
			}
			case 66: {
				const s = p;
				imm("const64", sleb(), s, p);
				break;
			}
			case 67:
				p += 4;
				break;
			case 68:
				p += 8;
				break;
			case 208:
				p++;
				break;
			case 252: {
				const sub = uleb();
				if (sub <= 7) break;
				if (sub === 9 || sub === 11 || sub === 13 || sub === 15 || sub === 16 || sub === 17) uleb();
				else if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
					uleb();
					uleb();
				} else throw new Error(`kremap: unknown opcode 0xfc ${sub}`);
				break;
			}
			case 254:
				if (uleb() === 3) p++;
				else memarg();
				break;
			default:
				if (op >= 40 && op <= 62) {
					memarg();
					break;
				}
				throw new Error(`kremap: unknown opcode 0x${op.toString(16)} at ${p - 1}`);
		}
	}
}
function mapData(data, v) {
	let lo = 0, hi = data.length / 3 - 1;
	while (lo <= hi) {
		const mid = lo + hi >> 1;
		if (v < data[mid * 3]) hi = mid - 1;
		else if (v >= data[mid * 3 + 1]) lo = mid + 1;
		else return v + data[mid * 3 + 2];
	}
	return v;
}
function applyRemap(base, m) {
	const code = moduleSections(base).find((s) => s[0] === 10);
	if (!code) return base;
	let p = code[2];
	const uleb = () => {
		let v = 0, s = 1, c;
		do {
			c = base[p++];
			v += (c & 127) * s;
			s *= 128;
		} while (c & 128);
		return v;
	};
	const n = uleb();
	const body = new Out(code[3] - code[2] + 65536);
	body.uleb(n);
	const fn = new Out(65536);
	const hasData = m.data.length > 0;
	const map = (t, v) => v < t.length ? t[v] : v;
	for (let i = 0; i < n; i++) {
		const size = uleb(), start = p, end = p + size;
		fn.n = 0;
		let last = start;
		walkBody(base, start, end, (kind, v, s, e) => {
			let nv;
			switch (kind) {
				case "func":
					nv = map(m.funcs, v);
					break;
				case "global":
					nv = map(m.globals, v);
					break;
				case "type":
				case "blocktype":
					nv = map(m.types, v);
					break;
				case "offset":
					if (!hasData) return;
					nv = mapData(m.data, v);
					break;
				default:
					if (!hasData || typeof v !== "number" || v <= 0 || v > 4294967295) return;
					nv = mapData(m.data, v);
			}
			if (nv === v) return;
			fn.bytes(base.subarray(last, s));
			if (kind === "const32" || kind === "const64" || kind === "blocktype") fn.sleb(nv);
			else fn.uleb(nv);
			last = e;
		});
		fn.bytes(base.subarray(last, end));
		body.uleb(fn.n);
		body.bytes(fn.buf.subarray(0, fn.n));
		p = end;
	}
	const out = new Out(base.length + body.n - (code[3] - code[2]) + 16);
	out.bytes(base.subarray(0, code[1]));
	out.uleb(10);
	out.uleb(body.n);
	out.bytes(body.buf.subarray(0, body.n));
	out.bytes(base.subarray(code[3]));
	return out.buf.subarray(0, out.n);
}
var Reader = class {
	p = 0;
	u8;
	constructor(u8) {
		this.u8 = u8;
	}
	uleb() {
		let v = 0, s = 1, c;
		do {
			if (this.p >= this.u8.length) throw new Error("kernel patch: truncated");
			c = this.u8[this.p++];
			v += (c & 127) * s;
			s *= 128;
		} while (c & 128);
		return v;
	}
	zig() {
		const v = this.uleb();
		return v % 2 ? -(v + 1) / 2 : v / 2;
	}
	take(n) {
		if (this.p + n > this.u8.length) throw new Error("kernel patch: truncated");
		const r = this.u8.subarray(this.p, this.p + n);
		this.p += n;
		return r;
	}
};
function header(r) {
	const magic = r.take(4);
	if (magic[0] !== 75 || magic[1] !== 87 || magic[2] !== 80 || magic[3] !== 49) throw new Error("kernel patch: not a KWP1 patch");
	return {
		remap: !!(r.uleb() & 1),
		baseLength: r.uleb(),
		targetLength: r.uleb(),
		baseSha256: r.take(32),
		targetSha256: r.take(32)
	};
}
async function applyKernelPatch(base, patch, { verify = true } = {}) {
	const r = new Reader(patch);
	const h = header(r);
	if (base.length !== h.baseLength) throw new Error(`kernel patch: the base is ${base.length} bytes, the patch wants ${h.baseLength}`);
	const subtle = verify ? globalThis.crypto?.subtle : void 0;
	if (subtle && !equal(new Uint8Array(await subtle.digest("SHA-256", base)), h.baseSha256)) throw new Error("kernel patch: the base module is not the one the patch was made for");
	let src = base;
	if (h.remap) src = applyRemap(base, decodeRemap(r));
	const n = r.uleb();
	const ctrl = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		ctrl[i * 3] = r.uleb();
		ctrl[i * 3 + 1] = r.uleb();
		ctrl[i * 3 + 2] = r.zig();
	}
	let addTotal = 0;
	for (let i = 0; i < n; i++) addTotal += ctrl[i * 3];
	const diff = new Uint8Array(addTotal);
	for (let i = 0; i < addTotal;) {
		i += r.uleb();
		const lit = r.uleb();
		if (i + lit > addTotal) throw new Error("kernel patch: corrupt difference bytes");
		diff.set(r.take(lit), i);
		i += lit;
	}
	const extra = r.u8.subarray(r.p);
	const out = new Uint8Array(h.targetLength);
	let o = 0, op = 0, dp = 0, ep = 0;
	for (let i = 0; i < n; i++) {
		const add = ctrl[i * 3], copy = ctrl[i * 3 + 1], seek = ctrl[i * 3 + 2];
		if (o + add + copy > out.length || op < 0 || op + add > src.length) throw new Error("kernel patch: corrupt control");
		for (let k = 0; k < add; k++) out[o + k] = src[op + k] + diff[dp + k];
		o += add;
		op += add;
		dp += add;
		out.set(extra.subarray(ep, ep + copy), o);
		o += copy;
		ep += copy;
		op += seek;
	}
	if (o !== out.length) throw new Error("kernel patch: short output");
	if (subtle && !equal(new Uint8Array(await subtle.digest("SHA-256", out)), h.targetSha256)) throw new Error("kernel patch: the result does not match the patch's hash");
	return out;
}
function equal(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
const BUNDLE_PREFIX = "unkernel.";
function customName(w, payload, end) {
	let p = payload, n = 0, s = 1, c;
	do {
		c = w[p++];
		n += (c & 127) * s;
		s *= 128;
	} while (c & 128);
	if (p + n > end) throw new Error("kernel bundle: bad custom section");
	let name = "";
	for (let i = 0; i < n; i++) name += String.fromCharCode(w[p + i]);
	return [name, p + n];
}
async function smpKernelFromBundle(bundle, opts) {
	const secs = moduleSections(bundle);
	let patch;
	const kernel = [bundle.subarray(0, 8)], extra = [];
	for (const [id, start, payload, end] of secs) {
		if (id === 0) {
			const [n, data] = customName(bundle, payload, end);
			if (n === "unkernel.kernel.smp.kwpatch") {
				patch = bundle.subarray(data, end);
				continue;
			}
			if (n.startsWith(BUNDLE_PREFIX)) {
				extra.push(bundle.subarray(start, end));
				continue;
			}
		}
		kernel.push(bundle.subarray(start, end));
	}
	if (!patch) return void 0;
	return concat([await applyKernelPatch(concat(kernel), patch, opts), ...extra]);
}
function concat(parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) {
		out.set(p, n);
		n += p.length;
	}
	return out;
}
var BootError = class extends Error {
	stage;
	constructor(stage, message, options) {
		super(message, options);
		this.name = "BootError";
		this.stage = stage;
	}
};
const WASM_HEADERS = { "content-type": "application/wasm" };
function isBufferSource(src) {
	return src instanceof ArrayBuffer || ArrayBuffer.isView(src);
}
function isLocation(src) {
	return typeof src === "string" || src instanceof URL;
}
function toU8(src) {
	return src instanceof Uint8Array ? src : src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}
function expectedLength(r) {
	return Number(r.headers.get("x-decoded-length") || (r.headers.get("content-encoding") ? 0 : r.headers.get("content-length"))) || 0;
}
async function fetchOk(url, signal) {
	let r;
	try {
		r = await fetch(url, {
			cache: "no-cache",
			signal
		});
	} catch (e) {
		throw new BootError("download", `Network error fetching ${url}: ${e.message}`, { cause: e });
	}
	if (!r.ok) throw new BootError("download", `GET ${url} → ${r.status} ${r.statusText || ""}`.trim());
	return r;
}
function withProgress(r, url, opts, headers) {
	const total = expectedLength(r);
	const what = opts.what ?? "kernel";
	const report = (loaded, done) => opts.onProgress?.({
		stage: "download",
		what,
		url,
		loaded,
		total,
		done
	});
	if (!r.body) return [r, () => void 0];
	const reader = r.body.getReader();
	let loaded = 0, failed;
	report(0, false);
	const body = new ReadableStream({
		async pull(c) {
			let chunk;
			try {
				chunk = await reader.read();
			} catch (e) {
				failed = e ?? /* @__PURE__ */ new Error("read failed");
				c.error(e);
				return;
			}
			if (chunk.done) {
				report(loaded, true);
				c.close();
				return;
			}
			loaded += chunk.value.length;
			report(loaded, false);
			c.enqueue(chunk.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	return [new Response(body, {
		status: r.status,
		headers: headers ?? r.headers
	}), () => failed];
}
async function download(url, opts = {}) {
	return readResponse(await fetchOk(url, opts.signal), String(url), opts);
}
async function readResponse(r, url, opts) {
	try {
		return new Uint8Array(await withProgress(r, url, opts)[0].arrayBuffer());
	} catch (e) {
		if (e instanceof BootError) throw e;
		throw new BootError("download", `Reading ${url} failed: ${e.message}`, { cause: e });
	}
}
async function loadBytes(src, opts = {}) {
	if (isBufferSource(src)) return toU8(src);
	if (!isLocation(src)) return readResponse(src, src.url, opts);
	const local = opts.readFile?.(src);
	if (local) return local;
	return download(src, opts);
}
async function loadKernelModule(src, opts = {}) {
	if (src instanceof WebAssembly.Module) return src;
	const compile = async (bytes) => {
		if (opts.smp) try {
			bytes = await smpKernelFromBundle(bytes) ?? bytes;
		} catch (e) {
			throw new BootError("compile", `Deriving the SMP kernel from the bundle failed: ${e.message}`, { cause: e });
		}
		try {
			return await WebAssembly.compile(bytes);
		} catch (e) {
			throw new BootError("compile", `Compiling the kernel failed: ${e.message}`, { cause: e });
		}
	};
	if (isBufferSource(src)) return compile(toU8(src));
	let r;
	if (isLocation(src)) {
		const local = opts.readFile?.(src);
		if (local) return compile(await local);
		r = await fetchOk(src, opts.signal);
	} else r = src;
	const url = r.url || (isLocation(src) ? String(src) : "");
	if (opts.smp || typeof WebAssembly.compileStreaming !== "function" || !r.body) return compile(await readResponse(r, url, {
		...opts,
		what: "kernel"
	}));
	const [counted, readError] = withProgress(r, url, {
		...opts,
		what: "kernel"
	}, WASM_HEADERS);
	try {
		return await WebAssembly.compileStreaming(counted);
	} catch (e) {
		if (e instanceof BootError) throw e;
		const re = readError();
		if (re !== void 0 || opts.signal?.aborted) throw new BootError("download", `Fetching ${url} failed: ${re?.message ?? e.message}`, { cause: re ?? e });
		throw new BootError("compile", `Compiling the kernel failed: ${e.message}`, { cause: e });
	}
}
const ETH_ARP = 2054;
const ETH_IP = 2048;
const PROTO_ICMP = 1;
const PROTO_TCP = 6;
const PROTO_UDP = 17;
const FIN = 1;
const SYN = 2;
const RST = 4;
const ACK = 16;
const ip4$1 = (s) => s.split(".").reduce((a, b) => (a << 8 | Number(b)) >>> 0, 0);
const ip4str = (n) => `${n >>> 24}.${n >>> 16 & 255}.${n >>> 8 & 255}.${n & 255}`;
function parseMac(s) {
	return Uint8Array.from(s.split(":").map((h) => parseInt(h, 16)));
}
function sum16(u8, off, len, s = 0) {
	const end = off + len;
	let i = off;
	for (; i + 1 < end; i += 2) s += u8[i] << 8 | u8[i + 1];
	if (i < end) s += u8[i] << 8;
	return s;
}
function fold(s) {
	while (s > 65535) s = (s & 65535) + Math.floor(s / 65536);
	return ~s & 65535;
}
const seqLt = (a, b) => (a - b | 0) < 0;
const seqLe = (a, b) => (a - b | 0) <= 0;
const seqAdd = (a, n) => a + n >>> 0;
const seqDiff = (a, b) => a - b | 0;
var ByteQueue = class {
	chunks = [];
	head = 0;
	length = 0;
	push(u8) {
		if (!u8.length) return;
		this.chunks.push(u8);
		this.length += u8.length;
	}
	drop(n) {
		this.length -= n;
		while (n > 0) {
			const avail = this.chunks[0].length - this.head;
			if (n < avail) {
				this.head += n;
				return;
			}
			n -= avail;
			this.chunks.shift();
			this.head = 0;
		}
	}
	copyTo(dst, dstOff, offset, len) {
		let i = 0, pos = this.head + offset;
		while (pos >= this.chunks[i].length) pos -= this.chunks[i++].length;
		while (len > 0) {
			const c = this.chunks[i++];
			const take = Math.min(len, c.length - pos);
			dst.set(c.subarray(pos, pos + take), dstOff);
			dstOff += take;
			len -= take;
			pos = 0;
		}
	}
};
const RCVBUF = 262144;
const SNDBUF_HIGH = 524288;
const RTO_MS = 1e3;
const RTO_MAX_MS = 8e3;
const MAX_RETRIES = 8;
var TcpConn = class {
	stack;
	key;
	gport;
	ip;
	port;
	irs;
	rcvNxt;
	iss;
	sndUna;
	sndNxt;
	mss;
	sndWscale;
	rcvWscale;
	sndWl;
	sendq;
	state;
	remoteEof;
	finSent;
	guestFin;
	paused;
	rto;
	retries;
	timer;
	lastWnd;
	handle;
	constructor(stack, key, gport, ip, port, seg) {
		this.stack = stack;
		this.key = key;
		this.gport = gport;
		this.ip = ip;
		this.port = port;
		this.irs = seg.seq;
		this.rcvNxt = seqAdd(seg.seq, 1);
		this.iss = Math.random() * 4294967296 >>> 0;
		this.sndUna = this.iss;
		this.sndNxt = this.iss;
		this.mss = seg.mss ?? 536;
		this.sndWscale = seg.wscale ?? 0;
		this.rcvWscale = seg.wscale !== void 0 ? 4 : 0;
		this.sndWl = seqAdd(this.iss + 1, seg.win);
		this.sendq = new ByteQueue();
		this.state = "connecting";
		this.remoteEof = false;
		this.finSent = false;
		this.guestFin = false;
		this.paused = false;
		this.rto = RTO_MS;
		this.retries = 0;
		this.timer = null;
		this.lastWnd = 0;
		this.handle = void 0;
	}
	inFlight() {
		return seqDiff(this.sndNxt, this.sndUna) - (this.finSent ? 1 : 0);
	}
	rcvWnd() {
		const free = Math.max(0, RCVBUF - (this.handle?.buffered ?? 0));
		return Math.min(free >> this.rcvWscale, 65535);
	}
	send(flags, seq, payloadLen = 0, opts = null) {
		const wnd = this.rcvWnd();
		this.lastWnd = wnd << this.rcvWscale;
		this.stack.sendTcp(this, flags, seq, payloadLen, opts, wnd);
	}
	ack() {
		this.send(ACK, this.sndNxt);
	}
	synAck() {
		const o = [
			2,
			4,
			5,
			180
		];
		if (this.sndWscale || this.rcvWscale) o.push(1, 3, 3, this.rcvWscale);
		this.send(18, this.iss, 0, Uint8Array.from(o));
		this.sndNxt = seqAdd(this.iss, 1);
		this.armTimer();
	}
	flush() {
		if (this.state !== "established") return;
		let sent = false;
		for (;;) {
			const off = seqDiff(this.sndNxt, this.sndUna);
			const unsent = this.sendq.length - off;
			const room = seqDiff(this.sndWl, this.sndNxt);
			if (unsent <= 0 || room <= 0) break;
			const n = Math.min(unsent, room, this.mss);
			this.send(24, this.sndNxt, n);
			this.sndNxt = seqAdd(this.sndNxt, n);
			sent = true;
		}
		if (this.remoteEof && !this.finSent && seqDiff(this.sndNxt, this.sndUna) === this.sendq.length) {
			this.send(17, this.sndNxt);
			this.sndNxt = seqAdd(this.sndNxt, 1);
			this.finSent = true;
			sent = true;
		}
		if (sent || this.sendq.length && seqDiff(this.sndWl, this.sndNxt) <= 0) this.armTimer();
		if (this.paused && this.sendq.length < SNDBUF_HIGH / 2) {
			this.paused = false;
			this.handle?.resume();
		}
	}
	armTimer() {
		if (this.timer) return;
		this.timer = setTimeout(() => this.onTimer(), this.rto);
	}
	clearTimer() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
	onTimer() {
		this.timer = null;
		if (this.state === "closed") return;
		if (++this.retries > MAX_RETRIES) {
			this.stack.log?.(`[net] tcp ${ip4str(this.ip)}:${this.port}: guest unresponsive, resetting`);
			this.send(20, this.sndNxt);
			this.close();
			return;
		}
		this.rto = Math.min(this.rto * 2, RTO_MAX_MS);
		if (this.state === "synrcvd") {
			this.sndNxt = this.iss;
			this.synAck();
		} else if (seqDiff(this.sndNxt, this.sndUna) > 0) {
			this.sndNxt = this.sndUna;
			this.finSent = false;
			this.flush();
		} else if (this.sendq.length) {
			this.send(ACK, seqAdd(this.sndUna, -1));
			this.armTimer();
		}
	}
	connect() {
		const host = this.stack.backendHost(this.ip);
		if (host === null) return this.refuse();
		this.handle = this.stack.backend.connect({
			host,
			port: this.port
		}, {
			onConnect: () => {
				if (this.state !== "connecting") return;
				this.state = "synrcvd";
				this.synAck();
			},
			onData: (u8) => {
				if (this.state === "closed") return;
				this.sendq.push(u8);
				if (!this.paused && this.sendq.length >= SNDBUF_HIGH) {
					this.paused = true;
					this.handle.pause();
				}
				this.flush();
			},
			onEnd: () => {
				if (this.state === "closed") return;
				this.remoteEof = true;
				this.flush();
			},
			onDrain: () => {
				if (this.state === "established" && this.lastWnd < RCVBUF / 2) this.ack();
			},
			onClose: (err) => {
				if (this.state === "closed") return;
				if (this.state === "connecting") return this.refuse(err);
				if (err) {
					this.stack.log?.(`[net] tcp ${ip4str(this.ip)}:${this.port}: ${err.message ?? err}`);
					this.send(20, this.sndNxt);
					this.close();
				} else {
					this.remoteEof = true;
					this.flush();
				}
			}
		});
	}
	refuse(err) {
		if (err) this.stack.log?.(`[net] tcp connect ${ip4str(this.ip)}:${this.port}: ${err.message ?? err}`);
		this.stack.sendTcp(this, 20, 0, 0, null, 0);
		this.close();
	}
	close() {
		if (this.state === "closed") return;
		this.state = "closed";
		this.clearTimer();
		this.stack.tcp.delete(this.key);
		this.handle?.destroy();
	}
	maybeDone() {
		if (this.guestFin && this.finSent && this.sndUna === this.sndNxt) this.close();
	}
	input(seg, payload) {
		if (seg.flags & RST) return this.close();
		if (seg.flags & SYN) {
			if (this.state === "synrcvd") {
				this.sndNxt = this.iss;
				this.clearTimer();
				this.synAck();
			}
			return;
		}
		if (!(seg.flags & ACK) || this.state === "connecting") return;
		const ack = seg.ack;
		if (seqLt(this.sndUna, ack) && seqLe(ack, this.sndNxt)) {
			let n = seqDiff(ack, this.sndUna);
			if (this.state === "synrcvd") {
				this.state = "established";
				n--;
			}
			if (this.finSent && ack === this.sndNxt) n--;
			if (n > 0) this.sendq.drop(n);
			this.sndUna = ack;
			this.retries = 0;
			this.rto = RTO_MS;
			this.clearTimer();
			if (this.sndUna !== this.sndNxt) this.armTimer();
		}
		if (this.state === "synrcvd") return;
		if (seqLe(this.sndUna, ack)) this.sndWl = seqAdd(ack, seg.win << this.sndWscale);
		if (this.sndUna === this.sndNxt) this.retries = 0;
		const len = payload.length;
		let seq = seg.seq;
		let data = payload;
		let needAck = false;
		if (len || seg.flags & FIN) {
			const skip = seqDiff(this.rcvNxt, seq);
			if (skip > 0) {
				if (skip >= len + (seg.flags & FIN ? 1 : 0)) {
					this.ack();
					return;
				}
				data = data.subarray(Math.min(skip, len));
				seq = this.rcvNxt;
			} else if (skip < 0) {
				this.ack();
				return;
			}
			if (data.length && !this.guestFin) {
				this.handle.write(data);
				this.rcvNxt = seqAdd(this.rcvNxt, data.length);
			}
			if (seg.flags & FIN && !this.guestFin) {
				this.guestFin = true;
				this.rcvNxt = seqAdd(this.rcvNxt, 1);
				this.handle.end();
			}
			needAck = true;
		}
		const before = this.sndNxt;
		this.flush();
		if (needAck && this.sndNxt === before) this.ack();
		this.maybeDone();
	}
};
var NetStack = class {
	backend;
	log;
	hostLoopback;
	mtu;
	mac;
	gwMac;
	guestMac;
	net;
	mask;
	gw;
	dns;
	guest;
	tcp;
	ipId;
	output;
	stats;
	constructor(opts) {
		this.backend = opts.backend;
		this.log = opts.log;
		this.hostLoopback = opts.hostLoopback ?? false;
		this.mtu = opts.mtu;
		this.mac = parseMac(opts.mac ?? "52:54:00:12:34:56");
		this.gwMac = parseMac("52:55:0a:00:02:02");
		this.guestMac = this.mac;
		this.net = ip4$1("10.0.2.0");
		this.mask = ip4$1("255.255.255.0");
		this.gw = ip4$1("10.0.2.2");
		this.dns = ip4$1("10.0.2.3");
		this.guest = ip4$1("10.0.2.15");
		this.tcp = /* @__PURE__ */ new Map();
		this.ipId = 1;
		this.output = () => {};
		this.stats = {
			rx: 0,
			tx: 0,
			tcpOpened: 0,
			dns: 0
		};
	}
	attach(kernel) {
		this.output = (frame) => kernel.receiveFrame(frame);
	}
	send(frame) {
		this.stats.rx++;
		try {
			this.input(frame);
		} catch (e) {
			this.log?.(`[net] dropped malformed frame: ${e.stack ?? e}`);
		}
	}
	close() {
		for (const c of [...this.tcp.values()]) c.close();
	}
	emit(frame) {
		this.stats.tx++;
		this.output(frame);
	}
	backendHost(ip) {
		if (ip === this.gw) return this.hostLoopback ? "127.0.0.1" : null;
		if ((ip & this.mask) >>> 0 === this.net) return null;
		if (ip === 4294967295 || ip >>> 28 === 14 || ip >>> 24 === 0 || ip >>> 24 === 127) return null;
		return ip4str(ip);
	}
	input(f) {
		if (f.length < 14) return;
		const type = f[12] << 8 | f[13];
		if (type === ETH_ARP) this.arp(f);
		else if (type === ETH_IP) this.ipv4(f);
	}
	arp(f) {
		const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
		if (f.length < 42 || dv.getUint16(20) !== 1) return;
		const tip = dv.getUint32(38);
		const sip = dv.getUint32(28);
		if (tip === sip || tip === this.guest || (tip & this.mask) >>> 0 !== this.net) return;
		this.guestMac = f.slice(22, 28);
		const r = /* @__PURE__ */ new Uint8Array(42);
		r.set(this.guestMac, 0);
		r.set(this.gwMac, 6);
		const o = new DataView(r.buffer);
		o.setUint16(12, ETH_ARP);
		o.setUint16(14, 1);
		o.setUint16(16, ETH_IP);
		r[18] = 6;
		r[19] = 4;
		o.setUint16(20, 2);
		r.set(this.gwMac, 22);
		o.setUint32(28, tip);
		r.set(f.subarray(22, 28), 32);
		o.setUint32(38, sip);
		this.emit(r);
	}
	ipv4(f) {
		const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
		if (f.length < 34 || f[14] >> 4 !== 4) return;
		const ihl = (f[14] & 15) * 4;
		const total = dv.getUint16(16);
		if ((dv.getUint16(20) & 16383) !== 0) return;
		const proto = f[23];
		const src = dv.getUint32(26), dst = dv.getUint32(30);
		const l4 = 14 + ihl;
		const end = Math.min(f.length, total ? 14 + total : f.length);
		if (end < l4) return;
		this.guestMac = f.slice(6, 12);
		if (proto === PROTO_TCP) this.tcpInput(f, dv, src, dst, l4, end);
		else if (proto === PROTO_UDP) this.udpInput(f, dv, src, dst, l4, end);
		else if (proto === PROTO_ICMP) this.icmpInput(f, dv, src, dst, l4, end);
	}
	ipFrame(src, dst, proto, l4len, dstMac = this.guestMac) {
		const f = new Uint8Array(34 + l4len);
		f.set(dstMac, 0);
		f.set(this.gwMac, 6);
		f[12] = 8;
		f[13] = 0;
		const dv = new DataView(f.buffer);
		f[14] = 69;
		dv.setUint16(16, 20 + l4len);
		dv.setUint16(18, this.ipId = this.ipId + 1 & 65535);
		dv.setUint16(20, 16384);
		f[22] = 64;
		f[23] = proto;
		dv.setUint32(26, src);
		dv.setUint32(30, dst);
		dv.setUint16(24, fold(sum16(f, 14, 20)));
		return [f, dv];
	}
	l4csum(f, src, dst, proto, off, len) {
		return fold(sum16(f, off, len, (src >>> 16) + (src & 65535) + (dst >>> 16) + (dst & 65535) + proto + len));
	}
	sendUdp(src, sport, dst, dport, payload, dstMac) {
		const [f, dv] = this.ipFrame(src, dst, PROTO_UDP, 8 + payload.length, dstMac);
		dv.setUint16(34, sport);
		dv.setUint16(36, dport);
		dv.setUint16(38, 8 + payload.length);
		f.set(payload, 42);
		dv.setUint16(40, this.l4csum(f, src, dst, PROTO_UDP, 34, 8 + payload.length) || 65535);
		this.emit(f);
	}
	sendTcp(c, flags, seq, payloadLen, opts, wnd) {
		const hl = 20 + (opts ? opts.length : 0);
		const [f, dv] = this.ipFrame(c.ip, this.guest, PROTO_TCP, hl + payloadLen);
		dv.setUint16(34, c.port);
		dv.setUint16(36, c.gport);
		dv.setUint32(38, seq);
		dv.setUint32(42, flags & ACK ? c.rcvNxt : 0);
		f[46] = hl / 4 << 4;
		f[47] = flags;
		dv.setUint16(48, wnd);
		if (opts) f.set(opts, 54);
		if (payloadLen) c.sendq.copyTo(f, 34 + hl, seqDiff(seq, c.sndUna), payloadLen);
		dv.setUint16(50, this.l4csum(f, c.ip, this.guest, PROTO_TCP, 34, hl + payloadLen));
		this.emit(f);
	}
	icmpInput(f, _dv, src, dst, l4, end) {
		if (f[l4] !== 8 || dst !== this.gw && dst !== this.dns) return;
		const len = end - l4;
		const [r, rv] = this.ipFrame(dst, src, PROTO_ICMP, len);
		r.set(f.subarray(l4, end), 34);
		r[34] = 0;
		rv.setUint16(36, 0);
		rv.setUint16(36, fold(sum16(r, 34, len)));
		this.emit(r);
	}
	icmpUnreachable(f, l4, src, dst, code) {
		const quote = f.subarray(14, Math.min(f.length, l4 + 8));
		const [r, rv] = this.ipFrame(dst, src, PROTO_ICMP, 8 + quote.length);
		r[34] = 3;
		r[35] = code;
		r.set(quote, 42);
		rv.setUint16(36, fold(sum16(r, 34, 8 + quote.length)));
		this.emit(r);
	}
	udpInput(f, dv, src, dst, l4, end) {
		if (end - l4 < 8) return;
		const sport = dv.getUint16(l4), dport = dv.getUint16(l4 + 2);
		const payload = f.subarray(l4 + 8, Math.min(end, l4 + dv.getUint16(l4 + 4)));
		if (dport === 67) return this.dhcp(payload);
		if (dport === 53 && (dst === this.dns || dst === this.gw)) {
			this.dnsQuery(payload, src, sport, dst);
			return;
		}
		if (dst === 4294967295 || dst >>> 28 === 14) return;
		this.icmpUnreachable(f, l4, src, dst, 3);
	}
	dhcp(p) {
		if (p.length < 240 || p[0] !== 1) return;
		if (new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(236) !== 1669485411) return;
		let type = 0;
		for (let i = 240; i < p.length && p[i] !== 255;) {
			if (p[i] === 0) {
				i++;
				continue;
			}
			if (p[i] === 53) type = p[i + 2];
			i += 2 + p[i + 1];
		}
		const reply = {
			1: 2,
			3: 5,
			8: 5
		}[type];
		if (!reply) return;
		const opts = [
			53,
			1,
			reply,
			54,
			4,
			...this.bytes4(this.gw)
		];
		if (type !== 8) opts.push(51, 4, ...this.bytes4(86400));
		opts.push(1, 4, ...this.bytes4(this.mask), 3, 4, ...this.bytes4(this.gw), 6, 4, ...this.bytes4(this.dns), 28, 4, ...this.bytes4((this.net | ~this.mask) >>> 0));
		if (this.mtu) opts.push(26, 2, this.mtu >> 8, this.mtu & 255);
		opts.push(255);
		const r = new Uint8Array(240 + opts.length);
		const rv = new DataView(r.buffer);
		r[0] = 2;
		r[1] = 1;
		r[2] = 6;
		r.set(p.subarray(4, 8), 4);
		r.set(p.subarray(10, 12), 10);
		r.set(p.subarray(12, 16), 12);
		if (type !== 8) rv.setUint32(16, this.guest);
		rv.setUint32(20, this.gw);
		r.set(p.subarray(28, 44), 28);
		rv.setUint32(236, 1669485411);
		r.set(opts, 240);
		const chaddr = p.slice(28, 34);
		this.sendUdp(this.gw, 67, 4294967295, 68, r, Uint8Array.of(255, 255, 255, 255, 255, 255));
		if (reply === 5) this.guestMac = chaddr;
	}
	bytes4(n) {
		return [
			n >>> 24,
			n >>> 16 & 255,
			n >>> 8 & 255,
			n & 255
		];
	}
	async dnsQuery(q, src, sport, dst) {
		if (q.length < 12) return;
		const dv = new DataView(q.buffer, q.byteOffset, q.byteLength);
		if (q[2] & 128 || dv.getUint16(4) !== 1) return;
		const labels = [];
		let i = 12;
		while (i < q.length && q[i] !== 0) {
			if (q[i] & 192) return;
			labels.push(new TextDecoder().decode(q.subarray(i + 1, i + 1 + q[i])));
			i += 1 + q[i];
		}
		if (i + 5 > q.length) return;
		const qtype = dv.getUint16(i + 1), qclass = dv.getUint16(i + 3);
		const qend = i + 5;
		const name = labels.join(".");
		this.stats.dns++;
		let rcode = 0, addrs = [];
		if (qtype === 1 && qclass === 1) try {
			addrs = await this.backend.lookup(name);
			addrs = addrs.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
			if (!addrs.length) rcode = 3;
		} catch (e) {
			const err = e;
			rcode = err?.code === "ENOTFOUND" || err?.code === "ENODATA" ? 3 : 2;
			if (rcode === 2) this.log?.(`[net] dns ${name}: ${err?.message ?? e}`);
		}
		const r = new Uint8Array(qend + addrs.length * 16);
		r.set(q.subarray(0, qend));
		const rv = new DataView(r.buffer);
		rv.setUint16(2, (q[2] & 1) << 8 | 32896 | rcode);
		rv.setUint16(6, addrs.length);
		rv.setUint16(8, 0);
		rv.setUint16(10, 0);
		let o = qend;
		for (const a of addrs) {
			rv.setUint16(o, 49164);
			rv.setUint16(o + 2, 1);
			rv.setUint16(o + 4, 1);
			rv.setUint32(o + 6, 60);
			rv.setUint16(o + 10, 4);
			rv.setUint32(o + 12, ip4$1(a));
			o += 16;
		}
		this.sendUdp(dst, 53, src, sport, r);
	}
	tcpInput(f, dv, _src, dst, l4, end) {
		if (end - l4 < 20) return;
		const hl = (f[l4 + 12] >> 4) * 4;
		const seg = {
			sport: dv.getUint16(l4),
			dport: dv.getUint16(l4 + 2),
			seq: dv.getUint32(l4 + 4),
			ack: dv.getUint32(l4 + 8),
			flags: f[l4 + 13],
			win: dv.getUint16(l4 + 14)
		};
		const payload = f.subarray(l4 + hl, end);
		const key = `${seg.sport}/${dst}/${seg.dport}`;
		let c = this.tcp.get(key);
		if ((seg.flags & 18) === SYN) {
			if (c && c.irs === seg.seq) return c.input(seg, payload);
			c?.close();
			for (let i = l4 + 20; i < l4 + hl;) {
				const kind = f[i];
				if (kind === 0) break;
				if (kind === 1) {
					i++;
					continue;
				}
				if (kind === 2) seg.mss = dv.getUint16(i + 2);
				if (kind === 3) seg.wscale = Math.min(f[i + 2], 14);
				i += Math.max(2, f[i + 1]);
			}
			c = new TcpConn(this, key, seg.sport, dst, seg.dport, seg);
			this.tcp.set(key, c);
			this.stats.tcpOpened++;
			c.connect();
			return;
		}
		if (c) return c.input(seg, payload);
		if (seg.flags & RST) return;
		const fake = {
			ip: dst,
			port: seg.dport,
			gport: seg.sport,
			rcvNxt: 0,
			sndUna: 0,
			sendq: null
		};
		if (seg.flags & ACK) this.sendTcp(fake, RST, seg.ack, 0, null, 0);
		else {
			fake.rcvNxt = seqAdd(seg.seq, payload.length + (seg.flags & FIN ? 1 : 0));
			this.sendTcp(fake, 20, 0, 0, null, 0);
		}
	}
};
const DEFAULT_WISP_SERVERS = Object.freeze(["wss://wisp.pi0.io:6680/"]);
const isBrowser = () => typeof globalThis.document !== "undefined" || typeof globalThis.WorkerGlobalScope !== "undefined";
const RETRY_MS$1 = 5e3;
const HANDSHAKE_TIMEOUT_MS = 1e4;
const MAX_PACKET = 65536;
const FAKE_BASE = 3323068416;
const FAKE_SIZE = 1 << 17;
const enc = new TextEncoder();
const CLOSE_REASONS = {
	1: "unspecified",
	3: "network error",
	65: "invalid info",
	66: "host unreachable",
	67: "connect timed out",
	68: "connection refused",
	71: "transfer timed out",
	72: "blocked by the proxy",
	73: "throttled"
};
function packet(type, id, payload) {
	const b = new Uint8Array(5 + (payload?.length ?? 0));
	b[0] = type;
	new DataView(b.buffer).setUint32(1, id, true);
	if (payload) b.set(payload, 5);
	return b;
}
const ip4 = (s) => s.split(".").reduce((a, b) => (a << 8 | Number(b)) >>> 0, 0);
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
function wispBackend(url, opts = {}) {
	const urls = typeof url === "string" ? [url] : [...url];
	const log = opts.log ?? (() => {});
	const name = (u) => DEFAULT_WISP_SERVERS.includes(u) ? "the default server" : u;
	const wsInit = opts.headers && !isBrowser() ? { headers: opts.headers } : void 0;
	let ws = null, ready = null, failedAt = -1e400, warned = false;
	let initialCredit = 0;
	let nextId = 1;
	const streams = /* @__PURE__ */ new Map();
	const nameToIp = /* @__PURE__ */ new Map(), ipToName = /* @__PURE__ */ new Map();
	let nextFake = 1;
	let connecting = [];
	function connectWs() {
		if (ready) return ready;
		if (performance.now() - failedAt < RETRY_MS$1) return Promise.reject(/* @__PURE__ */ new Error("wisp server unavailable"));
		ready = new Promise((resolve, reject) => {
			const t0 = performance.now();
			const sockets = connecting = [];
			let settled = false, pending = urls.length;
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				for (const s of sockets) s.close();
				ready = null;
				failedAt = performance.now();
				if (!warned) log(`[net] wisp ${urls.length > 1 ? "servers" : "server"} ${urls.map(name).join(", ")} unavailable; guest network offline`);
				warned = true;
				reject(/* @__PURE__ */ new Error("wisp server unavailable"));
			};
			const timer = setTimeout(fail, HANDSHAKE_TIMEOUT_MS);
			for (const u of urls) {
				let s;
				try {
					s = new WebSocket(u, wsInit);
				} catch {
					if (--pending === 0) fail();
					continue;
				}
				sockets.push(s);
				s.binaryType = "arraybuffer";
				s.onerror = () => {};
				s.onclose = () => {
					if (ws === s) {
						ws = null;
						ready = null;
						log("[net] wisp connection closed");
						for (const st of [...streams.values()]) st.closed(/* @__PURE__ */ new Error("wisp connection closed"));
					} else if (--pending === 0) fail();
				};
				s.onmessage = (e) => {
					const m = new Uint8Array(e.data);
					if (ws === s) return onPacket(m);
					if (settled || m.length < 9 || m[0] !== 3) return;
					settled = true;
					clearTimeout(timer);
					initialCredit = new DataView(m.buffer).getUint32(5, true);
					ws = s;
					warned = false;
					for (const o of sockets) if (o !== s) o.close();
					log(`[net] wisp connected: ${name(u)} (handshake ${Math.round(performance.now() - t0)} ms, buffer ${initialCredit} packets)`);
					resolve(s);
				};
			}
		});
		ready.catch(() => {});
		return ready;
	}
	function onPacket(m) {
		if (m.length < 5) return;
		const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
		const st = streams.get(dv.getUint32(1, true));
		if (!st) return;
		switch (m[0]) {
			case 2:
				st.ev.onData(m.subarray(5));
				break;
			case 3:
				if (m.length >= 9) {
					st.credit = dv.getUint32(5, true);
					st.pump();
				}
				break;
			case 4: {
				const r = m.length > 5 ? m[5] : 1;
				st.closed(r === 2 ? null : /* @__PURE__ */ new Error(`wisp: ${CLOSE_REASONS[r] ?? `close reason 0x${r.toString(16)}`}`));
				break;
			}
		}
	}
	return {
		connect({ host, port }, ev) {
			const id = nextId++;
			const name = isIPv4(host) ? ipToName.get(ip4(host)) ?? host : host;
			const st = {
				ev,
				credit: 0,
				out: [],
				outBytes: 0,
				done: false,
				scheduled: false,
				open: false,
				closed(err) {
					if (st.done) return;
					st.done = true;
					streams.delete(id);
					ev.onClose(err);
				},
				pump() {
					st.scheduled = false;
					if (!st.open || st.done || !ws) return;
					const before = st.outBytes;
					while (st.out.length && st.credit > 0) {
						let n = 0, k = 0;
						while (k < st.out.length && n + st.out[k].length <= MAX_PACKET) n += st.out[k++].length;
						if (k === 0) {
							n = st.out[0].length;
							k = 1;
						}
						const p = new Uint8Array(5 + n);
						p[0] = 2;
						new DataView(p.buffer).setUint32(1, id, true);
						let o = 5;
						for (const c of st.out.splice(0, k)) {
							p.set(c, o);
							o += c.length;
						}
						ws.send(p);
						st.credit--;
						st.outBytes -= n;
					}
					if (st.outBytes < before) ev.onDrain();
				}
			};
			streams.set(id, st);
			connectWs().then((s) => {
				if (st.done) return;
				const req = new Uint8Array(3 + enc.encode(name).length);
				req[0] = 1;
				new DataView(req.buffer).setUint16(1, port, true);
				req.set(enc.encode(name), 3);
				s.send(packet(1, id, req));
				st.credit = initialCredit;
				st.open = true;
				ev.onConnect();
				st.pump();
			}, (e) => queueMicrotask(() => st.closed(e)));
			return {
				write(u8) {
					if (st.done) return;
					st.out.push(u8.slice());
					st.outBytes += u8.length;
					if (!st.scheduled) {
						st.scheduled = true;
						queueMicrotask(st.pump);
					}
				},
				end() {},
				destroy() {
					if (st.done) return;
					st.done = true;
					streams.delete(id);
					if (st.open) ws?.send(packet(4, id, Uint8Array.of(2)));
				},
				pause() {},
				resume() {},
				get buffered() {
					return st.outBytes;
				}
			};
		},
		lookup(name) {
			if (isIPv4(name)) return Promise.resolve([name]);
			let ip = nameToIp.get(name);
			if (ip === void 0) {
				ip = FAKE_BASE + nextFake++ % FAKE_SIZE >>> 0;
				const old = ipToName.get(ip);
				if (old !== void 0) nameToIp.delete(old);
				nameToIp.set(name, ip);
				ipToName.set(ip, name);
			}
			return Promise.resolve([`${ip >>> 24}.${ip >>> 16 & 255}.${ip >>> 8 & 255}.${ip & 255}`]);
		},
		close() {
			ws?.close();
			if (!ws) for (const s of connecting) s.close();
		}
	};
}
const DEVICE_SPEC_VERSION = 1;
const coreDevices = {
	disks: { async http(spec, ctx) {
		return new CowDisk(await HttpBase.open(spec.url, { chunkSize: spec.chunkSize }), { log: ctx.log });
	} },
	backends: { wisp: (spec, ctx) => wispBackend(spec.servers, {
		headers: spec.headers,
		log: ctx.log
	}) }
};
function extendDevices(base, more) {
	return {
		disks: {
			...base.disks,
			...more.disks
		},
		backends: {
			...base.backends,
			...more.backends
		}
	};
}
const isPlain = (x) => typeof x === "object" && x !== null && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
function isDiskSpec(x) {
	return isPlain(x) && typeof x.kind === "string" && typeof x.read !== "function";
}
function isNetSpec(x) {
	return isPlain(x) && x.kind === "net" && isPlain(x.backend);
}
function checkVersion(spec, what) {
	if (spec.v !== void 0 && spec.v !== 1) throw new BootError("support", `${what} "${spec.kind}": spec version ${spec.v}, this SDK reads 1`);
}
async function buildDisks(items, registry, ctx) {
	const disks = [], skipped = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (!isDiskSpec(item)) {
			disks.push(item);
			continue;
		}
		const make = registry?.disks[item.kind];
		try {
			checkVersion(item, "disk kind");
			if (!make) throw new BootError("support", `disk kind "${item.kind}" is not available on this platform`);
			disks.push(await make(item, {
				...ctx,
				index
			}));
		} catch (e) {
			const reason = e?.message ?? String(e);
			if (!item.optional) throw e instanceof BootError ? e : new BootError("boot", `disk ${index} (${item.kind}): ${reason}`, { cause: e });
			ctx.log(`[host] disk ${index} (${item.kind}) left out: ${reason}`);
			skipped.push({
				index,
				kind: item.kind,
				reason
			});
		}
	}
	return {
		disks,
		skipped
	};
}
function buildNet(spec, registry, ctx) {
	checkVersion(spec, "net");
	const make = registry?.backends[spec.backend.kind];
	try {
		if (!make) throw new BootError("support", `network backend "${spec.backend.kind}" is not available on this platform`);
		return new NetStack({
			backend: make(spec.backend, {
				...ctx,
				index: 0
			}),
			hostLoopback: spec.hostLoopback,
			mtu: spec.mtu,
			mac: spec.mac,
			log: ctx.log
		});
	} catch (e) {
		if (!spec.optional) throw e;
		ctx.log(`[host] network left out: ${e?.message ?? e}`);
		return;
	}
}
const OUTPUT_BACKLOG = 1 << 20;
var ConsoleOutput = class {
	#listeners = /* @__PURE__ */ new Set();
	#backlog = [];
	#backlogHead = 0;
	#backlogBytes = 0;
	#stream;
	#controller;
	#closed = false;
	#ended;
	constructor(ended = () => false) {
		this.#ended = ended;
	}
	emit(bytes) {
		for (const l of this.#listeners) l(bytes);
		if (this.#controller) this.#controller.enqueue(bytes);
		else if (this.#backlog) {
			const b = this.#backlog;
			b.push(bytes);
			this.#backlogBytes += bytes.length;
			while (this.#backlogBytes > OUTPUT_BACKLOG && b.length - this.#backlogHead > 1) {
				this.#backlogBytes -= b[this.#backlogHead].length;
				b[this.#backlogHead++] = void 0;
			}
			if (this.#backlogHead > 1024 && this.#backlogHead * 2 > b.length) {
				b.splice(0, this.#backlogHead);
				this.#backlogHead = 0;
			}
		}
	}
	close() {
		this.#closed = true;
		try {
			this.#controller?.close();
		} catch {}
		this.#backlog = null;
	}
	get stream() {
		if (!this.#stream) {
			const backlog = this.#backlog?.slice(this.#backlogHead) ?? [];
			this.#backlog = null;
			this.#stream = new ReadableStream({ start: (c) => {
				for (const b of backlog) c.enqueue(b);
				if (this.#closed || this.#ended()) c.close();
				else this.#controller = c;
			} });
		}
		return this.#stream;
	}
	listen(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
};
const EVDEV_OP = {
	key: 0,
	button: 1,
	move: 2,
	wheel: 3,
	moveTo: 4,
	tabletButton: 5,
	tabletWheel: 6,
	releaseAll: 7
};
const MOTION_BATCH_MS = 8;
const FRAME_CREDITS = 2;
const SOUND_REPORT_MS = 15;
const sharedNow = () => performance.timeOrigin + performance.now();
var RemoteEvdev = class {
	mask = 0;
	#post;
	#ops = [];
	#urgent = false;
	#timer;
	#micro = false;
	#keys = /* @__PURE__ */ new Set();
	#buttons = /* @__PURE__ */ new Set();
	#tabletButtons = /* @__PURE__ */ new Set();
	#shared;
	constructor(post, shared) {
		this.#post = post;
		this.#shared = shared;
	}
	get keyboardOpen() {
		return !!(this.mask & 1);
	}
	get mouseOpen() {
		return !!(this.mask & 2);
	}
	get tabletOpen() {
		return !!(this.mask & 4);
	}
	get state() {
		return {
			keyboard: this.keyboardOpen,
			mouse: this.mouseOpen,
			tablet: this.tabletOpen
		};
	}
	setMask(mask) {
		const closed = this.mask & ~mask;
		this.mask = mask >>> 0;
		if (closed & 1) this.#keys.clear();
		if (closed & 2) this.#buttons.clear();
		if (closed & 4) this.#tabletButtons.clear();
	}
	#held(set, open, op, code, down) {
		if (down) {
			if (!open) return false;
			if (!set.has(code)) {
				set.add(code);
				this.#queue(op, code, 1);
			}
			return true;
		}
		if (!set.delete(code)) return false;
		this.#queue(op, code, 0);
		return true;
	}
	key(code, down) {
		return this.#held(this.#keys, this.keyboardOpen, EVDEV_OP.key, code, down);
	}
	button(code, down) {
		return this.#held(this.#buttons, this.mouseOpen, EVDEV_OP.button, code, down);
	}
	tabletButton(code, down) {
		return this.#held(this.#tabletButtons, this.tabletOpen, EVDEV_OP.tabletButton, code, down);
	}
	move(dx, dy) {
		if (!this.mouseOpen) return false;
		this.#queue(EVDEV_OP.move, dx, dy, true);
		return true;
	}
	wheel(clicks) {
		if (!this.mouseOpen) return false;
		if (Math.round(clicks)) this.#queue(EVDEV_OP.wheel, clicks, 0, true);
		return true;
	}
	moveTo(x, y) {
		if (!this.tabletOpen) return false;
		this.#queue(EVDEV_OP.moveTo, x, y, true);
		return true;
	}
	tabletWheel(clicks) {
		if (!this.tabletOpen) return false;
		if (Math.round(clicks)) this.#queue(EVDEV_OP.tabletWheel, clicks, 0, true);
		return true;
	}
	releaseAll() {
		for (const c of [...this.#keys]) this.key(c, false);
		for (const b of [...this.#buttons]) this.button(b, false);
		for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
	}
	#queue(op, a, b, motion = false) {
		if (this.#shared) return this.#shared.evdev(op, a, b);
		this.#ops.push(op, a, b);
		if (!motion) this.#urgent = true;
		if (this.#urgent) {
			if (!this.#micro) {
				this.#micro = true;
				queueMicrotask(() => this.flush());
			}
		} else this.#timer ??= setTimeout(() => this.flush(), MOTION_BATCH_MS);
	}
	flush() {
		clearTimeout(this.#timer);
		this.#timer = void 0;
		this.#micro = false;
		this.#urgent = false;
		if (!this.#ops.length) return;
		const ops = this.#ops;
		this.#ops = [];
		this.#post({
			t: "evdev",
			ops
		});
	}
	close() {
		clearTimeout(this.#timer);
		this.#ops = [];
	}
};
var FrameClient = class {
	mode = null;
	#seq = 0;
	#post;
	#shared;
	#latest = null;
	#spare = [];
	#outstanding = 0;
	#nextId = 1;
	#waiters = /* @__PURE__ */ new Map();
	#closed = false;
	constructor(post, shared) {
		this.#post = post;
		this.#shared = shared;
	}
	get #viaShared() {
		return !!this.#shared?.frames.ready;
	}
	get seq() {
		return this.#viaShared ? this.#shared.frames.seq : this.#seq;
	}
	#want(now) {
		const id = this.#nextId++;
		const buf = this.#spare.pop();
		this.#outstanding++;
		this.#post(buf ? {
			t: "frame-want",
			id,
			buf,
			now
		} : {
			t: "frame-want",
			id,
			now
		}, buf ? [buf] : []);
		return id;
	}
	request() {
		if (this.#closed || !this.mode) return;
		if (this.#viaShared) return this.#shared.wantFrame();
		if (this.#outstanding >= FRAME_CREDITS) return;
		this.#want(false);
	}
	frame(out) {
		this.request();
		if (this.#viaShared) return this.mode ? this.#shared.frames.frame(out) : null;
		const f = this.#latest;
		if (!f || !this.mode) return null;
		return {
			width: f.mode.width,
			height: f.mode.height,
			data: xrgbToRgba(f.data, f.mode.width, f.mode.height, out)
		};
	}
	read(out) {
		if (this.#closed) return Promise.resolve(this.frame(out));
		if (this.#viaShared) {
			const id = this.#nextId++;
			return new Promise((resolve) => {
				this.#waiters.set(id, () => resolve(this.mode && this.#viaShared ? this.#shared.frames.frame(out) : null));
				this.#shared.wantFrameNow(id);
			});
		}
		return new Promise((resolve) => {
			this.#waiters.set(this.#want(true), () => resolve(this.#latest && this.mode ? this.frame(out) : null));
		});
	}
	adoptBuffer(buffer, cap) {
		this.#shared?.frames.adopt(buffer, cap);
	}
	ready(id) {
		for (const [w, resolve] of this.#waiters) {
			if (w > id) continue;
			this.#waiters.delete(w);
			resolve(true);
		}
	}
	setMode(mode) {
		this.mode = mode;
		if (!mode) this.#drop();
	}
	#drop() {
		if (this.#latest) {
			this.#keep(this.#latest.data.buffer);
			this.#latest = null;
		}
	}
	#keep(buf) {
		if (this.#spare.length < FRAME_CREDITS) this.#spare.push(buf);
	}
	receive(id, mode, data) {
		this.#outstanding = Math.max(0, this.#outstanding - 1);
		if (data && mode) {
			this.#drop();
			this.#latest = {
				mode,
				data
			};
			this.#seq++;
		} else if (!mode) this.#drop();
		const w = this.#waiters.get(id);
		this.#waiters.delete(id);
		w?.(true);
	}
	close() {
		this.#closed = true;
		for (const w of this.#waiters.values()) w(false);
		this.#waiters.clear();
	}
};
var SoundBridge = class {
	state = {
		open: false,
		playing: false,
		format: null
	};
	#sink;
	#post;
	#log;
	#lastReport = -1e400;
	constructor(sink, post, log) {
		this.#sink = sink;
		this.#post = post;
		this.#log = log;
	}
	get playing() {
		return this.state.playing;
	}
	onState(state, event) {
		this.state = state;
		if (event === "start") this.#lastReport = -1e400;
		try {
			this.#sink.onState?.(state, event);
		} catch (e) {
			this.#log(`[sound] onState failed: ${e}`);
		}
	}
	onChunk(seq, format, data) {
		const chunk = {
			format,
			data,
			frames: Math.floor(data.length / format.frameBytes)
		};
		let queued = 0;
		try {
			queued = this.#sink.onChunk?.(chunk);
		} catch (e) {
			this.#log(`[sound] onChunk failed: ${e}`);
		}
		const now = sharedNow();
		if (now - this.#lastReport < SOUND_REPORT_MS) return;
		this.#lastReport = now;
		this.#post({
			t: "sound-queued",
			seq,
			frames: Math.max(0, Math.round(queued || 0)),
			at: now
		});
	}
};
const BELL = 0;
const IDLE = 1;
const FRAME_WANT = 2;
const FRAME_NOW = 3;
const CON_HEAD = 4;
const CON_TAIL = 5;
const EV_HEAD = 6;
const EV_TAIL = 7;
const CON_SIZE = 8;
const CTL_BYTES = 64;
const CON_CAP = 65536;
const EV_CAP = 4096;
const CTL_SIZE = 163904;
const RETRY_MS = 2;
const F_STATE = 0;
const F_SLOT = 4;
const FRESH = 4;
const FRAME_DATA = 64;
function sharedMemoryAvailable() {
	if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object") return false;
	if (globalThis.crossOriginIsolated === false) return false;
	if (typeof MessageChannel !== "function") return true;
	const ch = new MessageChannel();
	try {
		ch.port1.postMessage(new SharedArrayBuffer(8));
		return true;
	} catch {
		return false;
	} finally {
		ch.port1.close();
		ch.port2.close();
	}
}
function newSharedControl() {
	return new SharedArrayBuffer(CTL_SIZE);
}
var SharedOwner = class {
	#ctl;
	#con;
	#ev;
	#post;
	#conPending = [];
	#evPending = [];
	#retry;
	#closed = false;
	frames = new SharedFrames();
	constructor(buffer, post) {
		this.#ctl = new Int32Array(buffer, 0, CTL_BYTES / 4);
		this.#con = new Uint8Array(buffer, CTL_BYTES, CON_CAP);
		this.#ev = new Float64Array(buffer, 65600, EV_CAP * 3);
		this.#post = post;
	}
	writeConsole(bytes) {
		if (this.#closed || !bytes.length) return;
		this.#conPending.push(bytes);
		this.#pump();
	}
	evdev(op, a, b) {
		if (this.#closed) return;
		this.#evPending.push(op, a, b);
		this.#pump();
	}
	resize(cols, rows) {
		if (this.#closed || !cols || !rows) return;
		Atomics.store(this.#ctl, CON_SIZE, Math.min(rows, 65535) << 16 | Math.min(cols, 65535));
		this.#ring();
	}
	wantFrame() {
		if (this.#closed || Atomics.load(this.#ctl, FRAME_WANT)) return;
		Atomics.store(this.#ctl, FRAME_WANT, 1);
		this.#ring();
	}
	wantFrameNow(id) {
		if (this.#closed) return;
		Atomics.store(this.#ctl, FRAME_NOW, id);
		this.#ring();
	}
	close() {
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#conPending = [];
		this.#evPending = [];
	}
	#pump() {
		const c = this.#ctl;
		let wrote = false;
		if (this.#conPending.length) {
			let head = Atomics.load(c, CON_HEAD);
			const tail = Atomics.load(c, CON_TAIL);
			let free = CON_CAP - (head - tail | 0);
			while (this.#conPending.length && free > 0) {
				const chunk = this.#conPending[0];
				const n = Math.min(free, chunk.length);
				const at = head & 65535;
				const first = Math.min(n, CON_CAP - at);
				this.#con.set(chunk.subarray(0, first), at);
				if (n > first) this.#con.set(chunk.subarray(first, n), 0);
				head = head + n | 0;
				free -= n;
				if (n === chunk.length) this.#conPending.shift();
				else this.#conPending[0] = chunk.subarray(n);
				wrote = true;
			}
			Atomics.store(c, CON_HEAD, head);
		}
		if (this.#evPending.length) {
			let head = Atomics.load(c, EV_HEAD);
			const tail = Atomics.load(c, EV_TAIL);
			const free = EV_CAP - (head - tail | 0);
			const n = Math.min(free, this.#evPending.length / 3);
			const q = this.#evPending;
			for (let i = 0; i < n; i++) {
				const at = (head + i & 4095) * 3;
				this.#ev[at] = q[i * 3];
				this.#ev[at + 1] = q[i * 3 + 1];
				this.#ev[at + 2] = q[i * 3 + 2];
			}
			if (n) {
				head = head + n | 0;
				Atomics.store(c, EV_HEAD, head);
				q.splice(0, n * 3);
				wrote = true;
			}
		}
		if (wrote) this.#ring();
		if ((this.#conPending.length || this.#evPending.length) && this.#retry === void 0) this.#retry = setTimeout(() => {
			this.#retry = void 0;
			if (!this.#closed) this.#pump();
		}, RETRY_MS);
	}
	#ring() {
		Atomics.add(this.#ctl, BELL, 1);
		if (Atomics.compareExchange(this.#ctl, IDLE, 1, 2) === 1) this.#post({ t: "kick" });
	}
};
var SharedFrames = class {
	#i32 = null;
	#buf = null;
	#cap = 0;
	#front = 0;
	#pinned = false;
	ready = false;
	adopt(buffer, cap) {
		this.ready = !!buffer;
		this.#buf = buffer;
		this.#i32 = buffer ? new Int32Array(buffer, 0, FRAME_DATA / 4) : null;
		this.#cap = cap;
		this.#front = 0;
		this.#pinned = false;
	}
	#acquire() {
		const h = this.#i32;
		if (!h || this.#pinned) return;
		this.#pinned = true;
		queueMicrotask(() => this.#pinned = false);
		if (Atomics.load(h, F_STATE) & FRESH) this.#front = Atomics.exchange(h, F_STATE, this.#front) & 3;
	}
	get seq() {
		this.#acquire();
		return this.#i32 ? Atomics.load(this.#i32, F_SLOT + this.#front * 4 + 2) : 0;
	}
	frame(out) {
		this.#acquire();
		const h = this.#i32;
		if (!h) return null;
		const s = F_SLOT + this.#front * 4;
		const width = h[s], height = h[s + 1];
		if (!width || !height) return null;
		return {
			width,
			height,
			data: xrgbToRgba(new Uint8Array(this.#buf, FRAME_DATA + this.#front * this.#cap, width * height * 4), width, height, out)
		};
	}
};
const STOP_GRACE_MS = 12e3;
const SPEC_HINT = "pass a spec instead: { kind: \"file\", path } on Node, { kind: \"data\", template: \"bundled\" } or { kind: \"http\", url } in browsers";
const NET_HINT = "pass a spec instead: { kind: \"net\", backend: { kind: \"direct\" } } on Node, or { kind: \"net\", backend: { kind: \"wisp\", servers } }";
const STATS_INTERVAL_MS = 500;
function checkWorkerOptions(platform, opts) {
	if (!platform.spawnWorker) throw new BootError("support", "createKernel({ worker: true }) is not supported on this platform");
	const objects = (opts.disks ?? []).map((d, i) => isDiskSpec(d) ? -1 : i).filter((i) => i >= 0);
	if (objects.length) throw new BootError("support", `createKernel({ worker: true }): disks[${objects.join("], disks[")}] ${objects.length > 1 ? "are BlockDevice objects, which" : "is a BlockDevice object, which"} cannot cross to the worker; ${SPEC_HINT}`);
	if (opts.net && !isNetSpec(opts.net)) throw new BootError("support", `createKernel({ worker: true }): net is a NetDevice or NetBackend object, which cannot cross to the worker; ${NET_HINT}`);
	if (typeof opts.vsock === "object" && opts.vsock.raw) throw new BootError("support", "createKernel({ worker: true }): vsock.raw (the guest's packets in a callback) is inline only; use vm.vsock, which works in worker mode");
}
function toWorkerDisks(specs, platform) {
	const transfer = [];
	return [specs.map((s) => {
		if (s.kind === "data" && s.template instanceof Uint8Array) {
			const copy = s.template.slice();
			transfer.push(copy.buffer);
			return {
				...s,
				template: copy
			};
		}
		if (s.kind === "http" && !hasScheme(s.url)) {
			const url = platform.absoluteUrl?.(s.url);
			if (!url) throw new BootError("download", `cannot resolve the relative disk URL ${s.url} for the worker`);
			return {
				...s,
				url
			};
		}
		return { ...s };
	}), transfer];
}
function toWorkerRestore(s, transfer) {
	if (!s) return [void 0, []];
	const m = s.memory;
	const whole = m.buffer instanceof ArrayBuffer && m.byteOffset === 0 && m.byteLength === m.buffer.byteLength;
	const memory = transfer && whole ? m : m.slice();
	return [{
		...s,
		memory
	}, [memory.buffer]];
}
function hasScheme(s) {
	return /^[a-z][a-z0-9+.-]+:/i.test(s);
}
async function toWorkerSource(src, platform, what, onProgress, signal) {
	if (src instanceof WebAssembly.Module) return [src, []];
	if (src instanceof URL) return [src.href, []];
	if (typeof src === "string") {
		if (hasScheme(src)) return [src, []];
		const abs = platform.absoluteUrl?.(src) ?? (typeof location === "object" && location?.href ? new URL(src, location.href).href : void 0);
		if (!abs) throw new BootError("download", `cannot resolve the relative ${what} location ${src} for the worker`);
		return [abs, []];
	}
	const copy = (src instanceof Response ? await loadBytes(src, {
		what,
		onProgress,
		signal
	}) : src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength)).slice();
	return [copy, [copy.buffer]];
}
function displayNow(opt, log) {
	if (typeof opt !== "function") return opt ?? false;
	try {
		const s = opt();
		return {
			width: s.width,
			height: s.height,
			dpi: s.dpi
		};
	} catch (e) {
		log(`[display] size callback failed: ${e}`);
		return true;
	}
}
var WorkerKernel = class {
	cmdline = "";
	memoryMiB = 0;
	memory64 = false;
	exited;
	started;
	#endpoint;
	#out = new ConsoleOutput();
	#input;
	#onOutput;
	#onProgress;
	#log;
	#stats;
	#statsAt = 0;
	#result;
	#isStarted = false;
	#resolveExit;
	#resolveStarted;
	#rejectStarted;
	#syncs = /* @__PURE__ */ new Map();
	#nextSync = 1;
	#disks = [];
	#skipped = [];
	#diskOps = /* @__PURE__ */ new Map();
	#onDiskError;
	#stopTimer;
	#displayOpt;
	#displaySize;
	#onDisplay;
	#onInput;
	#evdev;
	#frames;
	#sound;
	#soundState;
	#shared;
	#console;
	#encoder;
	#vsock;
	#vsockOut = [];
	#mounts;
	#shm;
	#shmCalls = /* @__PURE__ */ new Map();
	#nextShm = 1;
	#snapshots = /* @__PURE__ */ new Map();
	constructor(endpoint, opts) {
		this.#endpoint = endpoint;
		this.#onDiskError = opts.onDiskError;
		this.#onOutput = opts.onOutput;
		this.#onProgress = opts.onProgress;
		this.#log = opts.log;
		this.#displayOpt = opts.display;
		this.#displaySize = JSON.stringify(displayNow(opts.display, opts.log));
		this.#onDisplay = opts.onDisplay;
		this.#onInput = opts.onInput;
		const post = (m, transfer) => {
			if (!this.#result) endpoint.post(m, transfer);
		};
		if (opts.shared) this.#shared = new SharedOwner(opts.shared, post);
		if (opts.console) {
			this.#console = new ConsoleRingReader(new ConsoleRing(opts.console), (b) => this.#emit(b.bytes));
			this.#console.start();
		}
		if (opts.display) {
			this.#evdev = new RemoteEvdev(post, this.#shared);
			this.#frames = new FrameClient(post, this.#shared);
		}
		const sound = opts.sound;
		if (sound) {
			this.#soundState = {
				open: false,
				playing: false,
				format: null
			};
			if (typeof sound === "object") this.#sound = new SoundBridge(sound, post, opts.log);
		}
		if (opts.vsock) {
			const flush = () => {
				const packets = this.#vsockOut;
				this.#vsockOut = [];
				if (packets.length) post({
					t: "vsock",
					packets
				}, packets.map((p) => p.buffer));
			};
			this.#vsock = new VsockHost({
				send: (pkt) => {
					if (this.#vsockOut.push(pkt) === 1) queueMicrotask(flush);
				},
				bufferSize: typeof opts.vsock === "object" ? opts.vsock.bufferSize : void 0,
				log: opts.log
			});
		}
		this.#mounts = new MountTable(this.#vsock, opts.log);
		if (opts.shm) this.#shm = new ShmClient({ run: (call) => new Promise((resolve, reject) => {
			if (this.#result) {
				reject(new ShmError("ECONNABORTED", `${call.op}: the kernel exited`));
				return;
			}
			const rid = this.#nextShm++;
			this.#shmCalls.set(rid, {
				resolve,
				reject
			});
			post({
				t: "shm",
				rid,
				call
			});
		}) });
		this.exited = new Promise((r) => this.#resolveExit = r);
		this.started = new Promise((resolve, reject) => {
			this.#resolveStarted = resolve;
			this.#rejectStarted = reject;
		});
		endpoint.listen({
			message: (m) => this.#message(m),
			error: (e) => {
				const msg = e?.stack ?? String(e);
				this.#log(`[host] kernel worker error: ${msg}`);
				this.#finish({
					code: 255,
					reason: `kernel worker error: ${e?.message ?? e}`,
					kind: "fatal",
					error: e
				});
			},
			exit: () => this.#finish({
				code: 255,
				reason: "the kernel worker exited unexpectedly",
				kind: "fatal"
			})
		});
	}
	#message(m) {
		switch (m.t) {
			case "ready":
				this.#onProgress({
					stage: "worker",
					jspi: m.jspi
				});
				break;
			case "output":
				this.#emit(m.bytes);
				break;
			case "log":
				this.#log(m.msg);
				break;
			case "progress":
				this.#onProgress(m.p);
				break;
			case "started":
				this.cmdline = m.cmdline;
				this.memoryMiB = m.memoryMiB;
				this.memory64 = m.memory64;
				this.#setStats(m.stats);
				this.#disks = m.disks;
				this.#skipped = m.skipped;
				this.#isStarted = true;
				this.#resolveStarted();
				break;
			case "boot-error":
				this.#rejectStarted(new BootError(m.stage, m.message));
				this.#finish({
					code: 1,
					reason: m.message,
					kind: "fatal"
				});
				break;
			case "stats":
				this.#setStats(m.stats);
				this.#disks = m.disks;
				break;
			case "disk-error": {
				const e = Object.assign(new Error(m.error.message), {
					name: m.error.name,
					stack: m.error.stack
				});
				try {
					this.#onDiskError?.(m.index, e);
				} catch {}
				break;
			}
			case "disk-result": {
				const op = this.#diskOps.get(m.id);
				this.#diskOps.delete(m.id);
				if (m.ok) op?.resolve(m.value);
				else op?.reject(new Error(m.error));
				break;
			}
			case "synced":
				this.#syncs.get(m.id)?.(m.ok);
				this.#syncs.delete(m.id);
				break;
			case "display":
				this.#frames?.setMode(m.mode);
				try {
					this.#onDisplay?.(m.mode);
				} catch {}
				break;
			case "input-state":
				this.#evdev?.setMask(m.mask);
				if (this.#evdev) try {
					this.#onInput?.(this.#evdev.state);
				} catch {}
				break;
			case "frame":
				this.#frames?.receive(m.id, m.mode, m.data);
				break;
			case "frame-buffer":
				this.#frames?.adoptBuffer(m.buffer, m.cap);
				break;
			case "frame-ready":
				this.#frames?.ready(m.id);
				break;
			case "sound-state":
				this.#soundState = m.state;
				this.#sound?.onState(m.state, m.event);
				break;
			case "sound-chunk":
				this.#sound?.onChunk(m.seq, m.format, m.data);
				break;
			case "vsock":
				if (this.#vsock) for (const p of m.packets) this.#vsock.receive(p);
				break;
			case "vsock-ready":
				this.#vsock?.deviceReady(m.guestCid, m.rxMax);
				break;
			case "shm-result": {
				const c = this.#shmCalls.get(m.rid);
				if (!c) break;
				this.#shmCalls.delete(m.rid);
				if (m.ok) c.resolve(m.value);
				else c.reject(new ShmError(m.code, m.message));
				break;
			}
			case "shm-attach":
				this.#shm?.update(m.info);
				break;
			case "shm-detach":
				this.#shm?.detached(m.id);
				break;
			case "snapshot-result": {
				const w = this.#snapshots.get(m.id);
				this.#snapshots.delete(m.id);
				if (m.ok) w?.resolve(m.snapshot);
				else w?.reject(new Error(m.error));
				break;
			}
			case "exit":
				this.#setStats(m.stats);
				this.#disks = m.disks;
				this.#finish(m.result);
		}
	}
	abandon(reason) {
		this.started.catch(() => {});
		this.#finish({
			code: 1,
			reason,
			kind: "fatal"
		});
	}
	#setStats(stats) {
		this.#stats = stats;
		this.#statsAt = performance.now();
	}
	#emit(bytes) {
		this.#onOutput?.(bytes);
		this.#out.emit(bytes);
	}
	#finish(res) {
		if (this.#result) return;
		const con = this.#console;
		if (con) {
			con.take();
			con.stop();
			con.ring.close();
		}
		this.#result = res;
		clearTimeout(this.#stopTimer);
		this.#evdev?.close();
		this.#frames?.close();
		this.#shared?.close();
		this.#mounts.shutdown();
		this.#vsock?.shutdown();
		for (const c of this.#shmCalls.values()) c.reject(new ShmError("ECONNABORTED", "the kernel exited"));
		this.#shmCalls.clear();
		this.#shm?.shutdown();
		if (!this.#isStarted) this.#rejectStarted(new BootError("boot", res.reason, { cause: res.error }));
		this.#out.close();
		const persistent = this.#disks.some((d) => d.persistent);
		for (const resolve of this.#syncs.values()) resolve(!persistent);
		this.#syncs.clear();
		for (const op of this.#diskOps.values()) op.reject(/* @__PURE__ */ new Error(`the kernel worker has ended (${res.reason})`));
		this.#diskOps.clear();
		for (const w of this.#snapshots.values()) w.reject(/* @__PURE__ */ new Error(`snapshot: the kernel worker has ended (${res.reason})`));
		this.#snapshots.clear();
		this.#endpoint.terminate();
		this.#resolveExit(res);
	}
	get output() {
		return this.#out.stream;
	}
	onOutput(listener) {
		return this.#out.listen(listener);
	}
	write(data) {
		if (this.#result) return;
		if (typeof data !== "string" && !data.length) return;
		if (this.#shared) this.#shared.writeConsole(typeof data === "string" ? (this.#encoder ??= new TextEncoder()).encode(data) : data.slice());
		else this.#endpoint.post({
			t: "input",
			data
		});
	}
	get transport() {
		return this.#shared ? "shared" : "messages";
	}
	get input() {
		return this.#input ??= new WritableStream({ write: (chunk) => this.write(chunk) });
	}
	resize(cols, rows) {
		if (this.#result) return;
		if (this.#shared) this.#shared.resize(cols, rows);
		else this.#endpoint.post({
			t: "resize",
			cols,
			rows
		});
		this.updateDisplaySize();
	}
	updateDisplaySize() {
		if (this.#result || typeof this.#displayOpt !== "function") return;
		const size = displayNow(this.#displayOpt, this.#log);
		const key = JSON.stringify(size);
		if (key === this.#displaySize || typeof size !== "object") return;
		this.#displaySize = key;
		this.#endpoint.post({
			t: "display-size",
			size
		});
	}
	get bootDisplay() {
		return this.#displayOpt ? JSON.parse(this.#displaySize) : false;
	}
	get evdev() {
		return this.#evdev;
	}
	get display() {
		const f = this.#frames;
		return f ? { get mode() {
			return f.mode;
		} } : void 0;
	}
	frame(out) {
		return this.#frames?.frame(out) ?? null;
	}
	requestFrame() {
		this.#frames?.request();
	}
	get frameSeq() {
		return this.#frames?.seq ?? 0;
	}
	readFrame(out) {
		return this.#frames?.read(out) ?? Promise.resolve(null);
	}
	get vsock() {
		return this.#vsock;
	}
	spawn(file, args, opts) {
		return this.#mounts.gate(() => spawnOn(this.#vsock, file, args, opts));
	}
	exec(file, args, opts) {
		return this.#mounts.gate(() => execOn(this.#vsock, file, args, opts));
	}
	connect(port, opts) {
		return this.#mounts.gate(() => connectOn(this.#vsock, port, opts));
	}
	fetch(input, init) {
		return fetchOver((port, o) => this.connect(port, o), input, init);
	}
	mount(path, fs, opts) {
		return this.#mounts.mount(path, fs, opts);
	}
	get mounts() {
		return this.#mounts.mounts;
	}
	startMounts(list) {
		this.#mounts.mountAll(list);
	}
	get shm() {
		return this.#shm;
	}
	get sound() {
		const s = this.#soundState;
		return s ? {
			state: s,
			playing: s.playing
		} : void 0;
	}
	sync(opts = {}) {
		if (this.#result) return Promise.resolve(true);
		const id = this.#nextSync++;
		return new Promise((resolve) => {
			this.#syncs.set(id, resolve);
			this.#endpoint.post({
				t: "sync",
				id,
				timeout: opts.timeout
			});
		});
	}
	snapshot(opts = {}) {
		if (this.#result) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: the kernel has exited (${this.#result.reason})`));
		const why = this.#mounts.snapshotBlocker();
		if (why) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: ${why}`));
		const id = this.#nextSync++;
		return new Promise((resolve, reject) => {
			this.#snapshots.set(id, {
				resolve,
				reject
			});
			this.#endpoint.post({
				t: "snapshot",
				id,
				stop: opts.stop
			});
		});
	}
	stop(res = {}) {
		if (!this.#result && this.#stopTimer === void 0) {
			this.#endpoint.post({
				t: "stop",
				code: res.code,
				reason: res.reason
			});
			this.#stopTimer = setTimeout(() => this.#finish({
				code: res.code ?? 0,
				reason: res.reason ?? "stopped by the host",
				kind: "stopped"
			}), STOP_GRACE_MS);
		}
		return this.exited;
	}
	get disks() {
		return this.#disks;
	}
	get skippedDisks() {
		return this.#skipped;
	}
	#diskOp(index, op) {
		if (this.#result) return Promise.reject(/* @__PURE__ */ new Error(`the kernel has exited (${this.#result.reason})`));
		const id = this.#nextSync++;
		return new Promise((resolve, reject) => {
			this.#diskOps.set(id, {
				resolve,
				reject
			});
			this.#endpoint.post({
				t: "disk",
				id,
				index,
				op
			});
		});
	}
	async detachDisk(index) {
		await this.#diskOp(index, "detach");
	}
	exportDisk(index) {
		return this.#diskOp(index, "export");
	}
	stats() {
		const s = this.#stats;
		const vsock = this.#vsock ? { ...this.#vsock.stats } : void 0;
		return {
			...s,
			vsock,
			shm: this.#shm?.stats,
			uptimeMs: this.#result || !s.uptimeMs ? s.uptimeMs : s.uptimeMs + performance.now() - this.#statsAt
		};
	}
};
async function createKernelInWorker(platform, opts, progress) {
	const { signal } = opts;
	const src = opts.kernel ?? platform.defaultKernel();
	const compileHere = !opts.compileInWorker && !(src instanceof WebAssembly.Module);
	const log = opts.log ?? ((m) => console.error(m));
	const canShare = opts.shared !== false && sharedMemoryAvailable();
	if (opts.shared === true && !canShare) throw new BootError("support", "createKernel({ worker: true, shared: true }): SharedArrayBuffer cannot be used here (a browser page must be cross-origin isolated: COOP same-origin and COEP require-corp)");
	const shared = canShare ? newSharedControl() : void 0;
	const consoleRing = shared && (opts.cpus ?? 1) > 1 ? newConsoleRing() : void 0;
	const endpoint = platform.spawnWorker();
	const vm = new WorkerKernel(endpoint, {
		onOutput: opts.onOutput,
		onProgress: progress,
		log,
		onDiskError: opts.onDiskError,
		display: opts.display,
		onDisplay: opts.onDisplay,
		onInput: opts.onInput,
		sound: opts.sound,
		vsock: opts.vsock ?? true,
		shm: opts.shm,
		shared,
		console: consoleRing
	});
	let spec, transfer;
	try {
		let kernel, kernelTransfer = [], compileMs;
		if (compileHere) {
			const t0 = performance.now();
			progress({ stage: "compile" });
			kernel = await loadKernelModule(src, {
				what: "kernel",
				readFile: platform.readFile,
				onProgress: progress,
				signal,
				smp: (opts.cpus ?? 1) > 1
			});
			compileMs = performance.now() - t0;
			progress({
				stage: "compiled",
				ms: compileMs,
				memory64: moduleIsMemory64(kernel)
			});
		} else [kernel, kernelTransfer] = await toWorkerSource(src, platform, "kernel", progress, signal);
		const [initrd, initrdTransfer] = opts.initrd == null ? [opts.initrd, []] : await toWorkerSource(opts.initrd, platform, "initrd", progress, signal);
		if (initrd instanceof WebAssembly.Module) throw new BootError("download", "initrd: a WebAssembly.Module is not an initramfs");
		if (signal?.aborted) throw new BootError("download", "aborted", { cause: signal.reason });
		const [disks, diskTransfer] = toWorkerDisks(opts.disks ?? [], platform);
		const [restore, restoreTransfer] = toWorkerRestore(opts.restore, !!opts.transferRestore);
		spec = {
			kernel,
			initrd,
			disks,
			net: opts.net,
			cmdline: opts.cmdline,
			memoryMiB: opts.memoryMiB ?? platform.defaultMemoryMiB?.() ?? 512,
			memoryFallbackMiB: opts.memoryFallbackMiB ?? platform.defaultMemoryFallbackMiB,
			memory64: opts.memory64,
			jit: opts.jit,
			cpus: opts.cpus,
			consoleSize: opts.consoleSize,
			statsIntervalMs: STATS_INTERVAL_MS,
			compileMs,
			display: vm.bootDisplay,
			sound: opts.sound ? {
				rate: typeof opts.sound === "object" ? opts.sound.rate : void 0,
				chunks: typeof opts.sound === "object" && !!opts.sound.onChunk
			} : false,
			vsock: !!(opts.vsock ?? true),
			shm: !!opts.shm,
			shared,
			console: consoleRing,
			restore
		};
		transfer = [
			...kernelTransfer,
			...initrdTransfer,
			...diskTransfer,
			...restoreTransfer
		];
	} catch (e) {
		vm.abandon(e?.message ?? String(e));
		throw e;
	}
	if (signal) {
		const onAbort = () => endpoint.post({ t: "abort" });
		signal.addEventListener("abort", onAbort, { once: true });
		vm.exited.then(() => signal.removeEventListener("abort", onAbort));
	}
	try {
		endpoint.post({
			t: "boot",
			spec
		}, transfer);
	} catch (e) {
		if (!(compileHere && (typeof src === "string" || src instanceof URL || src instanceof ArrayBuffer || ArrayBuffer.isView(src)))) {
			vm.abandon(e?.message ?? String(e));
			throw new BootError("support", `cannot send the kernel to the worker: ${e?.message ?? e}`, { cause: e });
		}
		log(`[host] the compiled kernel could not be posted to the worker (${e?.message ?? e}); the worker loads it itself`);
		try {
			const [kernel, kernelTransfer] = await toWorkerSource(src, platform, "kernel", progress, signal);
			endpoint.post({
				t: "boot",
				spec: {
					...spec,
					kernel,
					compileMs: void 0
				}
			}, [...transfer, ...kernelTransfer]);
		} catch (e2) {
			vm.abandon(e2?.message ?? String(e2));
			throw e2;
		}
	}
	await vm.started;
	return vm;
}
function isBackend(n) {
	return typeof n.connect === "function" && typeof n.send !== "function";
}
var KernelInstance = class {
	kernel;
	module;
	cmdline;
	net;
	skippedDisks = [];
	#owned = [];
	exited;
	#out;
	#input;
	#compileMs;
	#vsock;
	#shm;
	#mounts = new MountTable(void 0, () => {});
	constructor(kernel, module, cmdline, net, compileMs) {
		this.kernel = kernel;
		this.module = module;
		this.cmdline = cmdline;
		this.net = net;
		this.#compileMs = compileMs;
		this.#out = new ConsoleOutput(() => !!kernel.result);
		if (kernel.shm.enabled) this.#shm = inlineShm(kernel.shm);
		this.exited = kernel.exited.then((res) => {
			this.#mounts.shutdown();
			this.#vsock?.shutdown();
			this.#shm?.shutdown();
			this.#closeNet();
			this.#out.close();
			this.#closeDisks();
			return res;
		});
	}
	attachVsock(host) {
		this.#vsock = host;
		const mounts = this.#mounts = new MountTable(host, host.log);
		this.kernel.vsock.onSave = () => mounts.save();
		this.kernel.vsock.hostBusy = () => mounts.snapshotBusy();
	}
	async restoreMounts(snap, list) {
		const { keep, rest } = await this.#mounts.restore(snap.devices?.vsock?.mounts, list);
		this.kernel.vsock.keep = keep;
		return rest;
	}
	startMounts(list) {
		this.#mounts.mountAll(list);
	}
	get vsock() {
		return this.#vsock;
	}
	spawn(file, args, opts) {
		return this.#mounts.gate(() => spawnOn(this.#vsock, file, args, opts));
	}
	exec(file, args, opts) {
		return this.#mounts.gate(() => execOn(this.#vsock, file, args, opts));
	}
	connect(port, opts) {
		return this.#mounts.gate(() => connectOn(this.#vsock, port, opts));
	}
	fetch(input, init) {
		return fetchOver((port, o) => this.connect(port, o), input, init);
	}
	mount(path, fs, opts) {
		return this.#mounts.mount(path, fs, opts);
	}
	get mounts() {
		return this.#mounts.mounts;
	}
	get shm() {
		return this.#shm;
	}
	own(disks) {
		this.#owned.push(...disks);
	}
	async settled() {
		await Promise.all(this.kernel.block.disks.map((d) => d.saving?.catch(() => {})));
	}
	async #closeDisks() {
		await this.settled();
		for (const d of this.#owned) try {
			const c = d;
			if (typeof c.close === "function") c.close();
			else await c.store?.close?.();
		} catch {}
	}
	emit(bytes) {
		this.#out.emit(bytes);
	}
	get output() {
		return this.#out.stream;
	}
	onOutput(listener) {
		return this.#out.listen(listener);
	}
	write(data) {
		this.kernel.sendInput(data);
	}
	get input() {
		return this.#input ??= new WritableStream({ write: (chunk) => this.write(chunk) });
	}
	resize(cols, rows) {
		this.kernel.setConsoleSize(cols, rows);
	}
	sync(opts = {}) {
		return this.kernel.requestSync(opts);
	}
	snapshot(opts = {}) {
		const why = this.#mounts.snapshotBlocker(true);
		if (why) return Promise.reject(/* @__PURE__ */ new Error(`snapshot: ${why}`));
		return this.kernel.snapshot(opts);
	}
	stop(res = {}) {
		this.kernel.stop(res);
		return this.exited;
	}
	stats() {
		const k = this.kernel;
		return {
			...k.stats,
			uptimeMs: k.bootTime ? performance.now() - k.bootTime : 0,
			cpus: k.cpus,
			compileMs: this.#compileMs,
			block: { ...k.block.stats },
			jit: k.jitStatsAll(),
			jitCpus: k.cpus > 1 ? k.jitStatsPerCpu() : void 0,
			kwemu: k.jit.kwemuStats(),
			kwemuCpus: k.cpus > 1 ? k.kwemuStatsPerCpu() : void 0,
			net: this.net instanceof NetStack ? { ...this.net.stats } : void 0,
			display: k.display.enabled ? { ...k.display.stats } : void 0,
			evdev: k.evdev.enabled ? { ...k.evdev.stats } : void 0,
			sound: k.sound.enabled ? { ...k.sound.stats } : void 0,
			vsock: this.#vsock ? { ...this.#vsock.stats } : void 0,
			shm: this.#shm?.stats
		};
	}
	get transport() {
		return "inline";
	}
	get sound() {
		return this.kernel.sound.enabled ? this.kernel.sound : void 0;
	}
	get memoryMiB() {
		return this.kernel.memory.buffer.byteLength / 1048576;
	}
	get memory64() {
		return this.kernel.memory64;
	}
	get display() {
		return this.kernel.display.enabled ? this.kernel.display : void 0;
	}
	get evdev() {
		return this.kernel.evdev.enabled ? this.kernel.evdev : void 0;
	}
	frame(out) {
		return this.kernel.display.enabled ? this.kernel.display.readRGBA(out) : null;
	}
	readFrame(out) {
		return Promise.resolve(this.frame(out));
	}
	#closeNet() {
		const n = this.net;
		try {
			n?.close?.();
			if (n instanceof NetStack) n.backend.close?.();
		} catch {}
	}
};
async function createKernelOn(platform, opts = {}) {
	if (typeof WebAssembly !== "object" || typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function") throw new BootError("support", "This engine has no JSPI (WebAssembly.Suspending / WebAssembly.promising), which the kernel needs");
	const { signal, onProgress } = opts;
	const progress = (p) => {
		try {
			onProgress?.(p);
		} catch {}
	};
	const vopt = opts.vsock ?? true;
	const raw = typeof vopt === "object" ? vopt.raw : void 0;
	const mounts = parseMounts(opts.mounts, !!vopt && !raw);
	const savedMounts = opts.restore?.devices?.vsock?.mounts;
	if (savedMounts?.mounts.length && (opts.worker || raw)) throw new BootError("boot", `snapshot: it has host file systems (${savedMounts.mounts.map((m) => m.path).join(", ")}), which resume inline only (not in worker mode or with vsock.raw)`);
	const mountsWhy = opts.restore && snapshotMountMismatch(savedMounts, mounts);
	if (mountsWhy) throw new BootError("boot", `snapshot: ${mountsWhy}`);
	if (opts.worker) {
		checkWorkerOptions(platform, opts);
		const vm = await createKernelInWorker(platform, opts, progress);
		vm.startMounts(mounts);
		return vm;
	}
	const loadOpts = {
		signal,
		readFile: platform.readFile,
		onProgress: progress
	};
	const t0 = performance.now();
	const kernelSource = opts.kernel ?? platform.defaultKernel();
	if (!(kernelSource instanceof WebAssembly.Module)) progress({ stage: "compile" });
	const [module, initrdBytes] = await Promise.all([loadKernelModule(kernelSource, {
		...loadOpts,
		what: "kernel",
		smp: (opts.cpus ?? 1) > 1
	}), opts.initrd == null ? opts.initrd : loadBytes(opts.initrd, {
		...loadOpts,
		what: "initrd"
	})]);
	const compileMs = kernelSource instanceof WebAssembly.Module ? 0 : performance.now() - t0;
	if (!(kernelSource instanceof WebAssembly.Module)) progress({
		stage: "compiled",
		ms: compileMs,
		memory64: moduleIsMemory64(module)
	});
	if (signal?.aborted) throw new BootError("download", "aborted", { cause: signal.reason });
	const bundled = bundledBoot(module);
	const initrd = initrdBytes === void 0 ? bundled.initrd ?? null : initrdBytes;
	const log = opts.log ?? ((m) => console.error(m));
	const devCtx = {
		module,
		log,
		onDiskError: (i, e) => {
			try {
				opts.onDiskError?.(i, e);
			} catch {}
		}
	};
	const items = opts.disks ?? [];
	const { disks, skipped } = await buildDisks(items, platform.devices, devCtx);
	const owned = disks.filter((d) => !items.includes(d));
	const cmdline = opts.cmdline ?? (initrdBytes === void 0 && bundled.initrd && bundled.cmdline ? bundled.cmdline : disks.length && !initrd ? "console=hvc0 root=/dev/wda rw" : "console=hvc0 rdinit=/init");
	const net = !opts.net ? void 0 : isNetSpec(opts.net) ? buildNet(opts.net, platform.devices, devCtx) : isBackend(opts.net) ? new NetStack({
		backend: opts.net,
		log: opts.log
	}) : opts.net;
	let kernelRef;
	const vsock = vopt && !raw ? new VsockHost({
		send: (pkt) => kernelRef?.vsock.deliver(pkt),
		bufferSize: typeof vopt === "object" ? vopt.bufferSize : void 0,
		log
	}) : void 0;
	let instance;
	let started;
	const startedP = new Promise((r) => started = r);
	const kernel = new Kernel({
		module,
		initrd,
		cmdline,
		disks,
		net,
		memoryMiB: opts.memoryMiB ?? platform.defaultMemoryMiB?.() ?? 512,
		memoryFallbackMiB: opts.memoryFallbackMiB ?? platform.defaultMemoryFallbackMiB,
		memory64: opts.memory64,
		jit: opts.jit,
		cpus: opts.cpus,
		spawnCpu: platform.spawnCpu,
		whyNoCpus: platform.whyNoCpus,
		consoleRing: opts.consoleRing,
		flushOutput: opts.flushOutput,
		restore: opts.restore,
		display: opts.display,
		onDisplay: opts.onDisplay,
		onInput: opts.onInput,
		sound: opts.sound,
		vsock: !!vopt,
		onVsockPacket: raw ? raw.onPacket : vsock && ((pkt) => vsock.receive(pkt)),
		onVsockInit: raw ? raw.onInit : vsock && ((cid, rxMax) => vsock.deviceReady(cid, rxMax)),
		shm: !!opts.shm,
		log: opts.log,
		write: (bytes) => {
			opts.onOutput?.(bytes);
			instance?.emit(bytes);
		},
		onStage: (stage, detail) => {
			if (stage === "memory") progress({
				stage,
				...detail
			});
			else if (stage === "instantiate") progress({ stage });
			else if (stage === "start") {
				progress({
					stage,
					cmdline
				});
				started();
			}
		}
	});
	kernelRef = kernel;
	instance = new KernelInstance(kernel, module, cmdline, net, compileMs);
	if (vsock) instance.attachVsock(vsock);
	instance.skippedDisks = skipped;
	instance.own(owned);
	if (opts.consoleSize) kernel.setConsoleSize(opts.consoleSize.cols, opts.consoleSize.rows);
	let rest = mounts;
	if (opts.restore && vsock) try {
		rest = await instance.restoreMounts(opts.restore, mounts);
	} catch (e) {
		instance.stop({
			code: 1,
			reason: e.message
		});
		throw new BootError("boot", `snapshot: host file systems: ${e.message}`, { cause: e });
	}
	const booting = kernel.boot();
	try {
		await Promise.race([startedP, booting]);
	} catch (e) {
		const err = e;
		instance.stop({
			code: 1,
			reason: err.message
		});
		throw new BootError(err.name === "MemoryAllocationError" ? "memory" : "boot", err.message, { cause: e });
	}
	booting.catch(() => {});
	instance.startMounts(rest);
	if (signal) {
		const onAbort = () => instance.stop({
			code: 130,
			reason: "aborted"
		});
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			instance.exited.then(() => signal.removeEventListener("abort", onAbort));
		}
	}
	return instance;
}
const KSTAMP = /^\[ *(\d+\.\d+)\]/;
const KMAYBE = /^\[ *(\d+(\.\d*)?)?$/;
const IMPORTANT = /Kernel panic|Oops|BUG:|WARNING:|Out of memory|Killed process|segfault|unhandled signal|soft lockup|blocked for more than/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
var ConsoleRouter = class {
	userspace = false;
	#opts;
	#dec = new TextDecoder();
	#gate = "start";
	#hold = "";
	#kline = "";
	#holdTimer;
	#dmesgBlock = false;
	#lastKTime = -1;
	#seen = /* @__PURE__ */ new Set();
	#seenOrder = [];
	#userTail = "";
	constructor(opts = {}) {
		this.#opts = opts;
	}
	write(data) {
		this.#route(typeof data === "string" ? data : this.#dec.decode(data, { stream: true }));
	}
	flush() {
		clearTimeout(this.#holdTimer);
		this.#releaseHold();
	}
	#releaseHold() {
		if (this.#gate === "start" && this.#hold) {
			this.#gate = "user";
			this.#dmesgBlock = false;
			const h = this.#hold;
			this.#hold = "";
			this.#userOutput(h);
		}
	}
	#markUserspace(why) {
		if (this.userspace) return;
		this.userspace = true;
		this.#opts.onUserspace?.(why);
	}
	#userOutput(text) {
		this.#opts.onUserOutput?.(text);
		if (this.userspace) return;
		this.#userTail += text;
		let i;
		while (!this.userspace && (i = this.#userTail.indexOf("\n")) >= 0) {
			const line = this.#userTail.slice(0, i).replace(ANSI, "").replace(/\r/g, "");
			this.#userTail = this.#userTail.slice(i + 1);
			if (line.trim()) this.#markUserspace(`first output: ${line.trim().slice(0, 60)}`);
		}
		if (this.userspace) {
			this.#userTail = "";
			return;
		}
		if (this.#userTail.length > 8192) this.#userTail = this.#userTail.slice(-1024);
		if (/[#$%>] ?$/.test(this.#userTail.replace(ANSI, ""))) this.#markUserspace("shell prompt");
	}
	#kernelLine(raw) {
		const line = raw.replace(/\r/g, "").replace(/\n$/, "");
		const t = Number(KSTAMP.exec(line)[1]);
		if (this.#dmesgBlock || t < this.#lastKTime || this.#seen.has(line)) {
			this.#dmesgBlock = true;
			this.#userOutput(raw);
			return;
		}
		this.#lastKTime = t;
		this.#seen.add(line);
		if (this.#seenOrder.push(line) > 4096) this.#seen.delete(this.#seenOrder.shift());
		this.#opts.onKernelLine?.(line, {
			time: t,
			important: IMPORTANT.test(line),
			raw
		});
	}
	#route(s) {
		clearTimeout(this.#holdTimer);
		while (s) {
			if (this.#gate === "start") {
				s = this.#hold + s;
				this.#hold = "";
				if (KSTAMP.test(s)) this.#gate = "kern";
				else if (KMAYBE.test(s)) {
					this.#hold = s;
					this.#holdTimer = setTimeout(() => this.#releaseHold(), this.#opts.holdMs ?? 250);
					return;
				} else {
					this.#gate = "user";
					this.#dmesgBlock = false;
				}
			}
			const i = s.indexOf("\n");
			const part = i < 0 ? s : s.slice(0, i + 1);
			s = i < 0 ? "" : s.slice(i + 1);
			if (this.#gate === "user") this.#userOutput(part);
			else if (this.#kline.length < 8192) this.#kline += part;
			if (i >= 0) {
				if (this.#gate === "kern") this.#kernelLine(this.#kline);
				this.#kline = "";
				this.#gate = "start";
			}
		}
	}
};
const JSPI_TEST = new Uint8Array([
	0,
	97,
	115,
	109,
	1,
	0,
	0,
	0,
	1,
	5,
	1,
	96,
	0,
	1,
	127,
	2,
	7,
	1,
	1,
	109,
	1,
	102,
	0,
	0,
	3,
	2,
	1,
	0,
	7,
	5,
	1,
	1,
	103,
	0,
	1,
	10,
	6,
	1,
	4,
	0,
	16,
	0,
	11
]);
const MEMORY64_TEST = new Uint8Array([
	0,
	97,
	115,
	109,
	1,
	0,
	0,
	0,
	5,
	3,
	1,
	4,
	0
]);
async function checkJspi(timeoutMs = 5e3) {
	const missing = [];
	if (typeof WebAssembly.Suspending !== "function") missing.push("WebAssembly.Suspending");
	if (typeof WebAssembly.promising !== "function") missing.push("WebAssembly.promising");
	if (missing.length) return {
		ok: false,
		why: `${missing.join(" and ")} not defined (no JSPI)`
	};
	try {
		const f = new WebAssembly.Suspending(() => new Promise((r) => setTimeout(() => r(42), 0)));
		const inst = new WebAssembly.Instance(new WebAssembly.Module(JSPI_TEST), { m: { f } });
		const g = WebAssembly.promising(inst.exports.g);
		let timer;
		const result = await Promise.race([g().then((v) => v === 42 ? { ok: true } : {
			ok: false,
			why: `JSPI test returned ${v}`
		}, (e) => ({
			ok: false,
			why: `JSPI test threw: ${e.message}`
		})), new Promise((r) => {
			timer = setTimeout(() => r({
				ok: false,
				why: `JSPI test did not resume within ${timeoutMs / 1e3} s`
			}), timeoutMs);
		})]);
		clearTimeout(timer);
		return result;
	} catch (e) {
		return {
			ok: false,
			why: `JSPI present but unusable: ${e.message}`
		};
	}
}
async function checkSupport() {
	const problems = [];
	const wasm = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
	if (!wasm) problems.push("WebAssembly is unavailable");
	const bigint = typeof BigInt === "function";
	if (!bigint) problems.push("BigInt is required for 64-bit WebAssembly values");
	let jspi = false;
	if (wasm) {
		const j = await checkJspi();
		jspi = j.ok;
		if (!j.ok) problems.push(j.why);
	}
	let memory64 = false;
	try {
		memory64 = wasm && WebAssembly.validate(MEMORY64_TEST);
	} catch {}
	return {
		ok: !problems.length,
		wasm,
		bigint,
		jspi,
		memory64,
		problems
	};
}
export { ABS_MAX, ABS_X, ABS_Y, ANSI, BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, BootError, ConsoleRouter, CowDisk, DEFAULT_DISPLAY_SIZE, DEFAULT_WISP_SERVERS, DEVICE_SPEC_VERSION, DOM_CODE_TO_LINUX, DisplayHost, EV_ABS, EV_KEY, EV_REL, EV_SYN, FOURCC_XRGB8888, F_DISCARD, F_FLUSH, F_RO, F_WRITE_ZEROES, FlushTracker, FsError, HTTP_MAX_HEADER_BYTES, HttpBase, IMPORTANT, INPUT_KEYBOARD, INPUT_MOUSE, INPUT_TABLET, IRQ_SYNC, InputHost, JitHost, KSTAMP, KWSPARSE_MAGIC, Kernel, KernelInstance, MemoryFs, MountError, NetStack, PtyError, REL_WHEEL, REL_X, REL_Y, SHM_PAGE_SIZE, SOUND_FORMAT_S16_LE, SOUND_FORMAT_U8, ShmClient, ShmDevice, ShmError, SoundHost, SparseBase, TTY_FEATURE_CONNECT, TTY_FEATURE_PIPES, TTY_PORT, TTY_SIGNALS, TTY_VERSION, TtyFrameParser, VSOCK_GUEST_CID, VSOCK_HEADER_SIZE, VSOCK_HOST_CID, VsockDevice, VsockError, VsockHost, WorkerKernel, ZERO_BLOCK, ZeroBase, bundledBoot, checkJspi, checkSupport, connectGuest, convertPcm, coreDevices, createKernelOn, decodeKwsparse, decodeSnapshot, decodeVsockHeader, domButtonToLinux, domCodeToLinux, download, encodeKwsparse, encodeSnapshot, encodeTtyFrame, encodeTtyOpen, encodeTtyResize, encodeVsockPacket, execSubprocess, extendDevices, fetchOver, frameToPpm, gunzipIfNeeded, gzipBlob, inlineShm, ip4$1 as ip4, ip4str, isDiskSpec, isNetSpec, isZeroBlock, kwsparseHeader, loadBytes, loadKernelModule, moduleIsMemory64, pcmToFloat32, readKwsparse, sharedMemoryAvailable, smpKernelFromBundle, snapshotDeviceMismatch, snapshotDiskMismatch, spawnPty, spawnSubprocess, wavHeader, wispBackend, xrgbToRgba };
