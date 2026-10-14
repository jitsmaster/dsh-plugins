window.__ModuleLoader__.load({
	id: "dsh-review-queue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useSyncExternalStore } = React;

		const ANCHOR_ID = "review-queue";
		// Same origin as the page: the plugin registers /review-queue on the Host web server.
		const API = "/review-queue";
		const LS = { overlay: "dsh-review-queue.overlay", drafts: "dsh-review-queue.drafts" };
		const WAIT_MS = 20000;

		// =====================================================================================
		// Pure helpers (exported through exports.__test)
		// =====================================================================================

		function fmtAge(ms) {
			const s = Math.max(0, Math.round(ms / 1000));
			if (s < 45) return "just now";
			const m = Math.round(s / 60);
			if (m < 60) return m + " min ago";
			const hr = Math.round(m / 60);
			if (hr < 36) return hr + " h ago";
			return Math.round(hr / 24) + " d ago";
		}

		/** "1:30" for a time left, "expired" at or past zero. */
		function fmtLeft(ms) {
			if (ms <= 0) return "expired";
			const s = Math.ceil(ms / 1000);
			return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
		}

		const baseName = (p) => (typeof p === "string" ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "") || "";

		/** Draft for one question: { selected: [labels], custom: "" }. Toggle a label (single-select replaces, multi-select flips). */
		function toggleChoice(draft, label, multi) {
			const cur = draft && Array.isArray(draft.selected) ? draft.selected : [];
			const has = cur.includes(label);
			const selected = multi ? (has ? cur.filter((l) => l !== label) : [...cur, label]) : (has ? [] : [label]);
			return { selected, custom: multi || !selected.length ? (draft && draft.custom) || "" : "" };
		}

		/** Answers array for the server, or undefined while any question is unanswered. */
		function buildAnswers(questions, drafts) {
			const out = [];
			for (const q of questions || []) {
				const d = (drafts && drafts[q.id]) || { selected: [], custom: "" };
				const custom = (d.custom || "").trim();
				if (!d.selected.length && !custom) return undefined;
				out.push({ id: q.id, selected: d.selected, ...(custom ? { custom } : {}) });
			}
			return out.length ? out : undefined;
		}

		function answerText(answers) {
			return (answers || []).map((a) => [...(a.selected || []), a.custom ? "“" + a.custom + "”" : ""].filter(Boolean).join(", ")).join(" · ");
		}

		/** One line for a resolved item: what happened to it. */
		function resolutionText(item) {
			const r = item.resolution || {};
			const where = r.by === "card" ? "here" : r.by === "screen" ? "on screen" : "";
			switch (r.kind) {
				case "answered": return "Answered" + (where ? " " + where : "") + (r.answers ? ": " + answerText(r.answers) : "");
				case "late-answered": return "Answered late" + (r.answers ? ": " + answerText(r.answers) : "");
				case "confirmed": return "Confirmed the recommended option" + (r.answers ? ": " + answerText(r.answers) : "");
				case "expired": return r.assumed && r.assumed.length ? "Expired; recommended option taken: " + r.assumed.join(", ") : "Expired; the assistant carried on";
				case "approved": return "Approved" + (where ? " " + where : "");
				case "denied": return "Denied" + (where ? " " + where : "");
				case "reviewed": return "Reviewed";
				case "superseded": return "Replaced by a newer result";
				case "replied": return r.by === "session" ? "You continued the session" : "You replied";
				case "session-ended": return "Session ended";
				case "cancelled": return r.by === "restart" ? "Cancelled when the server restarted" : "Cancelled";
				default: return "Resolved";
			}
		}

		/** Enter sends a reply; Shift+Enter is a new line and Enter during IME composition belongs to the IME. */
		const isSendKey = (e) => !!e && e.key === "Enter" && !e.shiftKey && !e.isComposing;
		/** Heading of a card: the task title, else the session title. */
		const cardTitle = (item) => (item && (item.title || item.sessionTitle)) || "Untitled";

		/** Id of the item to select once `id` leaves the list: the next one, else the previous one. */
		function nextAfter(items, id) {
			const i = (items || []).findIndex((x) => x.id === id);
			if (i < 0) return undefined;
			const n = items[i + 1] || items[i - 1];
			return n ? n.id : undefined;
		}

		/** Keyboard shortcut -> action name. Plain letters only when not typing; approving and denying need Shift so they cannot happen by accident. */
		function keyAction(e) {
			if (!e || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return undefined;
			const t = e.target;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return undefined;
			if (e.shiftKey) return e.key === "A" ? "approve" : e.key === "D" ? "deny" : undefined;
			switch (e.key) {
				case "j": case "ArrowDown": return "next";
				case "k": case "ArrowUp": return "prev";
				case "r": return "read";
				case "e": return "reviewed";
				default: return undefined;
			}
		}

		/** Filter by type ("all" or an item type) and by text: every word must appear in the title, session, workspace, summary or question. */
		function filterItems(items, f) {
			const type = (f && f.type) || "all";
			const words = ((f && f.query) || "").toLowerCase().split(/\s+/).filter(Boolean);
			return (items || []).filter((it) => {
				if (type !== "all" && it.type !== type) return false;
				if (!words.length) return true;
				const p = it.payload || {};
				const hay = [it.title, it.sessionTitle, it.workspace, it.summary, p.summary, ...(p.questions || []).map((q) => q && q.question)].filter(Boolean).join("\n").toLowerCase();
				return words.every((w) => hay.includes(w));
			});
		}

		const permKey = (i) => [i.sessionId, i.payload && i.payload.toolName, (i.payload && (i.payload.detail || i.payload.summary)) || ""].join("\u0000");
		/** How many open permission requests are identical to this one (same session, tool and command); 0 for a risky one. Mirrors the server. */
		function similarCount(open, item) {
			if (!item || item.type !== "permission" || (item.risks && item.risks.length)) return 0;
			return (open || []).filter((i) => i.type === "permission" && permKey(i) === permKey(item)).length;
		}

		/** Drafts worth keeping: only for items still in the queue (open or resolved), and no empty replies. */
		function pruneSaved(saved, snap) {
			const live = new Set([...(snap ? snap.open : []), ...(snap ? snap.resolved : [])].map((i) => i.id));
			const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
			const drafts = {};
			const replies = {};
			for (const [id, d] of Object.entries(obj(saved && saved.drafts))) if (live.has(id) && d && typeof d === "object") drafts[id] = d;
			for (const [id, r] of Object.entries(obj(saved && saved.replies))) if (live.has(id) && typeof r === "string" && r) replies[id] = r;
			return { drafts, replies };
		}

		/** Inline markdown -> tokens. Only http(s) links stay links; anything else keeps just its text. */
		function mdInline(text) {
			const out = [];
			const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*/g;
			const pushText = (s) => { if (!s) return; const prev = out[out.length - 1]; if (prev && prev.t === "text") prev.text += s; else out.push({ t: "text", text: s }); };
			let last = 0;
			let m;
			const src = String(text == null ? "" : text);
			while ((m = re.exec(src))) {
				pushText(src.slice(last, m.index));
				if (m[1] !== undefined) out.push({ t: "code", text: m[1] });
				else if (m[2] !== undefined) out.push({ t: "b", text: m[2] });
				else if (m[3] !== undefined) { if (/^https?:\/\//i.test(m[4])) out.push({ t: "a", text: m[3], href: m[4] }); else pushText(m[3]); }
				else out.push({ t: "i", text: m[5] });
				last = re.lastIndex;
			}
			pushText(src.slice(last));
			return out;
		}

		/** Block markdown -> blocks: headings, paragraphs, bullet and numbered lists, quotes, fenced code. */
		function mdBlocks(src) {
			const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
			const out = [];
			const blank = (l) => !l.trim();
			const UL = /^\s*[-*+]\s+/;
			const OL = /^\s*\d+[.)]\s+/;
			let i = 0;
			while (i < lines.length) {
				const line = lines[i];
				if (blank(line)) { i++; continue; }
				const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
				if (fence) {
					const body = [];
					i++;
					while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
					i++;
					out.push({ t: "code", text: body.join("\n"), lang: fence[1] || "" });
					continue;
				}
				const hm = /^(#{1,6})\s+(.*)$/.exec(line);
				if (hm) { out.push({ t: "h", level: hm[1].length, text: hm[2].trim() }); i++; continue; }
				if (UL.test(line)) { const items = []; while (i < lines.length && UL.test(lines[i])) items.push(lines[i++].replace(UL, "").trim()); out.push({ t: "ul", items }); continue; }
				if (OL.test(line)) { const items = []; while (i < lines.length && OL.test(lines[i])) items.push(lines[i++].replace(OL, "").trim()); out.push({ t: "ol", items }); continue; }
				if (/^\s*>/.test(line)) { const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, "")); out.push({ t: "q", text: q.join("\n").trim() }); continue; }
				const para = [];
				while (i < lines.length && !blank(lines[i]) && !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])) para.push(lines[i++]);
				if (!para.length) para.push(lines[i++]);
				out.push({ t: "p", text: para.join("\n") });
			}
			return out;
		}

		const TYPE = { question: "Question", permission: "Permission", completed: "Done" };
		const typeLabel = (t) => TYPE[t] || t;
		const recommended = (q, label) => /\(recommended\)/i.test(label);

		// =====================================================================================
		// Shared state: one store for the overlay and the header button
		// =====================================================================================

		const storage = {
			get(k) { try { return window.localStorage.getItem(k); } catch (_e) { return null; } },
			set(k, v) { try { window.localStorage.setItem(k, v); } catch (_e) { /* private mode */ } },
		};

		/** Unsent reply texts and half-picked answers survive a reload (pruned once the queue is known). */
		function loadSaved() {
			try {
				const j = JSON.parse(storage.get(LS.drafts) || "null");
				const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
				return { drafts: obj(j && j.drafts), replies: obj(j && j.replies) };
			} catch (_e) { return { drafts: {}, replies: {} }; }
		}
		const saved = loadSaved();
		const state = {
			snap: null, error: null, skew: 0, expanded: {}, drafts: saved.drafts, replies: saved.replies, busy: {}, errors: {},
			selected: null, showResolved: false, lateOpen: {}, filter: { type: "all", query: "" }, overlay: storage.get(LS.overlay) === "1",
		};
		const listeners = new Set();
		let version = 0;
		let saveTimer;
		function scheduleSave() {
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				const keep = pruneSaved({ drafts: state.drafts, replies: state.replies }, { open: Object.keys({ ...state.drafts, ...state.replies }).map((id) => ({ id })), resolved: [] });
				storage.set(LS.drafts, JSON.stringify(keep));
			}, 300);
		}
		function set(patch) {
			Object.assign(state, patch);
			if ("drafts" in patch || "replies" in patch) scheduleSave();
			version++;
			listeners.forEach((l) => l());
		}
		function visibleOpen() { return state.snap ? filterItems(state.snap.open, state.filter) : []; }
		/** The selected card: the chosen one, else the one the voice focus is on, else the oldest. */
		function currentItem() {
			const open = visibleOpen();
			return open.find((i) => i.id === state.selected) || open.find((i) => i.id === (state.snap && state.snap.focusId)) || open[0];
		}
		const subscribe = (l) => { listeners.add(l); return () => { listeners.delete(l); }; };
		const useStore = () => { useSyncExternalStore(subscribe, () => version); return state; };

		let polling = false;
		let stopped = false;
		async function pollLoop() {
			if (polling) return;
			polling = true;
			let since;
			let fails = 0;
			while (!stopped) {
				try {
					const url = API + "/v1/snapshot?wait=" + WAIT_MS + (since ? "&since=" + encodeURIComponent(since) : "");
					const res = await fetch(url, { credentials: "same-origin" });
					if (!res.ok) throw new Error("HTTP " + res.status);
					const body = await res.json();
					fails = 0;
					if (body.unchanged) { if (state.error) set({ error: null }); continue; }
					since = body.snapshotId + "|" + (body.focusId || "") + "|" + (body.reading || "");
					set({ snap: body, error: null, skew: (body.serverNow || Date.now()) - Date.now() });
					const kept = pruneSaved({ drafts: state.drafts, replies: state.replies }, body);
					const gone = Object.keys(state.drafts).some((k) => !(k in kept.drafts)) || Object.keys(state.replies).some((k) => !(k in kept.replies));
					if (gone) set(kept);
				} catch (e) {
					fails++;
					if (!stopped) set({ error: "Review queue unreachable (" + String((e && e.message) || e) + "). Is dsh-review-queue loaded? Restart DSH after installing it." });
					await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * fails)));
				}
			}
			polling = false;
		}

		async function act(path, body, id, opts) {
			// After a successful action on the selected card, the next card becomes the selected one.
			const cur = opts && opts.advance ? currentItem() : undefined;
			const nextId = cur && cur.id === id ? nextAfter(visibleOpen(), id) : undefined;
			const advance = !!cur && cur.id === id;
			set({ busy: { ...state.busy, [id]: true }, errors: { ...state.errors, [id]: undefined } });
			let error;
			try {
				const res = await fetch(API + path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
				if (!res.ok) { const j = await res.json().catch(() => ({})); error = ERRORS[j.error] || "Could not do that (" + (j.error || "HTTP " + res.status) + ")."; }
			} catch (e) { error = "Request failed: " + String((e && e.message) || e); }
			set({ busy: { ...state.busy, [id]: false }, errors: { ...state.errors, [id]: error } });
			if (!error && advance) set({ selected: nextId || null });
			return !error;
		}
		const ERRORS = {
			"not-open": "That item is no longer waiting.", "not-pending": "That request is no longer waiting for an answer.",
			"bad-answer": "That answer does not match the question.", "empty": "Type something first.", "too-long": "That is too long.",
			"no-controller": "Cannot reach the session right now.", "not-completed": "That only applies to finished work.",
			"not-expired": "That question is not waiting for a late answer.", "no-session": "That session is not running any more, so a late answer cannot be delivered.", "reply-queued": "An answer is already on its way to that session.",
			"muted": "Voice is muted. Turn it back on in the TTS settings first.", "no-speaker": "The speech engine is not available (is dsh-hooks-tts installed?).", "nothing-to-read": "There is nothing to read.", "not-found": "That item no longer exists.", "not-reopenable": "That item cannot be reopened.", "risky": "That request looks risky, so it has to be approved on its own.", "not-permission": "That is not a permission request.",
		};

		// Host capabilities captured in apply(); absent on a DSH without the workspace API, which just hides the button.
		const hostApi = { openSession: undefined };
		/** Reading aloud ends with the overlay: whoever closes it or jumps to a session does not want to keep listening. */
		function stopReading() {
			if (state.snap && state.snap.reading) fetch(API + "/v1/stop", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
		}
		function openSession(item) {
			if (hostApi.openSession) { stopReading(); hostApi.openSession(item.sessionId); set({ overlay: false }); storage.set(LS.overlay, "0"); }
		}
		function setOverlay(on) { if (!on) stopReading(); storage.set(LS.overlay, on ? "1" : "0"); set({ overlay: on }); }

		// =====================================================================================
		// Styles
		// =====================================================================================

		const CSS = ".rq{--rq-fg:var(--dsw-alias-label-primary,#f9fafb);--rq-mute:var(--dsw-alias-label-tertiary,#adb2b8);--rq-border:var(--dsw-alias-border-l2,#ffffff26);--rq-hover:var(--dsw-alias-interactive-bg-hover,#ffffff14);--rq-layer:var(--dsw-alias-bg-layer-1,#232324);--rq-layer2:var(--dsw-alias-bg-layer-2,#2c2c2e);--rq-base:var(--dsw-alias-bg-base,#151517);--rq-accent:var(--dsw-alias-link,#7aaaff);--rq-err:var(--dsw-alias-state-error-primary,#f25a5a);--rq-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--rq-ok:var(--dsw-alias-state-success-primary,#22c55e);color:var(--rq-fg);font-size:13px;line-height:1.45;box-sizing:border-box}"
			+ ".rq *{box-sizing:border-box}:where(.rq) button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0}:where(.rq) button:disabled{opacity:.5;cursor:default}"
			+ ".rq-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--rq-border)}"
			+ ".rq-head h2{margin:0;font-size:14px;font-weight:600}.rq-count{background:var(--rq-layer2);border-radius:9px;padding:1px 8px;font-size:11px;color:var(--rq-mute)}"
			+ ".rq-grow{flex:1}.rq-link{color:var(--rq-mute);padding:4px 8px;border-radius:6px}.rq-link:hover{background:var(--rq-hover);color:var(--rq-fg)}.rq-row>.rq-link:first-child{margin-left:-8px}"
			+ ".rq-body{flex:1;min-height:0;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px}.rq-banner{padding:8px 14px;background:#f25a5a22;color:var(--rq-err);font-size:12px}"
			+ ".rq-empty{margin:auto;text-align:center;color:var(--rq-mute);padding:32px 24px}"
			+ ".rq-card{border:1px solid var(--rq-border);border-radius:9px;background:var(--rq-layer);padding:12px 14px;display:flex;flex-direction:column;gap:10px}.rq-card.sel{border-color:var(--rq-accent)}"
			+ ".rq-card-h{display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0}.rq-chip{flex:none;padding:1px 8px;border-radius:9px;font-size:11px;font-weight:600;background:var(--rq-layer2)}"
			+ ".rq-chip.question{color:var(--rq-accent)}.rq-chip.permission{color:var(--rq-warn)}.rq-chip.completed{color:var(--rq-ok)}.rq-pos{flex:none;color:var(--rq-mute);font-size:12px}"
			+ ".rq-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.rq-meta{margin-left:auto;flex:none;color:var(--rq-mute);font-size:12px;display:flex;gap:8px}"
			+ ".rq-left{color:var(--rq-warn);font-variant-numeric:tabular-nums}.rq-left.soon{color:var(--rq-err);font-weight:600}"
			+ ".rq-text{white-space:pre-wrap;word-break:break-word}.rq-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}"
			+ ".rq-sub{color:var(--rq-mute);font-size:12px}.rq-opts{display:flex;flex-direction:column;gap:6px}.rq-chips{display:flex;flex-wrap:wrap;gap:6px}"
			+ ".rq-opt{display:flex;gap:8px;align-items:flex-start;text-align:left;border:1px solid var(--rq-border);border-radius:7px;padding:8px 10px;background:var(--rq-base)}"
			+ ".rq-opt:hover:not(:disabled){background:var(--rq-hover)}.rq-opt.on{border-color:var(--rq-accent);background:var(--rq-layer2)}.rq-opt .d{color:var(--rq-mute);font-size:12px}"
			+ ".rq-star{color:var(--rq-warn)}.rq-pill{border:1px solid var(--rq-border);border-radius:9px;padding:1px 8px;font-size:12px;color:var(--rq-mute)}"
			+ ".rq-input,.rq-ta{width:100%;font:inherit;color:inherit;background:var(--rq-base);border:1px solid var(--rq-border);border-radius:7px;padding:8px 10px}.rq-ta{min-height:60px;resize:vertical}"
			+ ".rq-pre{white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;background:var(--rq-base);border:1px solid var(--rq-border);border-radius:7px;padding:10px 12px;font-size:12.5px}"
			+ ".rq-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.rq-btn{padding:6px 14px;border-radius:7px;border:1px solid var(--rq-border)!important;background:var(--rq-layer2)!important}"
			+ ".rq-btn:hover:not(:disabled){background:var(--rq-hover)!important}.rq-btn.pri{background:var(--rq-accent)!important;color:#fff!important;border-color:transparent!important}"
			+ ".rq-btn.bad{color:var(--rq-err)}.rq-err{color:var(--rq-err);font-size:12px}.rq-res{opacity:.75}"
			+ ".rq-hwrap{display:inline-flex;align-items:center}.rq-hbtn{position:relative;width:28px;height:28px;border-radius:6px;display:flex!important;align-items:center;justify-content:center;font-size:14px;color:var(--rq-mute)}"
			+ ".rq-hbtn:hover{background:var(--rq-hover);color:var(--rq-fg)}.rq-hbtn.on{color:var(--rq-accent)}"
			+ ".rq-hbtn .b{position:absolute;top:0;right:0;min-width:15px;height:15px;border-radius:8px;background:var(--rq-err);color:#fff;font-size:10px;font-weight:700;line-height:15px;display:flex;align-items:center;justify-content:center;padding:0 3px}"
			+ ".rq-md{font-size:13.5px;line-height:1.5}.rq-md p{margin:0 0 8px;white-space:pre-wrap;word-break:break-word}.rq-md ul,.rq-md ol{margin:0 0 8px;padding-left:22px}.rq-md blockquote{margin:0 0 8px;padding:2px 10px;border-left:3px solid var(--rq-border);color:var(--rq-mute)}"
			+ ".rq-md pre.rq-pre{margin:0 0 8px}.rq-code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;background:var(--rq-layer2);border-radius:4px;padding:0 4px}.rq-md a{color:var(--rq-accent)}.rq-h{font-weight:600;margin:6px 0 4px}.rq-h1{font-size:16px}.rq-h2{font-size:14.5px}"
			+ ".rq-replybox{max-height:360px;overflow:auto;background:var(--rq-base);border:1px solid var(--rq-border);border-radius:7px;padding:10px 12px;margin-top:6px}"
			+ ".rq-risks{display:flex;flex-wrap:wrap;gap:6px}.rq-risk{background:#f25a5a22;color:var(--rq-err);border-radius:9px;padding:2px 10px;font-size:12px;font-weight:600}.rq-risk-dot{color:var(--rq-err);font-weight:700}"
			+ ".rq-filter{flex:none;display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid var(--rq-border);flex-wrap:wrap}.rq-fchip{padding:3px 12px;border-radius:9px;border:1px solid var(--rq-border)!important;font-size:12px;color:var(--rq-mute)}"
			+ ".rq-fchip.on{background:var(--rq-layer2)!important;color:var(--rq-fg);border-color:var(--rq-accent)!important}.rq-fsearch{flex:1;min-width:160px;width:auto;padding:4px 10px}.rq-hint{flex:none;padding:6px 14px;border-top:1px solid var(--rq-border);color:var(--rq-mute);font-size:11.5px}"
			+ ".rq-ov-back{position:fixed;inset:0;z-index:9980;background:#0009;padding:24px;display:flex}.rq-ov{flex:1;min-width:0;border:1px solid var(--rq-border);border-radius:12px;background:var(--rq-base);overflow:hidden;display:flex;flex-direction:column}"
			+ ".rq-split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(260px,360px) 1fr}.rq-side{border-right:1px solid var(--rq-border);overflow:auto;padding:10px;display:flex;flex-direction:column;gap:4px}"
			+ ".rq-detail{overflow:auto;padding:16px 20px}.rq-row-i{display:flex;flex-direction:column;gap:2px;text-align:left;border:1px solid transparent!important;border-radius:8px;padding:8px 10px}"
			+ ".rq-row-i:hover{background:var(--rq-hover)}.rq-row-i.sel{background:var(--rq-layer2);border-color:var(--rq-border)!important}"
			+ "@media (max-width:820px){.rq-split{display:block;overflow:auto}.rq-side{display:none}.rq-detail{display:none}.rq-split .rq-narrow{display:flex}}.rq-narrow{display:none;flex-direction:column;gap:12px;padding:12px}";

		let styled = false;
		function ensureStyle() {
			if (styled || typeof document === "undefined") return;
			styled = true;
			const st = document.createElement("style");
			st.setAttribute("data-rq-style", "");
			st.textContent = CSS;
			document.head.appendChild(st);
		}

		// =====================================================================================
		// Components
		// =====================================================================================

		function useNow(active) {
			const [, tick] = useState(0);
			useEffect(() => {
				if (!active) return undefined;
				const t = setInterval(() => tick((n) => n + 1), 1000);
				return () => clearInterval(t);
			}, [active]);
			return Date.now() + state.skew;
		}

		function QuestionBody({ item, full, path = "/v1/answer", sendLabel = "Send answer" }) {
			const st = useStore();
			const questions = item.payload.questions || [];
			const drafts = st.drafts[item.id] || {};
			const busy = st.busy[item.id];
			const setDraft = (qid, next) => set({ drafts: { ...st.drafts, [item.id]: { ...drafts, [qid]: next } } });
			if (!full) {
				const q = questions[0];
				return h(React.Fragment, null,
					h("div", { className: "rq-text rq-clamp" }, q ? q.question : ""),
					q && q.options && q.options.length ? h("div", { className: "rq-chips" }, q.options.slice(0, 4).map((o) => h("span", { key: o.label, className: "rq-pill" }, recommended(q, o.label) ? "★ " + o.label : o.label)), q.options.length > 4 ? h("span", { className: "rq-sub" }, "+" + (q.options.length - 4)) : null) : null,
					questions.length > 1 ? h("div", { className: "rq-sub" }, questions.length + " questions") : null);
			}
			const answers = buildAnswers(questions, drafts);
			return h(React.Fragment, null,
				questions.map((q) => {
					const d = drafts[q.id] || { selected: [], custom: "" };
					return h("div", { key: q.id, className: "rq-opts" },
						q.header ? h("div", { className: "rq-sub" }, q.header) : null,
						h("div", { className: "rq-text", style: { fontWeight: 600 } }, q.question),
						(q.options || []).map((o) => h("button", {
							key: o.label, className: "rq-opt" + (d.selected.includes(o.label) ? " on" : ""), disabled: busy,
							onClick: () => setDraft(q.id, toggleChoice(d, o.label, !!q.multiSelect)), "aria-pressed": d.selected.includes(o.label),
						}, h("span", null, d.selected.includes(o.label) ? (q.multiSelect ? "☑" : "◉") : (q.multiSelect ? "☐" : "○")),
							h("span", null, h("span", null, recommended(q, o.label) ? h("span", { className: "rq-star" }, "★ ") : null, o.label), o.description ? h("div", { className: "d" }, o.description) : null))),
						h("input", { className: "rq-input", placeholder: "Other answer…", value: d.custom || "", disabled: busy, onChange: (e) => setDraft(q.id, { selected: q.multiSelect ? d.selected : [], custom: e.target.value }) }));
				}),
				h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: !answers || busy, onClick: async () => { if (await act(path, { id: item.id, answers }, item.id, { advance: path === "/v1/answer" })) set({ drafts: { ...state.drafts, [item.id]: undefined } }); } }, busy ? "Sending…" : sendLabel),
					!answers ? h("span", { className: "rq-sub" }, "Pick an option or type an answer for every question.") : null));
		}

		function PermissionBody({ item, full }) {
			const st = useStore();
			const busy = st.busy[item.id];
			const p = item.payload || {};
			const risks = item.risks || [];
			const same = similarCount(st.snap ? st.snap.open : [], item);
			const mono = { fontFamily: "ui-monospace,Consolas,monospace" };
			return h(React.Fragment, null,
				risks.length ? h("div", { className: "rq-risks" }, risks.map((r) => h("span", { key: r.code, className: "rq-risk", title: r.label }, "⚠ " + r.label))) : null,
				full && p.detail && p.detail !== p.summary ? h("pre", { className: "rq-pre", style: mono }, p.detail)
					: h("div", { className: "rq-text" + (full ? "" : " rq-clamp"), style: mono }, p.summary || p.toolName),
				full && p.reason ? h("div", { className: "rq-sub" }, p.reason) : null,
				h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: busy, onClick: () => act("/v1/approve", { id: item.id }, item.id, { advance: true }) }, "Approve"),
					h("button", { className: "rq-btn bad", disabled: busy, onClick: () => act("/v1/deny", { id: item.id }, item.id, { advance: true }) }, "Deny"),
					same > 1 ? h("button", { className: "rq-btn", disabled: busy, title: "Approve this request and the identical ones from the same session", onClick: () => act("/v1/approve-similar", { id: item.id }, item.id, { advance: true }) }, "Approve all " + same + " identical") : null));
		}

		/** Markdown as React elements (no HTML injection: text goes through React, links are http(s) only). */
		function Md({ text }) {
			const inline = (s) => mdInline(s).map((tok, i) => {
				switch (tok.t) {
					case "b": return h("strong", { key: i }, tok.text);
					case "i": return h("em", { key: i }, tok.text);
					case "code": return h("code", { key: i, className: "rq-code" }, tok.text);
					case "a": return h("a", { key: i, href: tok.href, target: "_blank", rel: "noopener noreferrer" }, tok.text);
					default: return tok.text;
				}
			});
			return h("div", { className: "rq-md" }, mdBlocks(text).map((b, i) => {
				switch (b.t) {
					case "h": return h("div", { key: i, className: "rq-h rq-h" + Math.min(b.level, 3) }, inline(b.text));
					case "ul": return h("ul", { key: i }, b.items.map((it, n) => h("li", { key: n }, inline(it))));
					case "ol": return h("ol", { key: i }, b.items.map((it, n) => h("li", { key: n }, inline(it))));
					case "q": return h("blockquote", { key: i }, inline(b.text));
					case "code": return h("pre", { key: i, className: "rq-pre" }, h("code", null, b.text));
					default: return h("p", { key: i }, inline(b.text));
				}
			}));
		}

		function CompletedBody({ item, full }) {
			const st = useStore();
			const busy = st.busy[item.id];
			const reply = st.replies[item.id] || "";
			const send = async () => { if (await act("/v1/reply", { id: item.id, text: reply }, item.id, { advance: true })) set({ replies: { ...state.replies, [item.id]: "" } }); };
			return h(React.Fragment, null,
				h("div", { className: "rq-text" + (full ? "" : " rq-clamp") }, item.summary || "Finished."),
				full ? h(React.Fragment, null,
					item.payload && item.payload.reply ? h("details", { open: item.payload.reply.length < 1500 }, h("summary", { className: "rq-sub", style: { cursor: "pointer" } }, "Full reply"), h("div", { className: "rq-replybox" }, h(Md, { text: item.payload.reply }))) : null,
					h("textarea", { className: "rq-ta", placeholder: "Reply to this session… (Enter sends, Shift+Enter for a new line)", value: reply, disabled: busy, onChange: (e) => set({ replies: { ...st.replies, [item.id]: e.target.value } }), onKeyDown: (e) => { if (isSendKey(e.nativeEvent || e)) { e.preventDefault(); if (reply.trim() && !busy) send(); } } })) : null,
				h("div", { className: "rq-row" },
					full ? h("button", { className: "rq-btn pri", disabled: busy || !reply.trim(), onClick: send }, "Send reply") : null,
					h("button", { className: "rq-btn", disabled: busy, onClick: () => act("/v1/reviewed", { id: item.id }, item.id, { advance: true }) }, "Reviewed")));
		}

		function Card({ item, forceFull, selected, onSelect }) {
			const st = useStore();
			const now = useNow(item.type === "question" && !!item.expiresAt);
			const full = forceFull || !!st.expanded[item.id];
			const left = item.expiresAt ? item.expiresAt - now : undefined;
			const Body = item.type === "question" ? QuestionBody : item.type === "permission" ? PermissionBody : CompletedBody;
			const reading = !!(st.snap && st.snap.reading === item.id);
			const toggle = () => { if (onSelect) onSelect(); if (!forceFull) set({ expanded: { ...st.expanded, [item.id]: !full } }); };
			return h("div", { className: "rq-card" + (selected ? " sel" : ""), "data-item": item.id },
				h("div", { className: "rq-card-h", onClick: toggle },
					h("span", { className: "rq-pos" }, "#" + item.position),
					h("span", { className: "rq-chip " + item.type }, typeLabel(item.type)),
					h("span", { className: "rq-title", title: cardTitle(item) }, cardTitle(item)),
					h("span", { className: "rq-meta" },
						left !== undefined ? h("span", { className: "rq-left" + (left < 30000 ? " soon" : ""), title: "Time left before this question expires" }, fmtLeft(left)) : null,
						h("span", null, fmtAge(now - item.createdAt)),
						!forceFull ? h("span", { "aria-hidden": true }, full ? "▾" : "▸") : null)),
				item.sessionTitle || (full && item.workspace) ? h("div", { className: "rq-sub" }, [item.sessionTitle, full ? item.workspace : ""].filter(Boolean).join(" · ")) : null,
				item.earlier ? h("div", { className: "rq-sub" }, "Replaces " + item.earlier + " earlier result" + (item.earlier === 1 ? "" : "s") + " from this session (see Resolved).") : null,
				h(Body, { item, full }),
				st.errors[item.id] ? h("div", { className: "rq-err" }, st.errors[item.id]) : null,
				h("div", { className: "rq-row" },
					h("button", { className: "rq-btn rq-play", disabled: st.busy[item.id], title: reading ? "Stop reading" : "Read the whole message aloud", "aria-pressed": reading, onClick: () => (reading ? act("/v1/stop", {}, item.id) : act("/v1/read", { id: item.id }, item.id)) }, reading ? "■ Stop reading" : "▶ Read aloud"),
					hostApi.openSession ? h("button", { className: "rq-link", onClick: () => openSession(item) }, "Open session ↗") : null));
		}

		function ResolvedCard({ it }) {
			const st = useStore();
			const late = it.type === "question" && it.resolution && it.resolution.kind === "expired";
			const open = !!st.lateOpen[it.id];
			const reopenable = it.type === "completed" && it.resolution && (it.resolution.kind === "reviewed" || it.resolution.kind === "superseded");
			return h("div", { className: "rq-card rq-res" },
				h("div", { className: "rq-card-h" }, h("span", { className: "rq-chip " + it.type }, typeLabel(it.type)), h("span", { className: "rq-title", title: it.sessionTitle }, cardTitle(it)), h("span", { className: "rq-meta" }, fmtAge(Date.now() + state.skew - (it.resolvedAt || 0)))),
				h("div", { className: "rq-sub" }, resolutionText(it)),
				reopenable ? h("div", { className: "rq-row" }, h("button", { className: "rq-btn", disabled: st.busy[it.id], onClick: () => act("/v1/reopen", { id: it.id }, it.id) }, "Reopen")) : null,
				late ? h("div", { className: "rq-row" }, h("button", { className: "rq-link", onClick: () => set({ lateOpen: { ...st.lateOpen, [it.id]: !open } }) }, open ? "Hide" : "Answer now (late) ▸")) : null,
				late && open ? h(QuestionBody, { item: it, full: true, path: "/v1/late-answer", sendLabel: "Send late answer" }) : null,
				late && open ? h("div", { className: "rq-sub" }, "The assistant already carried on with the recommended option. An answer that differs is sent to it as a late reply; the same one is just confirmed.") : null,
				st.errors[it.id] ? h("div", { className: "rq-err" }, st.errors[it.id]) : null);
		}

		function ResolvedList({ items }) {
			const st = useStore();
			const shown = filterItems(items, st.filter);
			return h("div", { className: "rq-opts" }, shown.length ? shown.map((it) => h(ResolvedCard, { key: it.id, it })) : h("div", { className: "rq-empty" }, items.length ? "Nothing matches this filter." : "Nothing resolved in the last 7 days."));
		}

		function FilterBar({ snap }) {
			const st = useStore();
			const f = st.filter;
			const total = snap ? snap.open.length + snap.resolved.length : 0;
			if (total < 4 && !f.query && f.type === "all") return null;
			return h("div", { className: "rq-filter" },
				["all", "completed", "question", "permission"].map((t) => h("button", { key: t, className: "rq-fchip" + (f.type === t ? " on" : ""), "aria-pressed": f.type === t, onClick: () => set({ filter: { ...f, type: t } }) }, t === "all" ? "All" : typeLabel(t))),
				h("input", { className: "rq-input rq-fsearch", placeholder: "Filter by title, session or workspace…", value: f.query, onChange: (e) => set({ filter: { ...f, query: e.target.value } }) }));
		}

		/** One row of the left list: position, type, title, time left on a question, a warning for a risky request. */
		function SideRow({ it, selected }) {
			const now = useNow(it.type === "question" && !!it.expiresAt);
			const ref = useRef(null);
			useEffect(() => { if (selected && ref.current && ref.current.scrollIntoView) ref.current.scrollIntoView({ block: "nearest" }); }, [selected]);
			const left = it.expiresAt ? it.expiresAt - now : undefined;
			const risky = it.risks && it.risks.length;
			return h("button", { ref, className: "rq-row-i" + (selected ? " sel" : ""), onClick: () => set({ selected: it.id }) },
				h("span", { className: "rq-row" }, h("span", { className: "rq-pos" }, "#" + it.position), h("span", { className: "rq-chip " + it.type }, typeLabel(it.type)), h("span", { className: "rq-title" }, cardTitle(it)),
					left !== undefined || risky ? h("span", { className: "rq-meta" },
						left !== undefined ? h("span", { className: "rq-left" + (left < 30000 ? " soon" : ""), title: "Time left before this question expires" }, fmtLeft(left)) : null,
						risky ? h("span", { className: "rq-risk-dot", title: it.risks.map((r) => r.label).join("; ") }, "⚠") : null) : null),
				h("span", { className: "rq-sub rq-clamp" }, it.sessionTitle || ""));
		}

		function Head({ snap, extra }) {
			const st = useStore();
			const n = snap ? snap.open.length : 0;
			return h("div", { className: "rq-head" }, h("h2", null, "Review"), h("span", { className: "rq-count" }, n),
				h("span", { className: "rq-grow" }),
				h("button", { className: "rq-link", onClick: () => set({ showResolved: !st.showResolved }) }, st.showResolved ? "Waiting" : "Resolved (" + (snap ? snap.resolved.length : 0) + ")"),
				extra);
		}

		function Panel() {
			const st = useStore();
			const snap = st.snap;
			const open = visibleOpen();
			const sel = currentItem();
			const none = snap && snap.open.length ? "Nothing matches this filter." : "Nothing waiting on you.";
			const banner = st.error ? h("div", { className: "rq-banner" }, st.error) : null;
			const list = open.length ? open.map((it) => h(Card, { key: it.id, item: it })) : h("div", { className: "rq-empty" }, snap ? none : "Loading…");
			const extra = h("button", { className: "rq-link", title: "Close (Esc)", onClick: () => setOverlay(false) }, "✕ Close");
			return h("div", { className: "rq rq-ov", "data-rq": "overlay", role: "dialog", "aria-label": "Review queue" }, h(Head, { snap, extra }), banner, h(FilterBar, { snap }),
				st.showResolved ? h("div", { className: "rq-body" }, h(ResolvedList, { items: snap ? snap.resolved : [] }))
					: h("div", { className: "rq-split" },
						h("div", { className: "rq-side" }, open.length ? open.map((it) => h(SideRow, { key: it.id, it, selected: !!sel && sel.id === it.id })) : h("div", { className: "rq-empty" }, none)),
						h("div", { className: "rq-detail" }, sel ? h(Card, { key: sel.id, item: sel, forceFull: true, selected: false }) : null),
						h("div", { className: "rq-narrow" }, list)),
				st.showResolved ? null : h("div", { className: "rq-hint" }, "j / k or ↑ ↓ move · r read aloud · e reviewed · Shift+A approve · Shift+D deny · Esc close"));
		}

		/** The full-screen overlay: mounted once, in a root on document.body (the queue is global, not per session). */
		function Overlay() {
			const st = useStore();
			useEffect(() => {
				if (!st.overlay) return undefined;
				const onKey = (e) => {
					if (e.key === "Escape") { setOverlay(false); return; }
					if (state.showResolved) return;
					const action = keyAction(e);
					const cur = action ? currentItem() : undefined;
					if (!cur) return;
					const open = visibleOpen();
					const i = open.findIndex((x) => x.id === cur.id);
					if (action === "next" || action === "prev") { e.preventDefault(); const to = open[Math.min(open.length - 1, Math.max(0, i + (action === "next" ? 1 : -1)))]; if (to) set({ selected: to.id }); return; }
					if (state.busy[cur.id]) return;
					e.preventDefault();
					if (action === "read") { if (state.snap && state.snap.reading === cur.id) act("/v1/stop", {}, cur.id); else act("/v1/read", { id: cur.id }, cur.id); }
					else if (action === "reviewed" && cur.type === "completed") act("/v1/reviewed", { id: cur.id }, cur.id, { advance: true });
					else if (action === "approve" && cur.type === "permission") act("/v1/approve", { id: cur.id }, cur.id, { advance: true });
					else if (action === "deny" && cur.type === "permission") act("/v1/deny", { id: cur.id }, cur.id, { advance: true });
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [st.overlay]);
			return st.overlay ? h("div", { className: "rq rq-ov-back", onMouseDown: (e) => { if (e.target === e.currentTarget) setOverlay(false); } }, h(Panel)) : null;
		}

		/** The header button that opens the overlay. Registered in the session header's utilities slot, last, so it sits just left of the right-sidebar button. */
		function HeaderAnchor() {
			ensureStyle();
			const st = useStore();
			const n = st.snap ? st.snap.open.length : 0;
			return h("span", { className: "rq rq-hwrap" }, h("button", { className: "rq-hbtn" + (st.overlay ? " on" : ""), "data-rq": "anchor", title: st.overlay ? "Close the review queue" : "Open the review queue (" + n + " waiting)", "aria-label": "Review queue", "aria-expanded": st.overlay, onClick: () => setOverlay(!st.overlay) },
				"✔", n > 0 ? h("span", { className: "b" }, n > 99 ? "99+" : n) : null));
		}

		// =====================================================================================
		// Registration
		// =====================================================================================

		const inject = ["slots", "uiWorkspace"];

		function mountOverlayRoot() {
			if (typeof document === "undefined") return () => {};
			let RootApi;
			try { RootApi = require("react-dom/client"); } catch (_e) { return () => {}; }
			if (!RootApi || !RootApi.createRoot) return () => {};
			ensureStyle();
			const host = document.createElement("div");
			host.setAttribute("data-rq-root", "");
			document.body.append(host);
			const root = RootApi.createRoot(host);
			root.render(h(Overlay));
			return () => { setTimeout(() => { root.unmount(); host.remove(); }, 0); };
		}

		function apply(ctx) {
			hostApi.openSession = ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === "function" ? (id) => ctx.uiWorkspace.openSession(id) : undefined;
			stopped = false;
			ctx.effect(() => { pollLoop(); return () => { stopped = true; }; }, "review-queue: polling");
			ctx.effect(mountOverlayRoot, "review-queue: overlay");
			// order 1000: after every other utility, i.e. next to the right-sidebar (corner) button.
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: ANCHOR_ID, order: 1000, label: () => "Review queue" }, HeaderAnchor)), "review-queue: header button");
		}

		exports.inject = inject;
		exports.apply = apply;
		exports.HeaderAnchor = HeaderAnchor;
		exports.__test = { nextAfter, keyAction, filterItems, similarCount, pruneSaved, mdInline, mdBlocks, isSendKey, cardTitle, fmtAge, fmtLeft, baseName, toggleChoice, buildAnswers, answerText, resolutionText, typeLabel, CSS, LS };
		return module.exports;
	}
});
