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
		const GROUPS_URL = STATUS_URL.replace(/\/status$/, "/groups");
		// /status is a local JSON snapshot the host re-samples on every step, so polling it is cheap.
		const POLL_MS = 3000;
		const PANEL_ID = "usage";
		const SESSION_RE = /session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;

		const fmt = (n) => n === undefined || n === null ? "?" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
		const pc = (p) => p === undefined || p === null ? "–" : p + "%";

		// ---- shared polling store (one fetch loop feeds the panel and the overlay) ----
		let status = null;
		let groupsSeq = 0; // a GET that started before a move must not overwrite the move's result
		let groupsView = null; // { groups, sessions } from /groups (null until first read)
		let failed = false;
		const listeners = new Set();
		const emit = () => listeners.forEach((l) => l());
		// Continuations already acted on; spawns listed by the first poll predate this page and are never replayed.
		const handledSpawns = new Set();
		let spawnsSeeded = false;
		let openContinuation = () => {};
		async function poll() {
			try {
				const res = await fetch(STATUS_URL, { cache: "no-store" });
				status = await res.json();
				failed = false;
				try { const seq = ++groupsSeq; const g = await fetch(GROUPS_URL, { cache: "no-store" }); if (g.ok) { const v = await g.json(); if (seq === groupsSeq) groupsView = v; } } catch (_e) { /* older plugin host: no groups yet */ }
				for (const s of status.spawned || []) {
					if (handledSpawns.has(s.to)) continue;
					handledSpawns.add(s.to);
					if (spawnsSeeded && activeId === s.from) openContinuation(s.to);
				}
				spawnsSeeded = true;
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
		// ---- session groups: per-session "..." menu entries ----
		// Group actions live in each Session row's menu (slot sidebar.workspaces.session.menu.item), not on the Usage page.
		async function sendMove(body) {
			const res = await fetch(GROUPS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const b = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(b.error || ("HTTP " + res.status));
			groupsSeq++; // a GET that started before this move must not overwrite its result
			groupsView = b;
			emit();
		}
		function GroupMenu(props) {
			const sessionId = props.sessionId;
			const setMenuOpen = props.useMenuOpenState()[1];
			useStatus();
			if (!groupsView) return null; // older plugin host: no /groups
			const gs = groupsView.groups || [];
			const me = (groupsView.sessions || []).find((s) => s.id === sessionId);
			const current = gs.find((g) => g.members.some((m) => m.id === sessionId));
			const targets = gs.filter((g) => (!current || g.id !== current.id) && (g.workspaceId === undefined || !me || me.workspaceId === undefined || g.workspaceId === me.workspaceId));
			// Reuse a shipped menu row's classes so the entries look like their neighbours.
			const sample = document.querySelector("[role='menuitem']");
			const cls = sample ? sample.className : undefined;
			const run = (fn) => async () => {
				setMenuOpen(false);
				try { await fn(); } catch (err) { window.alert("Group change failed: " + (err && err.message || String(err))); }
			};
			const item = (key, label, fn) => h("button", { key, type: "button", role: "menuitem", className: cls, onClick: run(fn) }, label);
			return h(React.Fragment, null,
				current ? item("out", "Remove from group \u201c" + current.name + "\u201d", () => sendMove({ sessionId, groupId: null })) : null,
				targets.map((g) => item(g.id, (current ? "Move to group \u201c" : "Add to group \u201c") + g.name + "\u201d", () => sendMove({ sessionId, groupId: g.id }))),
				item("new", "New group\u2026", async () => {
					const name = window.prompt("Name for the new group");
					if (name && name.trim()) await sendMove({ sessionId, newGroupName: name });
				}));
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
					h(Toggle, { label: "Poll PR comments", hint: "While a session is titled \"PR <n>\", check its Azure DevOps pull request every 10 minutes and queue new review comments into that session (ado-pr-implement, up to its approval gate). Needs AZURE_DEVOPS_EXT_PAT.", field: "pollPrComments", current: s && s.settings && s.settings.pollPrComments }),
					h(Toggle, { label: "Always allow full access", hint: "Start new sessions at full access with no approval prompts. Existing sessions and later mode changes are never overridden. Off by default.", field: "alwaysFullAccess", current: s && s.settings && s.settings.alwaysFullAccess })),
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
			// DSH paints this group rgba(67,69,74,.45); make it opaque (same look over the dark frame).
			for (const g of bar.children) g.style.background = "rgb(42,43,46)";
			const w = s.worktree;
			const text = `Context Window ${fmt(s.context.tokens)}/${fmt(s.context.window)} (${pc(s.context.pct)})`
				+ (w ? `  ·  ⎇ ${w.name}${w.linked ? " (linked worktree)" : ""}` : "");
			// Near/over the cap. Auto-handoff ON: "will hand off"; OFF: an "auto-handoff off" notice only, nothing will happen on its own.
			const cap = s.cap && s.cap.warn ? s.cap : undefined;
			const pillText = !cap ? text : cap.autoResume
				? text + `  ·  ⚠ ${cap.over ? "handoff due" : "handoff at " + fmt(cap.tokens)} → new session`
				: text + `  ·  ℹ ${cap.over ? "over" : "nearing"} ${fmt(cap.tokens)} cap · auto-handoff off`;
			const pillColor = cap ? "#f5a524" : "";
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

		// ---- custom app icon: the DeepSeek whale over layered water waves ----
		const WHALE_PATH = "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45";
		const APP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
			+ '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#4D6BFE"/></linearGradient>'
			+ '<clipPath id="c"><rect width="64" height="64" rx="14"/></clipPath></defs>'
			+ '<g clip-path="url(#c)"><rect width="64" height="64" fill="url(#bg)"/>'
			+ '<path d="M0 30Q8 21 16 30T32 30T48 30T64 30V64H0Z" fill="#8fb0ff" fill-opacity=".6"/>'
			+ '<path d="M0 38Q8 29 16 38T32 38T48 38T64 38V64H0Z" fill="#3b82f6" fill-opacity=".8"/>'
			+ '<path d="M0 47Q8 38 16 47T32 47T48 47T64 47V64H0Z" fill="#1e40af" fill-opacity=".95"/>'
			+ '<g transform="translate(15 5) scale(1.5)"><path fill="#fff" d="' + WHALE_PATH + '"/></g></g></svg>';

		function setAppIcon() {
			const svgUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(APP_ICON_SVG);
			const touched = [];
			const setLink = (rel, attrs) => {
				let link = document.querySelector(`link[rel="${rel}"]`);
				const created = !link;
				if (!link) { link = document.createElement("link"); link.rel = rel; document.head.appendChild(link); }
				const prev = { href: link.getAttribute("href"), type: link.getAttribute("type"), sizes: link.getAttribute("sizes") };
				for (const k in attrs) link.setAttribute(k, attrs[k]);
				touched.push(() => {
					if (created) { link.remove(); return; }
					for (const k of ["href", "type", "sizes"]) prev[k] === null ? link.removeAttribute(k) : link.setAttribute(k, prev[k]);
				});
				return link;
			};
			setLink("icon", { type: "image/svg+xml", href: svgUrl });
			// iOS / "add to home screen" wants a raster icon: render the SVG to a PNG data URL.
			const img = new Image();
			img.onload = () => {
				try {
					const canvas = document.createElement("canvas");
					canvas.width = canvas.height = 180;
					canvas.getContext("2d").drawImage(img, 0, 0, 180, 180);
					setLink("apple-touch-icon", { href: canvas.toDataURL("image/png"), sizes: "180x180" });
				} catch (_e) { /* tainted canvas or no 2d context: keep the SVG favicon only */ }
			};
			img.src = svgUrl;

			// In-app logos (sidebar header, new-session screen): hide the stock DeepSeek mark and
			// put the custom icon beside it. Hidden rather than removed, so React's tree stays intact.
			const swapLogos = () => {
				document.querySelectorAll('svg[viewBox="0 0 23.16 17.04"]').forEach((svg) => {
					if (svg.dataset.dshIcon) return;
					svg.dataset.dshIcon = "1";
					const size = Math.round(svg.getBoundingClientRect().width) || 24;
					const logo = document.createElement("img");
					logo.src = svgUrl;
					logo.alt = "";
					logo.setAttribute("data-dsh-app-logo", "");
					logo.style.cssText = `width:${size}px;height:${size}px;flex:none;display:inline-block;vertical-align:middle`;
					svg.style.display = "none";
					svg.after(logo);
				});
			};
			swapLogos();
			let raf = 0;
			const observer = new MutationObserver(() => {
				if (raf) return;
				raf = requestAnimationFrame(() => { raf = 0; swapLogos(); });
			});
			observer.observe(document.body, { childList: true, subtree: true });

			return () => {
				img.onload = null; observer.disconnect(); cancelAnimationFrame(raf);
				touched.forEach((undo) => undo());
				document.querySelectorAll("[data-dsh-app-logo]").forEach((n) => n.remove());
				document.querySelectorAll("svg[data-dsh-icon]").forEach((s) => { s.style.display = ""; delete s.dataset.dshIcon; });
			};
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => setAppIcon(), "hooks-tts: app icon");
			// Left sidebar entry + page, same seats the Plugins panel uses.
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, UsagePage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist", id: PANEL_ID, order: 5, label: () => "Hooks and Usage",
			}, UsageIcon));

			// Group actions in every Session row's "..." menu; failure must never break the Usage panel.
			try {
				ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item", id: "dsh-hooks-tts-groups", order: 350,
				}, GroupMenu));
			} catch (_e) { /* menu slot unavailable */ }

			// Identify the visible session. Failure here must never break the Usage panel.
			try {
				ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
					name: "conversation.input.dock",
					id: "hooks-tts-probe",
					order: 999,
					inject: (sessionId) => ({ probeSessionId: sessionId }),
				}, ActiveProbe));
			} catch (_e) { /* fall back to URL / last-shown session */ }

			// Switch to the continuation session a handoff just created, when its source is the one on screen.
			openContinuation = (sessionId) => {
				try { ctx.get("uiWorkspace")?.openSession(sessionId); } catch (_e) { /* the sidebar still lists it */ }
			};
			poll();
			syncFullWs();
			const timer = setInterval(poll, POLL_MS);
			listeners.add(renderInline);
			// Re-attach after React re-renders and re-pick the session on URL changes.
			const nav = setInterval(renderInline, 1000);
			// React re-renders the pill while streaming and drops our node; re-attach on the next frame.
			let raf = 0;
			const observer = new MutationObserver(() => {
				if (raf) return;
				raf = requestAnimationFrame(() => { raf = 0; renderInline(); syncThink(); syncFullWs(); });
			});
			observer.observe(document.body, { childList: true, subtree: true });
			// Remember the last Think expand/collapse choice and apply it to every later Think section.
			const onThinkClick = (e) => {
				if (!e.isTrusted) return;
				const row = e.target && e.target.closest && e.target.closest("[data-disclosure-row]");
				if (!isThinkRow(row)) return;
				setTimeout(() => { try { localStorage.setItem(THINK_KEY, row.getAttribute("aria-expanded") === "true" ? "1" : "0"); } catch (_e) { /* private mode */ } }, 0);
			};
			document.addEventListener("click", onThinkClick, true);
			ctx.effect(() => () => {
				document.removeEventListener("click", onThinkClick, true);
				openContinuation = () => {};
				clearInterval(timer); clearInterval(nav); observer.disconnect(); listeners.delete(renderInline);
				document.querySelectorAll("[data-dsh-ctx]").forEach((n) => n.remove());
				removeFullWs();
			}, "hooks-tts: status");
		}

		// ---- Workspaces: full-height toggle ----
		// A button after "Import from Claude Code" hides the sidebar blocks above the Workspaces list (logo row,
		// New Session, global panels) so the session tree gets the whole left bar; the same button restores them.
		// DSH class names are hashed, so everything is found by aria-label / data-slot, never by class.
		const FULLWS_KEY = "dsh-hooks-tts:workspacesFull";
		const FULLWS_ATTR = "data-hooks-fullws-hide";
		const FULLWS_BTN = "data-hooks-fullws-toggle";
		const FULLWS_ICON = (full) => full
			? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke-width="1"><path d="M3 10.5h2.5V13M13 5.5h-2.5V3M5.5 13l-3-3M10.5 3l3 3" stroke="currentColor"/></svg>'
			: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke-width="1"><path d="M2.5 6V2.5H6M13.5 10v3.5H10M2.5 2.5L6 6M13.5 13.5L10 10" stroke="currentColor"/></svg>';
		const fullWsOn = () => { try { return localStorage.getItem(FULLWS_KEY) === "1"; } catch (_e) { return false; } };
		function ensureFullWsStyle() {
			if (document.getElementById("hooks-fullws-style")) return;
			const st = document.createElement("style");
			st.id = "hooks-fullws-style";
			st.textContent = "[" + FULLWS_ATTR + "]{display:none !important}";
			document.head.appendChild(st);
		}
		// The sidebar column that holds both the global panel list and the Workspaces slot.
		function sidebarRoot() {
			const ws = document.querySelector("[data-slot='sidebar.workspaces']");
			const nav = document.querySelector("nav[aria-label='Global panels']");
			if (!ws || !nav || !nav.parentElement || !nav.parentElement.contains(ws)) return null;
			return { root: nav.parentElement, ws };
		}
		function setFullWs(on) {
			try { localStorage.setItem(FULLWS_KEY, on ? "1" : "0"); } catch (_e) { /* private mode */ }
			syncFullWs();
		}
		function syncFullWs() {
			ensureFullWsStyle();
			const found = sidebarRoot();
			if (!found) return;
			const on = fullWsOn();
			// Hide every sibling above the Workspaces block; restore by removing the marker.
			let above = true;
			for (const child of found.root.children) {
				if (child.contains(found.ws)) { above = false; child.removeAttribute(FULLWS_ATTR); continue; }
				if (above && on) child.setAttribute(FULLWS_ATTR, ""); else child.removeAttribute(FULLWS_ATTR);
			}
			// The toggle sits right after the Import from Claude Code button.
			const imp = found.ws.querySelector("button[aria-label='Import from Claude Code']");
			if (!imp || !imp.parentElement) return;
			let btn = imp.parentElement.querySelector("[" + FULLWS_BTN + "]");
			if (!btn) {
				btn = document.createElement("button");
				btn.type = "button";
				btn.setAttribute(FULLWS_BTN, "");
				btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setFullWs(!fullWsOn()); });
				imp.after(btn);
			} else if (btn.previousElementSibling !== imp) imp.after(btn);
			btn.className = imp.className; // same look as its neighbours
			// The action row is capped at three buttons' width (max-width) and would push ours off the sidebar: lift the cap.
			const row = imp.parentElement;
			if (row.style.maxWidth !== "none") { row.style.width = "auto"; row.style.maxWidth = "none"; row.style.minWidth = "max-content"; row.style.flex = "none"; }
			const label = on ? "Restore sidebar" : "Show workspaces full height";
			if (btn.getAttribute("aria-label") !== label) {
				btn.setAttribute("aria-label", label);
				btn.title = label;
				btn.setAttribute("aria-pressed", on ? "true" : "false");
				btn.innerHTML = FULLWS_ICON(on);
			}
		}
		function removeFullWs() {
			document.querySelectorAll("[" + FULLWS_ATTR + "]").forEach((n) => n.removeAttribute(FULLWS_ATTR));
			document.querySelectorAll("[" + FULLWS_BTN + "]").forEach((n) => n.remove());
			const st = document.getElementById("hooks-fullws-style"); if (st) st.remove();
		}

		// ---- sticky Think sections ----
		const THINK_KEY = "dsh-hooks-tts:thinkOpen";
		const seenThink = new WeakSet();
		function isThinkRow(row) {
			return !!row && !!row.closest("[data-variant='think']");
		}
		// Each Think row is adjusted once, when first seen; later user clicks are respected.
		function syncThink() {
			let want;
			try { want = localStorage.getItem(THINK_KEY); } catch (_e) { return; }
			if (want !== "1" && want !== "0") return;
			for (const row of document.querySelectorAll("[data-disclosure-row][data-expandable='true']")) {
				if (seenThink.has(row) || !isThinkRow(row)) continue;
				seenThink.add(row);
				if ((row.getAttribute("aria-expanded") === "true") !== (want === "1")) row.click();
			}
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
