window.__ModuleLoader__.load({
	id: "dsh-hooks-tts",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		const STATUS_URL = `http://${location.hostname || "127.0.0.1"}:3081/status`;
		const SETTINGS_URL = STATUS_URL.replace(/\/status$/, "/settings");
		// /status is a local JSON snapshot the host re-samples on every step, so polling it is cheap.
		const POLL_MS = 3000;
		const PANEL_ID = "usage";
		const SESSION_RE = /session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;

		const fmt = (n) => n === undefined || n === null ? "?" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
		const pc = (p) => p === undefined || p === null ? "–" : p + "%";

		// ---- shared polling store (one fetch loop feeds the panel and the overlay) ----
		let status = null;
		let failed = false;
		const listeners = new Set();
		const emit = () => listeners.forEach((l) => l());
		async function poll() {
			try {
				const res = await fetch(STATUS_URL, { cache: "no-store" });
				status = await res.json();
				failed = false;
			} catch (_e) { failed = true; }
			emit();
		}
		function useStatus() {
			const [, force] = React.useState(0);
			React.useEffect(() => {
				const l = () => force((n) => n + 1);
				listeners.add(l);
				return () => { listeners.delete(l); };
			}, []);
			return { status, failed };
		}

		// ---- left-panel "Usage" page: cross-session usage ----
		// "1:59pm" when the reset is today, "Oct 7, 4:59pm" otherwise (matches Claude Code's /usage).
		function fmtReset(iso) {
			if (!iso) return "";
			const d = new Date(iso);
			const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
			const today = new Date().toDateString() === d.toDateString();
			return "Resets " + (today ? time : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + time);
		}
		function Bar({ label, data, sub }) {
			const p = Math.min(100, data && data.pct || 0);
			const color = p >= 90 ? "#e5484d" : p >= 70 ? "#f5a524" : "#3e9b6b";
			return h("div", { style: { marginBottom: 18 } },
				h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 } },
					h("strong", null, label), h("span", null, pc(data && data.pct))),
				h("div", { style: { height: 8, borderRadius: 4, background: "rgba(128,128,128,.25)", overflow: "hidden" } },
					h("div", { style: { width: p + "%", height: "100%", background: color, transition: "width .3s" } })),
				h("div", { style: { fontSize: 12, opacity: 0.7, marginTop: 4 } },
					sub));
		}
		// Editable plugin setting: the context cap. The host re-reads it on every step.
		function CapSetting({ current }) {
			const [val, setVal] = React.useState("");
			const [msg, setMsg] = React.useState("");
			const dirty = React.useRef(false);
			React.useEffect(() => {
				if (!dirty.current && current !== undefined && current !== null) setVal(String(Math.round(current / 1000)));
			}, [current]);
			const save = async () => {
				const n = Number(val);
				if (val === "" || !Number.isFinite(n) || n < 0) { setMsg("Enter a number ≥ 0 (0 turns the cap off)"); return; }
				try {
					const res = await fetch(SETTINGS_URL, {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ contextCapTokens: Math.round(n * 1000) }),
					});
					if (res.status === 404) throw new Error("the plugin host is running an older version without this setting — restart dsh web");
					const body = await res.json().catch(() => ({}));
					if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
					dirty.current = false;
					setMsg("Saved — applies from the next step");
					poll();
				} catch (e) {
					const m = e && e.message || String(e);
					setMsg("Failed: " + (/Failed to fetch|NetworkError/i.test(m) ? "could not reach the plugin host (restart dsh web to load the latest plugin code)" : m));
				}
			};
			const box = { padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", width: 110 };
			return h("div", { style: { marginTop: 24, paddingTop: 16, borderTop: "1px solid rgba(128,128,128,.25)" } },
				h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, "Context Cap for Handoff"),
				h("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 8 } },
					"Above this many context tokens the agent stops and writes a handoff note. 0 turns it off."),
				h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
					h("input", { type: "number", min: 0, step: 10, value: val, style: box,
						onChange: (e) => { dirty.current = true; setVal(e.target.value); },
						onKeyDown: (e) => { if (e.key === "Enter") save(); } }),
					h("span", { style: { fontSize: 12, opacity: 0.8 } }, "k tokens"),
					h("button", { onClick: save, style: { ...box, width: "auto", cursor: "pointer" } }, "Save")),
				msg ? h("div", { style: { fontSize: 12, marginTop: 6, opacity: 0.8 } }, msg) : null);
		}
		// Quick on/off switches for boolean settings (TTS read-outs, auto-resume after handoff).
		function Toggle({ label, hint, field, current }) {
			const [busy, setBusy] = React.useState(false);
			const [err, setErr] = React.useState("");
			const on = current !== false; // default true until the status service says otherwise
			const flip = async () => {
				setBusy(true); setErr("");
				try {
					const res = await fetch(SETTINGS_URL, {
						method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ [field]: !on }),
					});
					const b = await res.json().catch(() => ({}));
					if (!res.ok) throw new Error(b.error || ("HTTP " + res.status));
					if (b[field] !== !on) throw new Error("the plugin host did not apply it - it is running older code, restart dsh web");
					poll();
				} catch (e) {
					setErr("Failed: " + (e && e.message || String(e)) + " (restart dsh web to load the latest plugin code?)");
				} finally { setBusy(false); }
			};
			return h("div", { style: { marginBottom: 12 } },
				h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
					h("button", {
						onClick: flip, disabled: busy, role: "switch", "aria-checked": on,
						style: {
							padding: "6px 12px", borderRadius: 6, cursor: "pointer", minWidth: 64, color: "inherit",
							border: "1px solid " + (on ? "#30a46c" : "rgba(128,128,128,.4)"),
							background: on ? "rgba(48,164,108,.2)" : "transparent",
						},
					}, on ? "On" : "Off"),
					h("div", null,
						h("div", { style: { fontSize: 13, fontWeight: 600 } }, label),
						h("div", { style: { fontSize: 12, opacity: 0.7 } }, hint))),
				err ? h("div", { style: { fontSize: 12, color: "#e5484d", marginTop: 4 } }, err) : null);
		}
		function UsagePage() {
			const { status: s, failed: bad } = useStatus();
			const u = s && s.usage;
			const c = s && s.claude;
			const limits = (c && c.limits) || [];
			return h("div", { style: { height: "100%", maxHeight: "100vh", overflowY: "auto", boxSizing: "border-box" } },
			h("div", { style: { padding: 24, maxWidth: 520 } },
				h("h2", { style: { margin: "0 0 4px" } }, "Hooks and Usage"),
				h("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 20 } },
					"Claude plan limits, across all sessions · refreshes every 30s" + (c && c.updatedAt ? ` · updated ${new Date(c.updatedAt).toLocaleTimeString()}` : "")),
				bad ? h("div", { style: { color: "#e5484d", marginBottom: 12 } }, "Status service unreachable (is dsh-hooks-tts loaded?)") : null,
				c && c.error ? h("div", { style: { color: "#f5a524", marginBottom: 12, fontSize: 12 } }, "Claude usage: " + c.error + (limits.length ? " (showing last reading)" : "")) : null,
				limits.map((l) => h(Bar, { key: l.kind + l.label, label: l.label, data: { pct: l.percent }, sub: fmtReset(l.resetsAt) })),
				u ? h("div", { style: { fontSize: 12, opacity: 0.6, marginTop: 8 } },
					`DSH tokens (local): ${fmt(u.fiveHour.tokens)} in the last 5h · ${fmt(u.weekly.tokens)} in the last 7 days`) : null,
				h("div", { style: { marginTop: 24, paddingTop: 16, borderTop: "1px solid rgba(128,128,128,.25)" } },
					h(Toggle, { label: "TTS hooks", hint: "Spoken read-outs for finished replies, questions and permission requests.", field: "ttsEnabled", current: s && s.settings && s.settings.ttsEnabled }),
					h(Toggle, { label: "Auto-resume after handoff", hint: "When a handoff note is written, start a new session that picks it up.", field: "autoResumeHandoff", current: s && s.settings && s.settings.autoResumeHandoff }),
					h(Toggle, { label: "Always allow full access", hint: "Force every session to full access with no approval prompts. Off by default.", field: "alwaysFullAccess", current: s && s.settings && s.settings.alwaysFullAccess })),
				h(CapSetting, { current: s && s.settings && s.settings.contextCapTokens })));
		}
		function UsageIcon({ size }) {
			const n = size || 16;
			return h("svg", { width: n, height: n, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" },
				h("path", { d: "M2.5 13.5h11" }), h("path", { d: "M4.5 11V7.5" }), h("path", { d: "M8 11V3.5" }), h("path", { d: "M11.5 11V6" }));
		}

		// ---- per-session overlay (bottom-right): worktree + context ----
		// Last good reading per session: a poll that briefly lacks the session (host restart,
		// agent re-created, URL without an id) must not blank the display.
		const lastGood = new Map();
		let lastShownId;
		// The session whose conversation is on screen. Set by ActiveProbe, a zero-size dock entry that
		// DSH mounts inside the visible conversation and hands that session's id.
		let activeId;
		function ActiveProbe(props) {
			const id = props.probeSessionId;
			React.useEffect(() => {
				activeId = id;
				renderInline();
				poll(); // switched chats: fetch now instead of waiting for the next tick
				return () => { if (activeId === id) activeId = undefined; };
			}, [id]);
			return null;
		}
		function pickSession(st) {
			for (const [id, v] of Object.entries(st.sessions || {})) lastGood.set(id, v);
			const inUrl = (location.href.match(SESSION_RE) || [])[0];
			let id = activeId && lastGood.has(activeId) ? activeId : undefined;
			if (!id && inUrl && lastGood.has(inUrl)) id = inUrl;
			if (!id && lastShownId && lastGood.has(lastShownId)) id = lastShownId;
			if (!id) {
				const ids = Object.keys(st.sessions || {});
				id = ids.length === 1 ? ids[0] : lastGood.size === 1 ? [...lastGood.keys()][0] : undefined;
			}
			if (id) lastShownId = id;
			return id ? lastGood.get(id) : undefined;
		}
		// Append "· ctx … · ⎇ …" inside the bottom-right stats pill, right after "Cache hit".
		// React owns the pill, so re-attach whenever it re-renders away our node.
		function renderInline() {
			const bar = document.querySelector("[data-persistent-stats]");
			const existing = document.querySelector("[data-dsh-ctx]");
			const s = status && pickSession(status);
			const group = bar && bar.lastElementChild;
			// Hide only when DSH's own pill is gone (it renders null between turns); a missing
			// reading keeps whatever is already shown.
			if (!bar || !group) { if (existing) existing.remove(); return; }
			if (!s) return;
			const w = s.worktree;
			const text = `Context Window ${fmt(s.context.tokens)}/${fmt(s.context.window)} (${pc(s.context.pct)})`
				+ (w ? `  ·  ⎇ ${w.name}${w.linked ? " (linked worktree)" : ""}` : "");
			// Near/over the cap. Auto-handoff ON: amber "will hand off". OFF: blue notice only, nothing will happen on its own.
			const cap = s.cap && s.cap.warn ? s.cap : undefined;
			const pillText = !cap ? text : cap.autoResume
				? text + `  ·  ⚠ ${cap.over ? "handoff due" : "handoff at " + fmt(cap.tokens)} → new session`
				: text + `  ·  ℹ ${cap.over ? "over" : "nearing"} ${fmt(cap.tokens)} cap · auto-handoff off`;
			const pillColor = !cap ? "" : cap.autoResume ? "#f5a524" : "#4c9aff";
			const title = `context: ${fmt(s.context.tokens)} of ${fmt(s.context.window)} tokens\nworktree: ${w ? w.root : "n/a"}${w ? `\n(checked-out branch: ${w.branch})` : ""}`;
			if (existing && existing.parentElement === group && group.lastElementChild === existing) {
				if (existing.lastChild.textContent !== pillText) existing.lastChild.textContent = pillText;
				existing.lastChild.style.color = pillColor;
				existing.title = title;
				return;
			}
			if (existing) existing.remove();
			const wrap = document.createElement("span");
			wrap.setAttribute("data-dsh-ctx", "");
			wrap.style.display = "contents";
			wrap.title = title;
			const sepSrc = bar.querySelector("[aria-hidden]");
			const sep = sepSrc ? sepSrc.cloneNode(true) : document.createTextNode("·");
			const label = document.createElement("span");
			label.textContent = pillText;
			label.style.color = pillColor;
			wrap.append(sep, label);
			group.appendChild(wrap);
		}

		const inject = ["slots"];

		function apply(ctx) {
			// Left sidebar entry + page, same seats the Plugins panel uses.
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, UsagePage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist", id: PANEL_ID, order: 5, label: () => "Hooks and Usage",
			}, UsageIcon));

			// Identify the visible session. Failure here must never break the Usage panel.
			try {
				ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
					name: "conversation.input.dock",
					id: "hooks-tts-probe",
					order: 999,
					inject: (sessionId) => ({ probeSessionId: sessionId }),
				}, ActiveProbe));
			} catch (_e) { /* fall back to URL / last-shown session */ }

			poll();
			const timer = setInterval(poll, POLL_MS);
			listeners.add(renderInline);
			// Re-attach after React re-renders and re-pick the session on URL changes.
			const nav = setInterval(renderInline, 1000);
			// React re-renders the pill while streaming and drops our node; re-attach on the next frame.
			let raf = 0;
			const observer = new MutationObserver(() => {
				if (raf) return;
				raf = requestAnimationFrame(() => { raf = 0; renderInline(); });
			});
			observer.observe(document.body, { childList: true, subtree: true });
			ctx.effect(() => () => {
				clearInterval(timer); clearInterval(nav); observer.disconnect(); listeners.delete(renderInline);
				document.querySelectorAll("[data-dsh-ctx]").forEach((n) => n.remove());
			}, "hooks-tts: status");
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
