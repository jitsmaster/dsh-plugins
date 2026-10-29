window.__ModuleLoader__.load({
	id: "dsh-api-call-tab",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect } = React;

		const SLOT = "conversation.trajectory.detail.tabs";
		const NOT_CAPTURED = "API call not captured for this request";

		const PRE_STYLE = { margin: 0, padding: 8, maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, background: "rgba(127,127,127,0.12)", borderRadius: 4 };
		const HEAD_STYLE = { display: "flex", alignItems: "center", gap: 8, margin: "12px 0 4px", fontWeight: 600 };

		// =====================================================================================
		// Pure helpers (exported through exports.__test)
		// =====================================================================================

		const str = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
		const list = (v) => (Array.isArray(v) ? v : []);

		/** Pretty JSON that never throws (circular / BigInt values fall back to String). */
		function safeJson(value) {
			try { const s = JSON.stringify(value, null, 2); return s === undefined ? "" : s; } catch (_e) { return str(value); }
		}

		function copyText(text) {
			try {
				const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
				if (clip && typeof clip.writeText === "function") clip.writeText(text).catch(() => {});
			} catch (_e) { /* clipboard unavailable */ }
		}

		// `copy` is a string or a thunk; a thunk keeps large text from being built until the button is clicked.
		function Section(p) {
			return h("section", { "data-api-call-section": p.title },
				h("div", { style: HEAD_STYLE },
					h("span", null, p.title),
					p.copy === undefined ? null : h("button", { type: "button", onClick: () => copyText(typeof p.copy === "function" ? p.copy() : p.copy), style: { fontSize: 11 } }, "Copy")),
				p.children);
		}

		const Block = (text) => h("pre", { style: PRE_STYLE }, text);

		// The schema block is only built while the tool's <details> is open.
		function ToolItem(props) {
			const t = props.tool && typeof props.tool === "object" ? props.tool : {};
			const [open, setOpen] = useState(false);
			return h("details", { style: { margin: "4px 0" }, onToggle: (e) => setOpen(!!(e && e.currentTarget && e.currentTarget.open)) },
				h("summary", null, h("strong", null, str(t.name)), t.description ? " \u2014 " + str(t.description).split("\n")[0] : ""),
				open ? h("div", null,
					t.description ? Block(str(t.description)) : null,
					h("div", { style: { fontSize: 11, opacity: 0.7 } }, "inputSchema"),
					Block(safeJson(t.inputSchema))) : null);
		}

		function truncationNote(p) {
			const sizes = [["stdin", p.stdinBytes], ["system", p.systemBytes], ["tools", p.toolsBytes]]
				.filter((e) => typeof e[1] === "number").map((e) => e[0] + " " + e[1] + " bytes");
			return "The stored payload was truncated." + (sizes.length ? " Original sizes: " + sizes.join(", ") + "." : "");
		}

		function PayloadViewImpl(props) {
			const p = props.payload && typeof props.payload === "object" ? props.payload : {};
			const argv = list(p.argv).map(str);
			const env = list(p.envKeys).map(str);
			const tools = list(p.tools);
			return h("div", { style: { padding: 8 } },
				p.truncated ? h("div", { role: "note", style: { padding: 6, border: "1px solid currentColor", borderRadius: 4 } }, truncationNote(p)) : null,
				h(Section, { title: "Command line", copy: () => argv.join(" ") }, Block(argv.join("\n"))),
				h(Section, { title: "Environment variable names", copy: () => env.join("\n") }, Block(env.join("\n"))),
				h(Section, { title: "System prompt", copy: () => str(p.system) }, Block(str(p.system))),
				h(Section, { title: "Tools (" + tools.length + ")", copy: () => safeJson(tools) },
					tools.map((tool, i) => h(ToolItem, { key: i, tool }))),
				h(Section, { title: "Stdin", copy: () => str(p.stdin) }, Block(str(p.stdin))));
		}
		// Memoised: the table re-renders while a session streams, and the payload object itself never changes.
		const PayloadView = typeof React.memo === "function" ? React.memo(PayloadViewImpl) : PayloadViewImpl;

		function ApiCallTab(props) {
			const record = (props && props.record) || {};
			const read = props && props.readRequestPayload;
			const blob = record.payloadBlob;
			const unavailable = blob === undefined || typeof read !== "function";
			const [state, setState] = useState({ blob: undefined, status: unavailable ? "missing" : "loading" });
			useEffect(() => {
				let live = true;
				const done = (next) => { if (live) setState({ blob, ...next }); };
				if (unavailable) {
					done({ status: "missing" });
					return () => { live = false; };
				}
				let pending;
				try { pending = Promise.resolve(read(blob)); } catch (_e) { pending = Promise.reject(_e); }
				pending.then(
					(r) => done(r && r.ok === true && r.value !== undefined && r.value !== null ? { status: "ready", payload: r.value } : { status: "missing" }),
					() => done({ status: "missing" }),
				);
				return () => { live = false; };
			}, [blob, unavailable]);

			// A result for another blob (render between the change and the effect) counts as loading.
			const current = state.blob === blob ? state : { status: unavailable ? "missing" : "loading" };
			if (current.status === "loading") return h("div", { style: { padding: 8 } }, "Loading...");
			if (current.status === "missing") return h("div", { style: { padding: 8, opacity: 0.8 } }, NOT_CAPTURED);
			return h(PayloadView, { payload: current.payload });
		}

		// =====================================================================================
		// Plugin entry
		// =====================================================================================

		const inject = ["slots"];

		function apply(ctx) {
			// Slot missing (older DSH) or any registration error must never break the plugin; the effect stays for unload.
			ctx.effect(() => {
				try {
					return ctx.slots.inject(SLOT, () => ctx.slots.register({
						name: SLOT, id: "api-call", label: () => "API Call", order: 10,
						// Assistant items only; one without a recorded payload still shows the "not captured" note.
						when: (record) => !!record && record.kind === "message",
					}, ApiCallTab));
				} catch (_e) { /* trajectory detail tab slot unavailable */ }
			}, "api-call-tab: trajectory detail tab");
		}

		exports.inject = inject;
		exports.apply = apply;
		exports.ApiCallTab = ApiCallTab;
		exports.__test = { ApiCallTab, PayloadView, safeJson, truncationNote };
		return module.exports;
	},
});
