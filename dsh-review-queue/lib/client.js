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
		const LS = { overlay: "dsh-review-queue.overlay", drafts: "dsh-review-queue.drafts", toggles: "dsh-review-queue.toggles", todoDraft: "dsh-review-queue.todoDraft", tipWorkspace: "dsh-review-queue.tipWorkspace" };
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

		/** The note a detached open question shows (its live request ended, so the answer goes to the session). */
		const detachedNote = (item) => (item && item.type === "question" && item.detached ? "The live request ended; your answer is sent to the session." : undefined);

		/** Done items that left the list without the user acting on them can go back in. */
		const isReopenable = (it) => !!(it && it.type === "completed" && it.resolution && (it.resolution.kind === "reviewed" || it.resolution.kind === "superseded" || it.resolution.kind === "no-action" || it.resolution.kind === "trimmed"));

		/** One line for a resolved item: what happened to it. */
		function resolutionText(item) {
			const r = item.resolution || {};
			const where = r.by === "card" ? "here" : r.by === "screen" ? "on screen" : r.by === "session" ? "in the session" : "";
			switch (r.kind) {
				case "answered": if (r.by === "auto") return "Answered automatically with the recommended option" + (r.answers ? ": " + answerText(r.answers) : ""); return "Answered" + (where ? " " + where : "") + (r.answers ? ": " + answerText(r.answers) : "");
				case "late-answered": return "Answered late" + (r.answers ? ": " + answerText(r.answers) : "");
				case "confirmed": return "Confirmed the recommended option" + (r.answers ? ": " + answerText(r.answers) : "");
				case "expired": return r.assumed && r.assumed.length ? "Expired; recommended option taken: " + r.assumed.join(", ") : "Expired; the assistant carried on";
				case "approved": return "Approved" + (where ? " " + where : "");
				case "denied": return "Denied" + (where ? " " + where : "");
				case "reviewed": return "Reviewed";
				case "started": return "Started" + (item.workspaceTitle ? " in " + item.workspaceTitle : "") + " (in the background)";
				case "followed-up": return "Sent to " + (item.sessionTitle || "the session");
				case "archived": return r.by === "elsewhere" ? "Session archived elsewhere" : "Session archived";
				case "superseded": return "Replaced by a newer result";
				case "no-action": return "Hidden: nothing for you to do (judged from the message; Reopen if it was wrong)";
				case "trimmed": return "Hidden: the session had more than " + (r.limit ? r.limit + " " : "") + "open done results (Reopen to bring it back)";
				case "replied": return r.by === "session" ? "You continued the session" : "You replied";
				case "resumed": return "Resumed";
				case "dismissed": return "Dismissed";
				case "recovered": return "No longer cut off (it continued or ended)";
				case "held": return "Put on hold";
				case "released": return "Taken off hold";
				case "continued": return r.by === "ticket" ? "Continued: the ticket changed" + (r.changes && r.changes.length ? " (" + r.changes.join("; ") + ")" : "") : "Continued from hold";
				case "session-ended": return "Session ended";
				case "cancelled": return r.by === "restart" ? "Cancelled when the server restarted" : "Cancelled";
				default: return "Resolved";
			}
		}

		/** Enter sends a reply; Shift+Enter is a new line and Enter during IME composition belongs to the IME. */
		const isSendKey = (e) => !!e && e.key === "Enter" && !e.shiftKey && !e.isComposing;
		/** Enter in a question's "Other answer…" box: the answers to send, or undefined (do nothing). Plain Enter only (no modifier, no IME keyCode 229),
		 *  this box has text, and every other question already has an answer (buildAnswers is the Send answer button's own check). */
		function enterAnswers(e, questions, drafts, qid) {
			if (!isSendKey(e) || e.ctrlKey || e.altKey || e.metaKey || e.keyCode === 229) return undefined;
			const d = drafts && drafts[qid];
			if (!d || !(d.custom || "").trim()) return undefined;
			return buildAnswers(questions, drafts);
		}
		/** Heading of a card: the task title, else the session title. */
		const cardTitle = (item) => plainAction(item && (item.title || (isFollowUp(item) ? followUpTitle(item) : item.sessionTitle))) || "Untitled";

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

		/** Page-wide hotkey: Ctrl+Alt+L toggles the task list (Ctrl+Alt+V is the voice hotkey, Ctrl+Alt+M stops the TTS). The physical key counts, so AltGr layouts that type another letter still work. */
		function hotkeyAction(e) {
			if (!e || !e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey || e.isComposing) return undefined;
			return e.code === "KeyL" || String(e.key).toLowerCase() === "l" ? "toggle" : undefined;
		}

		/** Listens for the hotkey on `target` (the window), also while typing: a modifier chord is never text. Returns the remover. */
		function installHotkey(target) {
			const onKey = (e) => {
				if (hotkeyAction(e) !== "toggle") return;
				e.preventDefault();
				setOverlay(!state.overlay);
			};
			target.addEventListener("keydown", onKey);
			return () => target.removeEventListener("keydown", onKey);
		}

		/** Filter by type ("all" or an item type) and by text: every word must appear in the title, session, workspace, summary or question. */
		function filterItems(items, f) {
			const type = (f && f.type) || "all";
			const words = ((f && f.query) || "").toLowerCase().split(/\s+/).filter(Boolean);
			return (items || []).filter((it) => {
				if (type !== "all" && it.type !== type) return false;
				if (type === "all" && it.type === "onhold") return false; // the held queue is its own view ("onhold"), never part of the waiting list
				if (!words.length) return true;
				const p = it.payload || {};
				const hay = [it.title, it.sessionTitle, it.workspace, plainAction(it.summary), it.text, p.summary, p.reason, ...(p.questions || []).map((q) => q && q.question)].filter(Boolean).join("\n").toLowerCase();
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

		/** Whether the "Full reply" section of a done card is open: the user's last choice, else open for a short reply and closed for a long one. */
		function detailsOpen(replyOpen, item) {
			const v = replyOpen && replyOpen[item.id];
			if (typeof v === "boolean") return v;
			return ((item.payload && item.payload.reply) || "").length < 1500;
		}

		/** Expand / "Full reply" choices worth keeping: booleans for items still in the queue (open or resolved). */
		function pruneToggles(saved, snap) {
			const live = new Set([...(snap ? snap.open : []), ...(snap ? snap.resolved : [])].map((i) => i.id));
			const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
			const keep = (src) => { const out = {}; for (const [id, v] of Object.entries(obj(src))) if (live.has(id) && typeof v === "boolean") out[id] = v; return out; };
			return { expanded: keep(saved && saved.expanded), reply: keep(saved && saved.reply) };
		}

		// An action item (what the user must do or answer) is written <u>**text**</u>. The tags are only a transport: the screens show the words bold and
		// a step bigger, not underlined (the "bu" token), never the tags. Models spell them in capitals, escape them, drop the bold markers, put them inside the bold
		// markers, nest them or leave them open, so they are cut out of the text first (inline code is left alone: it may talk about the markup) and
		// come back as a placeholder, which mdInline turns into a "bu" token wherever it ended up (also inside **...** or *...*).
		// "<u ...>" has its attributes cut away; the spaced spelling "< u >" must close at once (a comparison such as "n < u and m > 3" is prose); the spaces are bounded so a long run of them cannot backtrack.
		const ACTION_TAG = /`[^`]+`|<(\/?)u(?=[\s>])[^<>]*>|<[ \t]{0,2}(\/?)[ \t]{0,2}u[ \t]{0,2}>|&lt;(\/?)u(?=[\s&])[^<>&]*&gt;/gi;
		const AP_OPEN = "\uE000";
		const AP_CLOSE = "\uE001";
		const AP_SPLIT = /\uE000(\d+)\uE001/g;
		/** { src, spans }: the text with each action span replaced by a placeholder, and the plain words of every span. An open tag runs to the end of the text; a close tag alone is dropped. */
		function extractAction(text) {
			const source = String(text == null ? "" : text).replace(/[\uE000\uE001]/g, "");
			if (!/[<&]/.test(source)) return { src: source, spans: [] }; // no tag can be in it: nothing to cut out
			const spans = [];
			let src = "";
			let cursor = 0;
			let depth = 0;
			let openAt = 0; // where the outermost open tag starts
			let inner = "";
			const emit = () => {
				// Plain words of the span: the **...** around it (or one half of it, when the text was cut) goes, the markdown inside is read once more
				// (no tags are left in it) and reduced to its text.
				const words = mdInline(inner.replace(/^(\s*)\*\*/, "$1").replace(/\*\*(\s*)$/, "$1")).map((t) => t.text).join("");
				inner = "";
				const body = words.trim();
				if (!body) { src += words; return; }
				src += words.slice(0, words.indexOf(body)) + AP_OPEN + spans.length + AP_CLOSE + words.slice(words.indexOf(body) + body.length);
				spans.push(body);
			};
			const tags = new RegExp(ACTION_TAG); // its own lastIndex: emit() below reads the markdown again, which comes back here
			let m;
			while ((m = tags.exec(source))) {
				if (m[0][0] === "`") continue;
				const closing = !!(m[1] || m[2] || m[3]);
				const chunk = source.slice(cursor, m.index);
				cursor = m.index + m[0].length;
				if (depth === 0) { src += chunk; if (!closing) { depth = 1; openAt = m.index; } continue; }
				inner += chunk;
				depth += closing ? -1 : 1;
				if (depth === 0) emit();
			}
			if (depth > 0) {
				// A tag that is never closed is the transport of a cut-off text only when the bold markers follow it; "use the <u> tag" is prose and stays as written.
				const rest = source.slice(cursor);
				if (/^\s*\*\*/.test(rest)) { inner += rest; emit(); } else src += source.slice(openAt);
			} else src += source.slice(cursor);
			return { src, spans };
		}

		/** Tokens whose text may hold placeholders -> tokens with each one a "bu" token (in a link or code token the words are put back as plain text). */
		function expandAction(tokens, spans) {
			if (!spans.length) return tokens;
			const out = [];
			const push = (tok) => { const prev = out[out.length - 1]; if (tok.t === "text" && prev && prev.t === "text") prev.text += tok.text; else out.push(tok); };
			for (const tok of tokens) {
				if (tok.t === "a" || tok.t === "code") { const back = (v) => v.replace(AP_SPLIT, (_, n) => spans[n]); push(tok.href === undefined ? { ...tok, text: back(tok.text) } : { ...tok, text: back(tok.text), href: back(tok.href) }); continue; }
				const parts = tok.text.split(AP_SPLIT);
				parts.forEach((part, i) => {
					if (i % 2) push({ t: "bu", text: spans[part] });
					else if (part) push({ ...tok, text: part });
				});
			}
			return out;
		}

		/** Only the action items of a text as tokens ("text" and "bu"); all other markdown stays as it was written. */
		function actionTokens(text) {
			const { src, spans } = extractAction(text);
			return src ? expandAction([{ t: "text", text: src }], spans) : [];
		}

		/** A text without the action tags (their words stay), for places that show a string: titles, tooltips, the search. */
		function plainAction(text) { return actionTokens(text).map((t) => t.text).join(""); }

		/** Inline markdown -> tokens. Only http(s) links stay links; anything else keeps just its text. */
		function mdInline(text) {
			const out = [];
			const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*/g;
			const pushText = (s) => { if (!s) return; const prev = out[out.length - 1]; if (prev && prev.t === "text") prev.text += s; else out.push({ t: "text", text: s }); };
			let last = 0;
			let m;
			const { src, spans } = extractAction(text);
			while ((m = re.exec(src))) {
				pushText(src.slice(last, m.index));
				if (m[1] !== undefined) out.push({ t: "code", text: m[1] });
				else if (m[2] !== undefined) out.push({ t: "b", text: m[2] });
				else if (m[3] !== undefined) { if (/^https?:\/\//i.test(m[4])) out.push({ t: "a", text: m[3], href: m[4] }); else pushText(m[3]); }
				else out.push({ t: "i", text: m[5] });
				last = re.lastIndex;
			}
			pushText(src.slice(last));
			return expandAction(out, spans);
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

		/**
		 * Voice show/hide of the overlay: what to do with the snapshot's `ui` ({ seq, cmd }) given the last seq this tab has
		 * seen (undefined before its first snapshot). The first snapshot only records the seq; a command acts only when its seq
		 * is newer; a lower seq (the server restarted) just resyncs. Returns { seen, action: "show" | "hide" | undefined }.
		 */
		function uiStep(seen, ui) {
			const seq = ui && typeof ui.seq === "number" && isFinite(ui.seq) ? ui.seq : undefined;
			if (seen === undefined) return { seen: seq === undefined ? 0 : seq, action: undefined };
			if (seq === undefined || seq === seen) return { seen, action: undefined };
			if (seq < seen) return { seen: seq, action: undefined };
			return { seen: seq, action: ui.cmd === "show" || ui.cmd === "hide" ? ui.cmd : undefined };
		}

		/** "N working / M open" (sessions of DSH with a turn running / open sessions), "" while the numbers are unknown. The phone shows the same words. */
		const sessionsText = (s) => (s && Number.isInteger(s.working) && Number.isInteger(s.open) && s.working >= 0 && s.open >= 0 ? s.working + " working / " + s.open + " open" : "");
		const sessionsTitle = "Sessions in DSH: how many have a turn running (working) / how many are open (not archived, no subagents). With the hub on, summed over every running DSH app.";
		/** The long-poll token: what this tab has already seen. The server answers "unchanged" only while the parts it knows still match; the last two (session numbers, tip id) are for a server that has them. */
		// (the numbers part is sessionsKey of sessions.js, this file being one self-contained script)
		const sinceOf = (b) => b.snapshotId + "|" + (b.focusId || "") + "|" + (b.reading || "") + "|" + ((b.ui && b.ui.seq) || 0) + "|" + (b.sessions && Number.isFinite(b.sessions.working) && Number.isFinite(b.sessions.open) ? b.sessions.working + "/" + b.sessions.open : "") + "|" + ((b.tip && b.tip.id) || "");

		const TYPE = { question: "Question", permission: "Permission", completed: "Done", "pr-merged": "PR merged", todo: "Todo", paused: "Paused", onhold: "On hold" };
		const typeLabel = (t) => TYPE[t] || t;
		const recommended = (q, label) => /\(recommended\)/i.test(label);

		// ---- Todo: start a new session from the list ----------------------------------------------------
		const TODO_MAX = 4000;
		// A follow-up todo (kind "followup") sends its text to an EXISTING session found from words; its card and form reuse the todo ones with sessions in place of workspaces.
				// Source of truth for what a follow-up item is: kind 'followup' of todo-follow-up.js (a browser copy of that check; this file is one self-contained script).
		const isFollowUp = (item) => !!item && item.kind === "followup";
		const isFollowUpForm = (f) => !!f && f.mode === "followup";
// Images pasted into the New session form: png, jpeg, webp or gif, at most IMAGE_MAX of up to IMAGE_BYTES each (the server checks the same again).
const IMAGE_MAX = 5;
const IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** The image files of a paste (clipboardData): items of kind file with an image type (a screenshot is one), else its files; [] when there is none. */
function imageFilesOf(data) {
	if (!data) return [];
	const out = [];
	for (const it of data.items ? Array.from(data.items) : []) {
		if (it && it.kind === "file" && IMAGE_TYPES.indexOf(it.type) >= 0) { const f = typeof it.getAsFile === "function" ? it.getAsFile() : null; if (f) out.push(f); }
	}
	if (!out.length && data.files) for (const f of Array.from(data.files)) if (f && IMAGE_TYPES.indexOf(f.type) >= 0) out.push(f);
	return out;
}
		/** The title the server gives a follow-up (speech.js titleFor), for an item that has none. */
		function followUpTitle(item) { const l = String(item.text || "").split(/\r?\n/).find((x) => x.trim()); return l ? "Follow up: " + l.trim() : "Follow up"; }
		/** A pick counts only while the item still lists that session: the list can change under an old pick. */
		const sessionPick = (item, pick) => (pick && Array.isArray(item.candidates) && item.candidates.some((c) => c.sessionId === pick) ? pick : undefined);
		// Source of truth: REF_REASON of todo-follow-up.js, the reason of the deterministic ticket / PR number match. Anything else comes from the model, which read untrusted titles and snippets.
		const REF_REASON = "ticket or PR number in the words";
		// Source of truth: PICKED_REASON of follow-up-shared.js, the reason of a session the user picked in the form's dropdown (no model was asked).
		const PICKED_REASON = "picked by you";
		const isTrustedReason = (r) => r === REF_REASON || r === PICKED_REASON;
		/** A model suggestion for a RUNNING session is never preselected: the user picks it (a crafted title must not steer a message into a working session). */
		function needsOwnPick(item) { const s = item && item.suggested; if (!s || isTrustedReason(s.reason)) return false; const c = (item.candidates || []).find((x) => x.sessionId === s.sessionId); return s.running === true || !!(c && c.running === true); }
		const sessionLabel = (c) => (c.title || "a session") + (c.workspaceTitle ? " · " + c.workspaceTitle : "");
		const sessionPlace = (c) => (c.title || "a session") + (c.workspaceTitle ? " (" + c.workspaceTitle + ")" : "");
		/** Which card a todo shows: confirm (a suggestion), pick (none), suggesting (looking), starting, started, failed, cancelled. */
		function todoCardState(item) {
			if (!item) return "unknown";
			if (item.state === "awaiting-confirm") return item.suggested ? "confirm" : item.suggesting ? "suggesting" : "pick";
			return item.state === "starting" || item.state === "started" || item.state === "failed" || item.state === "cancelled" ? item.state : "unknown";
		}
		/** The workspace id Start would use: the user's pick, else the one given before, else the suggestion. */
		function todoTarget(item, pick) { if (isFollowUp(item)) return sessionPick(item, pick) || item.targetSessionId || (item.suggested && !needsOwnPick(item) ? item.suggested.sessionId : undefined) || undefined; return pick || (item && (item.workspaceId || (item.suggested && item.suggested.workspaceId))) || undefined; }
		const canConfirm = (item, pick) => !!item && item.type === "todo" && (item.state === "awaiting-confirm" || item.state === "failed") && !!todoTarget(item, pick);
		/** The workspace dropdown of a todo card, as an instruction for the select: the value to show selected (the user's pick, else the one given before, else the suggestion; "" when none), the options (the loaded workspaces, plus the target when it is not in them yet) and the placeholder (only while nothing is selected). */
		function todoSelect(item, pick, workspaces) {
			if (isFollowUp(item)) {
				const value = todoTarget(item, pick) || "";
				const options = (item.candidates || []).map((c) => ({ id: c.sessionId, title: sessionLabel(c) }));
				if (value && !options.some((o) => o.id === value)) options.unshift({ id: value, title: item.suggested && item.suggested.sessionId === value ? sessionLabel(item.suggested) : item.sessionTitle || "the chosen session" });
				return { value, options, placeholder: value ? undefined : "Pick a session…" };
			}
			const value = todoTarget(item, pick) || "";
			const options = (workspaces || []).map((w) => ({ id: w.id, title: w.title }));
			if (value && !options.some((o) => o.id === value)) {
				const known = item && item.suggested && item.suggested.workspaceId === value ? item.suggested.title : item && item.workspaceTitle;
				options.unshift({ id: value, title: known || "the chosen workspace" });
			}
			return { value, options, placeholder: value ? undefined : "Pick a workspace…" };
		}
		/** The sentence under the text of a follow-up. */
		function followUpLine(item, pick) {
			switch (todoCardState(item)) {
				case "confirm": case "pick": case "suggesting": {
					const s = item.suggested;
					const p = sessionPick(item, pick);
					if (p && !(s && s.sessionId === p)) return "Send to " + sessionPlace(item.candidates.find((c) => c.sessionId === p));
					if (s) return (!p && needsOwnPick(item) ? "Model suggests: " : "Session: ") + sessionPlace(s) + (s.reason ? " — " + (isTrustedReason(s.reason) ? "" : "Model says: ") + s.reason : "");
					if (item.suggesting) return "Finding the session…";
					return typeof item.suggestNote === "string" && item.suggestNote ? "Pick a session (no suggestion: " + item.suggestNote + ")" : "Pick a session";
				}
				case "starting": return "Sending…";
				case "started": return "Sent" + (item.sessionTitle ? " to " + item.sessionTitle : "");
				case "failed": return "Could not send: " + (item.error || "unknown error");
				default: return "";
			}
		}
		/** The sentence under the task text. */
		function todoLine(item, pick, workspaces) {
			if (isFollowUp(item)) return followUpLine(item, pick);
			const title = (id) => { const w = (workspaces || []).find((x) => x.id === id); return w ? w.title : "the chosen workspace"; };
			switch (todoCardState(item)) {
				case "confirm": case "pick": case "suggesting": {
					const s = item.suggested;
					if (pick && !(s && s.workspaceId === pick)) return "Start in " + title(pick);
					if (s) return "Start in " + s.title + (s.reason ? " — " + s.reason : "");
					if (item.suggesting) return "Looking for a workspace…";
					// Why there is no suggestion (timed out, no model, no clear fit...), so a silent failure is visible.
					return typeof item.suggestNote === "string" && item.suggestNote ? "Pick a workspace (no suggestion: " + item.suggestNote + ")" : "Pick a workspace";
				}
				case "starting": return "Starting" + (item.workspaceTitle ? " in " + item.workspaceTitle : "") + "…";
				case "started": return "Started" + (item.workspaceTitle ? " in " + item.workspaceTitle : "");
				case "failed": return "Could not start: " + (item.error || "unknown error");
				default: return "";
			}
		}
		/** What waits on the user: a todo that is being started does not, and a session paused by a restart has its own count. */
		const waitingCount = (open) => (open || []).filter((i) => i.type !== "paused" && i.type !== "onhold" && !(i.type === "todo" && i.state === "starting")).length;
		/** How many sessions are on hold (open onhold items): their own queue, never counted as waiting. */
		const heldCount = (open) => (open || []).filter((i) => i.type === "onhold").length;
		/** How often the plugin looks at the ticket of a held session (onHoldCheckMs, default 10 minutes; a test keeps the text honest only by this note). */
		const HELD_CHECK_TEXT = "every 10 minutes";
		/** The lines an on-hold card shows: why, the ticket being watched, how long it has been held, when it was last checked, and what went wrong. The phone card shows the same. */
		function heldFacts(item, now) {
			const p = (item && item.payload) || {};
			const facts = [p.reason || "On hold"];
			if (p.ticket && p.ticket.id) facts.push("Waiting on ticket " + p.ticket.id + " (checked " + HELD_CHECK_TEXT + "; a new comment, state, assignee or description change continues the session)");
			else facts.push("No ticket to watch: use Continue or Release when it can go on");
			facts.push("Held " + fmtAge(now - (p.heldAt || 0)));
			if (p.ticket && p.ticket.id) facts.push(p.lastCheckedAt ? "Last checked " + fmtAge(now - p.lastCheckedAt) : "Not checked yet");
			if (p.checkError) facts.push("Could not read the ticket (" + p.checkError + ")");
			if (p.continueError) facts.push("Could not prompt the session (" + p.continueError + ")");
			return facts;
		}
		/** How many sessions a restart cut off (open paused items). */
		const pausedCount = (open) => (open || []).filter((i) => i.type === "paused").length;
		/** The lines a paused card shows: why, how long ago, a tool call that may be half done, the last request. The phone card shows the same. */
		function pausedFacts(item, now) {
			const p = (item && item.payload) || {};
			const facts = [p.reason || "Cut off by a restart or crash", "Last activity " + fmtAge(now - (p.lastWrite || 0))];
			if (p.danglingCalls && p.danglingCalls.length) facts.push("The last tool call had no result and may be half done: " + p.danglingCalls.join(", "));
			if (p.lastUser) facts.push("Last request: " + p.lastUser);
			return facts;
		}
		// ---- Resume all: confirm, then a few sessions at a time ------------------------------------------
		/** Sessions resumed at a time (the same number as RESUME_CONCURRENCY in paused.js; a test keeps them equal). */
		const RESUME_AT_A_TIME = 3;
		/** The last resort: a resumed session that neither reports back (a done, question or permission item) nor shows as stopped frees its place after this long. */
		const RESUME_SLOT_MS = 2 * 60 * 1000;
		/** A held place asks every RESUME_POLL_MS whether its session still runs, from RESUME_GRACE_MS on (a session restored from cold needs a while to begin its turn: it is not listed as running before that). */
		const RESUME_POLL_MS = 3000;
		const RESUME_GRACE_MS = 30000;
		/** Two polls in a row that do not list the session mean it stopped; a failed poll is "unknown" and counts for nothing. */
		const RESUME_STOPPED_POLLS = 2;
		/** A running-sessions request that has not answered by then is a failed poll (and no longer shared with the next lane). */
		const RESUME_POLL_TIMEOUT_MS = 10000;
		const resumeAllText = (n) => (n === 1 ? "Resume 1 paused session? It gets the standard resume prompt." : "Resume all " + n + " paused sessions, " + RESUME_AT_A_TIME + " at a time? Each one gets the standard resume prompt.");
		/** A resumed session has stopped working again when it has a new done, question or permission item since the resume. */
		function settledAfter(snap, item, since) {
			if (!snap) return false;
			return [...(snap.open || []), ...(snap.resolved || [])].some((i) => i.sessionId === item.sessionId && (i.type === "completed" || i.type === "question" || i.type === "permission") && i.createdAt >= since);
		}
		/**
		 * Resumes items with at most `limit` working at a time: a place is taken when a resume is sent and given back when the session has settled
		 * (settled(item, signal) resolves), when poll(item) answered "stopped" twice in a row (poll: 'running' | 'stopped' | 'unknown', asked every
		 * pollMs from graceMs on, one request at a time, only while the place is held), when the resume was refused, or after slotMs.
		 * Aborting starts no new one. Never throws. sleep(ms, signal) can be replaced (a signal that aborts ends the wait early).
		 * Returns { total, started, ok, failed: [{ id, error }], cancelled }; onProgress gets { total, started, ok, failed, running, waiting }
		 * (waiting: not given a place yet).
		 */
		async function runResumeAll({ items, limit = RESUME_AT_A_TIME, resume, settled, poll, signal, onProgress, slotMs = RESUME_SLOT_MS, pollMs = RESUME_POLL_MS, graceMs = RESUME_GRACE_MS, sleep = sleepFor }) {
			const p = { total: items.length, started: 0, ok: 0, failed: 0, running: 0, waiting: items.length };
			const failed = [];
			let next = 0;
			const report = () => { if (onProgress) onProgress({ ...p }); };
			const aborted = () => !!(signal && signal.aborted);
			const abortWait = new Promise((resolve) => { if (signal) signal.addEventListener("abort", resolve, { once: true }); });
			const NEVER = new Promise(() => {});
			/** Resolves when the session stopped (see above); resolves too when ended by the signal, which only happens after the place is freed anyway. */
			async function stopped(item, stop) {
				await sleep(graceMs, stop);
				for (let misses = 0; !stop.aborted;) {
					let answer;
					try { answer = await poll(item); } catch (_e) { answer = "unknown"; }
					if (stop.aborted) return;
					misses = answer === "stopped" ? misses + 1 : 0;
					if (misses >= RESUME_STOPPED_POLLS) return;
					await sleep(pollMs, stop);
				}
			}
			async function lane() {
				while (next < items.length && !aborted()) {
					const item = items[next++];
					p.started++; p.running++; p.waiting--; report();
					let r;
					try { r = await resume(item); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
					if (r && r.ok) {
						p.ok++;
						const release = new AbortController(); // ends the slot timer, the polling and the settled watch the moment the place is freed
						await Promise.race([Promise.resolve().then(() => settled(item, release.signal)).catch(() => {}), sleep(slotMs, release.signal), abortWait, poll ? stopped(item, release.signal) : NEVER]);
						release.abort();
					} else { p.failed++; failed.push({ id: item.id, error: (r && r.error) || "failed" }); }
					p.running--; report();
				}
			}
			await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
			return { total: p.total, started: p.started, ok: p.ok, failed, cancelled: aborted() && p.started < items.length };
		}
		/** Waits ms; ends early when the signal aborts. */
		function sleepFor(ms, signal) {
			return new Promise((resolve) => {
				if (signal && signal.aborted) { resolve(); return; }
				const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", done); resolve(); }; // no listener builds up on a long-lived signal
				const timer = setTimeout(done, ms);
				if (signal) signal.addEventListener("abort", done, { once: true });
			});
		}
		/** The text of the running phase: how many started, are working and (when some are) wait for a free place. */
		function resumeProgressText(p) {
			return "Resuming: " + p.started + " of " + p.total + " started, " + p.running + " working" + (p.waiting > 0 ? ", " + p.waiting + " waiting for a place" : "") + "…";
		}
		/** The filter chips, in order ("all" first); the phone page draws the same set. */
		const FILTER_TYPES = ["all", "completed", "question", "permission", "pr-merged", "todo", "paused"];
		/** The filter bar shows from four items in all (waiting + resolved), and always while a type or a search is active. */
		function filterBarVisible(snap, f) {
			const total = snap ? snap.open.length + snap.resolved.length : 0;
			return !(total < 4 && !(f && f.query) && !(f && f.type && f.type !== "all"));
		}
		/** The endpoint a keyboard action calls for an item; Shift+A, Shift+D and e only apply to the cards they belong to (never a todo). */
		function keyRoute(action, item) {
			const type = item && item.type;
			if (action === "reviewed" && type === "completed") return "/v1/reviewed";
			if (action === "approve" && type === "permission") return "/v1/approve";
			if (action === "deny" && type === "permission") return "/v1/deny";
			return undefined;
		}
		/** Ctrl+Enter (or Cmd+Enter) submits the todo form; plain Enter is a new line. */
		const isSubmitKey = (e) => !!e && e.key === "Enter" && !!(e.ctrlKey || e.metaKey) && !e.isComposing;
		/** What is wrong with the form, if anything. followUp is the id of the session picked for a follow-up; undefined for a todo that starts a new session. */
		function todoFormProblem(text, followUp) {
			const t = String(text || "").trim();
			if (!t) return "Type the task first.";
			if (t.length > TODO_MAX) return "That is too long.";
			if (followUp === undefined) return undefined;
			return String(followUp || "").trim() ? undefined : "Pick the session this is for.";
		}
		/** The Tune prompt button works on a text that is there and while nothing else is going on. */
		const canTune = (f) => !!f && !f.busy && !f.tuning && !!String(f.text || "").trim();
		/** The form after a tune answer { ok, text } | { ok: false, error }: the tuned text replaces the text and the FIRST text typed is kept as original (for Undo); a failure changes nothing but the message. */
		function nextFormAfterTune(f, result) {
			if (!result.ok) return { ...f, tuning: false, error: result.error };
			const questions = tuneQuestionsOf(result.questions);
			return { ...f, text: result.text, original: f.original || f.text, tuning: false, error: undefined, questions: questions.length ? questions : undefined };
		}
		const TUNE_QUESTIONS_MAX = 5;
		/** The open questions of a tune answer as the panel keeps them, [{ question, default?, answer }] (the answer starts as the default); anything that is not a question with a text is skipped. */
		function tuneQuestionsOf(list) {
			return (Array.isArray(list) ? list : []).filter((q) => q && typeof q === "object" && typeof q.question === "string" && q.question.trim()).slice(0, TUNE_QUESTIONS_MAX)
				.map((q) => { const d = typeof q.default === "string" && q.default.trim() ? q.default.trim() : undefined; return { question: q.question.trim(), ...(d ? { default: d } : {}), answer: d || "" }; });
		}
		/** The Open session control of a resolved card: a BUTTON for a started todo, the small link for the rest, none without a session or host. */
		function openControl(it, hostHasOpen) { return resolvedOpenAction(it, hostHasOpen) !== "open" ? "none" : it.type === "todo" ? "button" : "link"; }

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
		function loadToggles() {
			try {
				const j = JSON.parse(storage.get(LS.toggles) || "null");
				const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
				return { expanded: obj(j && j.expanded), reply: obj(j && j.reply) };
			} catch (_e) { return { expanded: {}, reply: {} }; }
		}
		/** The unsent todo form (text, workspace, SPARC, open, the text before a tune) is restored after a reload or a crash; busy, error and tuning never are. */
		function loadTodoForm() {
			const form = { open: false, text: "", workspaceId: "", sparc: false, effort: "", mode: "new", followUp: "", busy: false, error: undefined };
			try {
				const j = JSON.parse(storage.get(LS.todoDraft) || "null");
				if (!j || typeof j !== "object" || Array.isArray(j)) return form;
				const str = (v) => (typeof v === "string" ? v : "");
				return { ...form, open: j.open === true, text: str(j.text), workspaceId: str(j.workspaceId), sparc: j.sparc === true, effort: str(j.effort), mode: j.mode === "followup" ? "followup" : "new", followUp: str(j.followUp), ...(str(j.original) ? { original: j.original } : {}) };
			} catch (_e) { return form; }
		}
		const saved = loadSaved();
		const savedToggles = loadToggles();
		const state = {
			snap: null, error: null, skew: 0, expanded: savedToggles.expanded, drafts: saved.drafts, replies: saved.replies, replyOpen: savedToggles.reply, busy: {}, errors: {},
			selected: null, showResolved: false, showHeld: false, holdOpen: {}, showPhone: false, lateOpen: {}, filter: { type: "all", query: "" }, overlay: storage.get(LS.overlay) === "1",
			todoForm: loadTodoForm(), workspaces: null, efforts: null, followSessions: null, todoPick: {}, tipDeeper: {}, tipUse: { open: false, workspaceId: "" },
			resumeAll: null, scanNote: undefined, scanning: false,
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
		let toggleTimer;
		function scheduleToggleSave() {
			clearTimeout(toggleTimer);
			toggleTimer = setTimeout(() => storage.set(LS.toggles, JSON.stringify({ expanded: state.expanded, reply: state.replyOpen })), 300);
		}
		/** Writes the todo form draft NOW (no timer: a crash right after a keystroke must not lose it). The text is never shortened. */
		function saveTodoForm() {
			const f = state.todoForm;
			storage.set(LS.todoDraft, JSON.stringify({ text: f.text, workspaceId: f.workspaceId, sparc: !!f.sparc, ...(f.effort ? { effort: f.effort } : {}), open: !!f.open, ...(isFollowUpForm(f) ? { mode: "followup" } : {}), ...(f.followUp ? { followUp: f.followUp } : {}), ...(f.original ? { original: f.original } : {}) }));
		}
		/** The page going away or to the background saves the draft once more; returns the remover. */
		function installDraftFlush(win, doc) {
			const onHide = () => { if (doc.visibilityState === "hidden") saveTodoForm(); };
			win.addEventListener("pagehide", saveTodoForm);
			win.addEventListener("beforeunload", saveTodoForm);
			doc.addEventListener("visibilitychange", onHide);
			return () => { win.removeEventListener("pagehide", saveTodoForm); win.removeEventListener("beforeunload", saveTodoForm); doc.removeEventListener("visibilitychange", onHide); };
		}
		function set(patch) {
			Object.assign(state, patch);
			if ("todoForm" in patch) saveTodoForm();
			if ("drafts" in patch || "replies" in patch) scheduleSave();
			if ("expanded" in patch || "replyOpen" in patch) scheduleToggleSave();
			version++;
			listeners.forEach((l) => l());
		}
		function visibleOpen() { return state.snap ? filterItems(state.snap.open, state.showHeld ? { ...state.filter, type: "onhold" } : state.filter) : []; }
		/** The selected card: the chosen one, else the one the voice focus is on, else the oldest. */
		function currentItem() {
			const open = visibleOpen();
			return open.find((i) => i.id === state.selected) || open.find((i) => i.id === (state.snap && state.snap.focusId)) || open[0];
		}
		const subscribe = (l) => { listeners.add(l); return () => { listeners.delete(l); }; };
		const useStore = () => { useSyncExternalStore(subscribe, () => version); return state; };

		/** Takes a fresh snapshot into the store. */
		function applySnapshot(body) {
			set({ snap: body, error: null, skew: (body.serverNow || Date.now()) - Date.now() });
			const tog = pruneToggles({ expanded: state.expanded, reply: state.replyOpen }, body);
			if (Object.keys(state.expanded).some((k) => !(k in tog.expanded)) || Object.keys(state.replyOpen).some((k) => !(k in tog.reply))) set({ expanded: tog.expanded, replyOpen: tog.reply });
		}

		/** Whether somebody can see this page now: the hub's presence (is the desktop looked at?) counts only polls that say so. */
		const pageVisible = () => typeof document !== "undefined" && document.visibilityState === "visible";

		let polling = false;
		let stopped = false;
		let pollCtl; // aborts the request in flight: opening or closing the overlay changes what the next one asks for (tip=1)
		async function pollLoop() {
			if (polling) return;
			polling = true;
			let since;
			let fails = 0;
			while (!stopped) {
				try {
					// tip=1 only while the overlay is open AND the page is visible: the tip (a model call) and the session numbers are for an overlay somebody looks at.
					const url = API + "/v1/snapshot?wait=" + WAIT_MS + (since ? "&since=" + encodeURIComponent(since) : "") + (pageVisible() ? "&visible=1" : "") + (state.overlay && pageVisible() ? "&tip=1" : "");
					pollCtl = typeof AbortController === "function" ? new AbortController() : undefined;
					const res = await fetch(url, pollCtl ? { credentials: "same-origin", signal: pollCtl.signal } : { credentials: "same-origin" });
					if (!res.ok) throw new Error("HTTP " + res.status);
					const body = await res.json();
					fails = 0;
					if (body.unchanged) { if (state.error) set({ error: null }); continue; }
					since = sinceOf(body);
					applySnapshot(body);
					applyUi(body.ui);
					const kept = pruneSaved({ drafts: state.drafts, replies: state.replies }, body);
					const gone = Object.keys(state.drafts).some((k) => !(k in kept.drafts)) || Object.keys(state.replies).some((k) => !(k in kept.replies));
					if (gone) set(kept);
				} catch (e) {
					if (e && e.name === "AbortError" && !stopped) continue; // our own abort: ask again at once
					fails++;
					if (!stopped) set({ error: "Coding Boss Review Queue unreachable (" + String((e && e.message) || e) + "). Is dsh-review-queue loaded? Restart DSH after installing it." });
					await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * fails)));
				}
			}
			polling = false;
		}

		/** A tab that is shown or hidden changes what the next poll asks for (tip=1 only while visible): ask again at once. Returns the remover. */
		function installRepoll(doc) {
			const onChange = () => { if (pollCtl) pollCtl.abort(); };
			doc.addEventListener("visibilitychange", onChange);
			return () => doc.removeEventListener("visibilitychange", onChange);
		}

		/** POST JSON to the plugin; returns the words for a failure, undefined on success. */
		async function post(path, body) {
			try {
				const res = await fetch(API + path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
				if (!res.ok) { const j = await res.json().catch(() => ({})); return errorText(res.status, j); }
			} catch (e) { return "Request failed: " + String((e && e.message) || e); }
			return undefined;
		}
		/** POST JSON and read the answer: { ok: true, body } on success, else { ok: false, error: words }. */
		async function postJson(path, body) {
			try {
				const res = await fetch(API + path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
				const j = await res.json().catch(() => ({}));
				if (!res.ok || !j || j.ok === false) return { ok: false, code: j && j.error, error: errorText(res.ok ? 409 : res.status, j) };
				return { ok: true, body: j };
			} catch (e) { return { ok: false, error: "Request failed: " + String((e && e.message) || e) }; }
		}
		async function act(path, body, id, opts) {
			// After a successful action on the selected card, the next card becomes the selected one.
			const cur = opts && opts.advance ? currentItem() : undefined;
			const nextId = cur && cur.id === id ? nextAfter(visibleOpen(), id) : undefined;
			const advance = !!cur && cur.id === id;
			set({ busy: { ...state.busy, [id]: true }, errors: { ...state.errors, [id]: undefined } });
			const error = await post(path, body);
			set({ busy: { ...state.busy, [id]: false }, errors: { ...state.errors, [id]: error } });
			if (!error && advance) set({ selected: nextId || null });
			return !error;
		}
		const ERRORS = {
			"not-open": "That item is no longer waiting.", "not-pending": "That request is no longer waiting for an answer.",
			"bad-answer": "That answer does not match the question.", "bad-effort": "That effort is not valid.", "empty": "Type something first.", "too-long": "That is too long.",
			"no-controller": "Cannot reach the session right now.", "not-completed": "That only applies to finished work.", "not-pr-merged": "That only applies to a merged pull request.", "needs-confirm": "Confirm the approval first.", "needs-hold": "A risky request needs the press-and-hold confirmation.", "no-registry": "Cannot reach the session list right now.",
			"not-expired": "That question is not waiting for a late answer.", "no-session": "That session is not running any more, so the answer cannot be delivered.", "reply-queued": "An answer is already on its way to that session.",
			"muted": "Voice is muted. Turn it back on in the TTS settings first.", "no-speaker": "The speech engine is not available (is dsh-hooks-tts installed?).", "nothing-to-read": "There is nothing to read.", "not-found": "That item no longer exists.", "not-reopenable": "That item cannot be reopened.", "risky": "That request looks risky, so it has to be approved on its own.", "not-permission": "That is not a permission request.",
			"owner-offline": "That app is not running, so this cannot be sent.", "session-unavailable": "That session is not available in this app, so this cannot be sent.", "owner-away": "That app is not answering at the moment, so this cannot be sent.", "owner-timeout": "That app did not answer in time. Try again.", "unknown-outcome": "Sent, but no confirmation: refresh to check.", "local-only": "That can only be done in the DSH app on the computer.",
			"session-gone": "That session no longer exists, so it cannot be resumed.", "not-paused": "That only applies to a paused session.", "no-scanner": "The scan for paused sessions is switched off in this app.", "no-power": "Pausing and quitting is not available in this app.",
			"no-workspace": "Pick a workspace first.", "no model available": "No model is available to write that right now.", "LLM error": "The model could not do that. Try again.", "unknown-workspace": "That workspace no longer exists.", "empty-query": "Say which session this is for.", "unknown-session": "That session is not in the list any more. Pick another one.", "too-many-follow-ups": "Too many follow-ups are waiting: confirm or cancel one first.", "not-confirmable": "That todo is already being started or is done.", "not-todo": "That only applies to a todo.",
			"post-failed": "The message could not be sent to the session.", "not-a-session": "That item is not a session, so nothing can be sent to it.", "paused": "That session was paused by a restart. Resume it at the PC first.", "onhold": "That session is on hold. Continue it first (or release it).", "not-holdable": "Only finished work or a paused session can be put on hold.", "no-onhold": "Putting a session on hold is not available in this app.", "busy": "A message to that session is already on its way. Try again in a moment.",
				"bad-images": "An attached image is not valid. Remove it and paste it again.", "too-many-images": "At most " + IMAGE_MAX + " images can be attached.", "unknown-image": "An attached image is no longer on the PC. Remove it and paste it again.", "bad-image": "That is not an image the session can take (png, jpeg, webp or gif).", "too-large": "That image is over 8 MB.",
		};

		const OLD_SERVER = "The Coding Boss Review Queue server is older than this page and does not know this action. Restart DSH.";
		/** The words for a failed action. An unknown route is HTTP 404 (new servers say "unknown-action", an OLD server that lacks the
		 *  route says "not-found", so any 404 counts); a missing item is a 409 "not-found" and keeps its own text. */
		function errorText(status, body) {
			const code = body && typeof body === "object" ? body.error : undefined;
			if (code === "unknown-action" || status === 404) return OLD_SERVER;
			if (code === "no-session" && status === 400) return "Pick a session first."; // a follow-up confirm with nothing picked (a reply or an archive that cannot be delivered is a 409)
			if (typeof code === "string" && Object.prototype.hasOwnProperty.call(ERRORS, code)) return ERRORS[code];
			return "Could not do that (" + (code || "HTTP " + status) + ").";
		}

		// Host capabilities captured in apply(); absent on a DSH without the workspace API, which just hides the button.
		const hostApi = { openSession: undefined };
		/** Reading aloud ends with the overlay: whoever closes it or jumps to a session does not want to keep listening. */
		function stopReading() {
			if (state.snap && state.snap.reading) fetch(API + "/v1/stop", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
		}
		const REVEAL_DELAYS_MS = [0, 120, 300, 700, 1400]; // the row may not be rendered yet when the host call returns
		const quoteAttr = (s) => String(s).replace(/["\\]/g, "\\$&");
		/** Scrolls the left panel (DSH's session tree) to the row of a session, so it is visible once it is selected. A row hidden inside a collapsed group of the
		 *  dsh-hooks-tts tree opens that group by clicking its header; a row that is not there (yet) is looked for again a few times, and behind the collapsed Show more buttons. opts: { doc, later } for tests. */
		function revealSessionRow(id, opts) {
			const doc = opts && "doc" in opts ? opts.doc : typeof document === "undefined" ? undefined : document;
			const later = (opts && opts.later) || ((fn, ms) => setTimeout(fn, ms));
			if (!doc || typeof doc.querySelector !== "function" || !id) return;
			const sel = '[data-row-key="session:' + quoteAttr(id) + '"]';
			let i = 0;
			const opened = new Set();
			/** The session may sit behind a workspace's collapsed "Show N more sessions" button (data-row-key="overflow:<workspace>"): each such button is clicked once. */
			const openOverflow = () => {
				if (typeof doc.querySelectorAll !== "function") return;
				let buttons = [];
				try { buttons = Array.from(doc.querySelectorAll('[data-row-key^="overflow:"][aria-expanded="false"]')); } catch (_e) { return; }
				buttons.forEach((b) => { if (!opened.has(b) && typeof b.click === "function") { opened.add(b); try { b.click(); } catch (_e) { /* a button that cannot be clicked is skipped */ } } });
			};
			const attempt = () => {
				let row = null;
				try { row = doc.querySelector(sel); } catch (_e) { return; }
				if (!row && i >= 1) openOverflow(); // the first look gets the normal render time; after that a row that is still missing may be behind a Show more
				if (row) {
					if (row.offsetParent !== null) { try { row.scrollIntoView({ block: "center" }); } catch (_e) { /* a row that cannot scroll is still selected */ } return; }
					const gid = typeof row.getAttribute === "function" ? row.getAttribute("data-hooks-gt-group") : null;
					const head = gid ? doc.querySelector('[data-hooks-group-header="' + quoteAttr(gid) + '"]') : null;
					const open = head && typeof head.getAttribute === "function" ? head.getAttribute("aria-expanded") === "true" : false;
					if (head && !open && typeof head.click === "function") head.click();
				}
				if (i < REVEAL_DELAYS_MS.length - 1) { i++; later(attempt, REVEAL_DELAYS_MS[i]); }
			};
			attempt();
		}
		/** Go to the item's session and close the overlay. The host can refuse (the session is gone): then the overlay stays open
		 *  and the card says so. The host call may be sync (throws) or async (rejects). */
		function openSession(item) {
			if (!hostApi.openSession) return;
			const failed = () => set({ errors: { ...state.errors, [item.id]: "That session no longer exists." } });
			const done = () => { stopReading(); set({ overlay: false }); storage.set(LS.overlay, "0"); revealSessionRow(item.sessionId); };
			let result;
			try { result = hostApi.openSession(item.sessionId); } catch (e) { failed(); return; }
			if (result && typeof result.then === "function") result.then(done, failed); else done();
		}
		let uiSeen; // the last ui command seq this tab has seen; undefined until its first snapshot
		/** A show/hide command from the server (voice): goes through setOverlay, like the header button, so it is stored too. */
		function applyUi(ui) {
			const step = uiStep(uiSeen, ui);
			uiSeen = step.seen;
			if (step.action) setOverlay(step.action === "show");
		}
		const patchForm = (p) => set({ todoForm: { ...state.todoForm, ...p } });
		/** The efforts the dropdown lists (the default model's), [] before they are known. */
		const effortChoices = (e) => (e && Array.isArray(e.efforts) ? e.efforts.filter((x) => x && typeof x.id === "string") : []);
		const effortName = (e, id) => { const x = effortChoices(e).find((c) => c.id === id); return x ? x.name || x.id : id; };
		/** "Default (Medium)": the first option, the effort the model uses unless one is picked. */
		const defaultEffortLabel = (e) => (e && e.defaultEffort ? "Default (" + effortName(e, e.defaultEffort) + ")" : "Default");
		/** The dropdown's workspaces (id, title); best effort, the todo form and the cards work without them (Choose for me). */
		async function loadWorkspaces() {
			try {
				const res = await fetch(API + "/v1/workspaces", { credentials: "same-origin" });
				if (res.ok) { const j = await res.json(); if (j && Array.isArray(j.workspaces)) { set({ workspaces: j.workspaces }); dropStaleWorkspace(j.workspaces); } }
			} catch (_e) { /* keep what we have */ }
		}
		/** The efforts of the default model for the Effort dropdown (GET /v1/model-efforts); best effort, the form works without it (no dropdown). A saved effort the model no longer has is dropped. */
		async function loadEfforts() {
			try {
				const res = await fetch(API + "/v1/model-efforts", { credentials: "same-origin" });
				if (!res.ok) return;
				const j = await res.json();
				if (!j || !Array.isArray(j.efforts)) return;
				set({ efforts: j });
				const cur = state.todoForm.effort;
				if (cur && !j.efforts.some((e) => e && e.id === cur)) patchForm({ effort: "" });
			} catch (_e) { /* keep what we have */ }
		}
		/** The dropdown's sessions of the Follow up form (sessionId, title, workspaceTitle?, running?), newest first; asked again every time the form is shown, the list changes. Best effort. */
		async function loadFollowSessions() {
			try {
				const res = await fetch(API + "/v1/follow-up-sessions", { credentials: "same-origin" });
				if (res.ok) {
					const j = await res.json();
					if (j && Array.isArray(j.sessions)) { const list = j.sessions.filter((x) => x && typeof x.sessionId === "string"); set({ followSessions: list, followSessionsError: undefined }); dropStaleFollowSession(list); return; }
				}
				set({ followSessionsError: res.status === 404 ? OLD_SERVER : "Could not load the sessions. Close and reopen the form to try again." });
			} catch (_e) { set({ followSessionsError: "Could not load the sessions. Close and reopen the form to try again." }); }
		}
		/** A restored draft may name a session that is gone (or hold the words an older form took): once a non-empty list is known and lacks it, the pick is cleared. */
		function dropStaleFollowSession(list) {
			const id = state.todoForm.followUp;
			if (id && list.length && !list.some((x) => x.sessionId === id)) patchForm({ followUp: "" });
		}
		/** The first option of the session dropdown: says what is going on while it has no sessions. */
		const followPlaceholder = (list, error) => (!Array.isArray(list) ? (error || "Loading sessions…") : list.length ? "Which session?" : "No session is listed yet");
		/** A session as the dropdown shows it: its title, its workspace, and a mark when it is working right now. */
		const followLabel = (c) => sessionLabel(c) + (c.running === true ? " (working)" : "");
		/** A restored draft may name a workspace that is gone: once a non-empty list is known and lacks it, the pick falls back to "Choose for me" (an empty list may just not be loaded yet). */
		function dropStaleWorkspace(list) {
			const id = state.todoForm.workspaceId;
			if (id && list.length && !list.some((w) => w && w.id === id)) patchForm({ workspaceId: "" });
		}
		/** The list again when none was loaded or the loaded one is empty: the app may not have had its workspaces yet when it was first asked. */
		function ensureWorkspaces() { return state.workspaces && state.workspaces.length ? undefined : loadWorkspaces(); }
		/** Why the dropdown has nothing but "Choose for me": a list that loaded empty is said so; nothing before it loaded or while it has entries. */
		const workspacesNote = (list) => (Array.isArray(list) && !list.length ? "No workspace is listed yet (the app may still be loading them). Choose for me works without one." : undefined);
		// Each tune takes a number; closing or reopening the form takes the next one, so the answer of a tune from before is ignored and cannot overwrite the saved draft.
		let tuneSeq = 0;
		function openTodoForm() { if (!state.todoForm.open) tuneSeq++; patchForm({ open: true, error: undefined }); if (isFollowUpForm(state.todoForm)) loadFollowSessions(); else { loadWorkspaces(); loadEfforts(); } }
		/** The switch of the form: New session (the dropdown needs the workspaces) or Follow up (its dropdown needs the sessions, never the workspaces). */
		function setTodoMode(mode) { patchForm({ mode: mode === "followup" ? "followup" : "new", error: undefined }); if (mode === "followup") loadFollowSessions(); else { ensureWorkspaces(); loadEfforts(); } }
		function closeTodoForm() { tuneSeq++; patchForm({ open: false, error: undefined, tuning: false, questions: undefined }); }
		// ---- Pasted images of the New session form (never part of the saved draft: the files live on the PC until the todo starts) ----
		let imageEpoch = 0; // a new number whenever the images are cleared: an upload that was on its way then is dropped
		const revokeUrl = (im) => { try { if (im && im.url) window.URL.revokeObjectURL(im.url); } catch (_e) { /* no object URLs here */ } };
		const objectUrl = (file) => { try { return window.URL.createObjectURL(file); } catch (_e) { return undefined; } };
		/** Drops every image of the form (thumbnails, and the uploads still on their way). */
		function clearImages() {
			imageEpoch++;
			(state.todoForm.images || []).forEach(revokeUrl);
			patchForm({ images: undefined, uploading: 0 });
		}
		function removeImage(id) {
			const images = state.todoForm.images || [];
			images.filter((im) => im.id === id).forEach(revokeUrl);
			const rest = images.filter((im) => im.id !== id);
			patchForm({ images: rest.length ? rest : undefined, error: undefined });
		}
		/** One image to the server (POST /v1/todo-image, the raw file); { ok, id } or { ok: false, error }. */
		async function uploadImage(file) {
			try {
				const res = await fetch(API + "/v1/todo-image", { method: "POST", credentials: "same-origin", headers: { "content-type": file.type }, body: file });
				const j = await res.json().catch(() => ({}));
				if (res.ok && j && j.ok && typeof j.id === "string") return { ok: true, id: j.id };
				return { ok: false, error: errorText(res.status, j) };
			} catch (e) { return { ok: false, error: "Request failed: " + String((e && e.message) || e) }; }
		}
		/** Attaches the files to the New session form, one upload after the other; true when every one is attached. */
		async function addImages(files) {
			if (isFollowUpForm(state.todoForm) || state.todoForm.busy) return false;
			let all = true;
			for (const file of files) {
				const f = state.todoForm;
				if ((f.images || []).length + (f.uploading || 0) >= IMAGE_MAX) { patchForm({ error: "At most " + IMAGE_MAX + " images can be attached." }); return false; }
				if (file.size > IMAGE_BYTES) { patchForm({ error: "That image is over 8 MB." }); all = false; continue; }
				const epoch = imageEpoch;
				patchForm({ uploading: (f.uploading || 0) + 1, error: undefined });
				const result = await uploadImage(file);
				if (epoch !== imageEpoch) return false; // the images were cleared meanwhile: the file waits for the weekly clean-up
				const now = state.todoForm;
				if (!result.ok) { patchForm({ uploading: Math.max(0, (now.uploading || 1) - 1), error: result.error }); all = false; continue; }
				patchForm({ uploading: Math.max(0, (now.uploading || 1) - 1), images: (now.images || []).concat([{ id: result.id, name: file.name || "image", url: objectUrl(file) }]) });
			}
			return all;
		}
		/** The paste handler of the task box: image files are attached (and the browser is kept from pasting their name); a paste that also has text pastes the text as usual. */
		function onPasteImages(e) {
			const data = e && e.clipboardData;
			const files = imageFilesOf(data);
			if (!files.length || isFollowUpForm(state.todoForm)) return;
			const hasText = data && data.items ? Array.from(data.items).some((it) => it && it.kind === "string" && it.type === "text/plain") : false;
			if (!hasText && typeof e.preventDefault === "function") e.preventDefault();
			addImages(files);
		}
		/** Adds the todo (POST /v1/todo). A workspace starts it at once; "Choose for me" waits for the confirm card. */
		async function submitTodo() {
			const f = state.todoForm;
			if (f.busy || f.tuning) return false;
			const follow = isFollowUpForm(f);
			if (!follow && f.uploading > 0) { patchForm({ error: "Wait for the image to finish uploading." }); return false; }
			const problem = todoFormProblem(f.text, follow ? f.followUp || "" : undefined);
			if (problem) { patchForm({ error: problem }); return false; }
			// A follow-up add answers only after the server has read the sessions (seconds), so the form closes at once, like a new todo; busy stays set, and a refusal brings the form back with the text.
			patchForm({ busy: true, error: undefined, ...(follow ? { open: false } : {}) });
			const error = await post("/v1/todo", follow ? { text: f.text.trim(), followUp: f.followUp.trim() } : { text: f.text.trim(), ...(f.workspaceId ? { workspaceId: f.workspaceId } : {}), sparc: !!f.sparc, ...(f.effort ? { effort: f.effort } : {}), ...(f.images && f.images.length ? { images: f.images.map((im) => im.id) } : {}) });
			if (error) { patchForm({ busy: false, error, ...(follow ? { open: true } : {}) }); return false; }
			clearImages();
			set({ todoForm: { open: false, text: "", workspaceId: "", sparc: false, effort: "", busy: false, error: undefined } });
			return true;
		}
		/** The tuned text (POST /v1/todo-tune); { ok, text } or { ok: false, error }. */
		async function requestTune(text) {
			try {
				const res = await fetch(API + "/v1/todo-tune", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
				const j = await res.json().catch(() => ({}));
				if (res.ok && j && j.ok && typeof j.text === "string") return { ok: true, text: j.text, questions: j.questions };
				if (j && j.error === "busy") return { ok: false, error: "A tune is already running." }; // the shared "busy" code reads differently for a post to a session (ERRORS)
				if (!res.ok && (res.status !== 409 || (j && j.error === "busy"))) return { ok: false, error: errorText(res.status, j) };
				return { ok: false, error: "Could not tune the prompt: " + ((j && j.error) || "unexpected answer") };
			} catch (e) { return { ok: false, error: "Request failed: " + String((e && e.message) || e) }; }
		}
		/** The Tune prompt button: the model rewrites the text and the result goes in the box (Undo tune brings the typed text back). */
		async function tuneTodo() {
			if (!canTune(state.todoForm)) return false;
			const mine = ++tuneSeq;
			patchForm({ tuning: true, error: undefined, questions: undefined });
			const result = await requestTune(state.todoForm.text);
			if (mine !== tuneSeq) return false; // the form was closed or reopened meanwhile: the late text is not wanted
			set({ todoForm: nextFormAfterTune(state.todoForm, result) });
			return !!result.ok;
		}
		function undoTune() {
			const { original, ...rest } = state.todoForm;
			if (original) set({ todoForm: { ...rest, text: original, error: undefined, questions: undefined } });
		}
		// ---- the tip of the day: Go deeper and Use in my code ----
		const MAX_TIP_PARAGRAPHS = 4; // the server's limit (MAX_PARAGRAPHS in tip-expand.js)
		const tipParagraphs = (list) => (Array.isArray(list) ? list.filter((p) => typeof p === "string" && p).slice(0, MAX_TIP_PARAGRAPHS) : []);
		/** The workspace of the tip pick: the one chosen now, else the last one used for a tip todo, else the first listed; "" while none is listed. */
		function tipWorkspaceId(list) {
			const ws = Array.isArray(list) ? list : [];
			const has = (id) => !!id && ws.some((w) => w && w.id === id);
			if (has(state.tipUse.workspaceId)) return state.tipUse.workspaceId;
			const last = storage.get(LS.tipWorkspace);
			if (has(last)) return last;
			return ws.length && ws[0] ? ws[0].id : "";
		}
		/** Go deeper: the longer text of this tip (one model call on the server, kept with the tip). */
		async function goDeeper(tip) {
			const key = "tip-deeper:" + tip.id;
			if (state.busy[key]) return false;
			set({ busy: { ...state.busy, [key]: true }, errors: { ...state.errors, [key]: undefined } });
			const r = await postJson("/v1/tip-deeper", { id: tip.id });
			const paragraphs = r.ok ? tipParagraphs(r.body.deeper && r.body.deeper.paragraphs) : [];
			const error = r.ok ? (paragraphs.length ? undefined : "The model gave no usable text. Try again.") : r.error;
			set({ busy: { ...state.busy, [key]: false }, errors: { ...state.errors, [key]: error }, ...(error ? {} : { tipDeeper: { [tip.id]: paragraphs } }) });
			return !error;
		}
		/** Use in my code: shows or hides the workspace pick (the list is loaded when it opens). */
		function toggleTipUse() {
			const open = !state.tipUse.open;
			set({ tipUse: { ...state.tipUse, open } });
			return open ? ensureWorkspaces() : undefined;
		}
		/** Draft todo: asks for a todo text for this tip in the picked workspace and puts it in the New todo form. Nothing is sent; text already typed there stays and the draft goes after it. */
		async function draftTipTodo(tip) {
			const key = "tip-todo:" + tip.id;
			const workspaceId = tipWorkspaceId(state.workspaces);
			if (state.busy[key] || !workspaceId || state.todoForm.busy || state.todoForm.tuning) return false;
			set({ busy: { ...state.busy, [key]: true }, errors: { ...state.errors, [key]: undefined } });
			const r = await postJson("/v1/tip-todo", { id: tip.id, workspaceId });
			if (!r.ok && r.code === "busy") r.error = "A todo is already being drafted. Try again in a moment.";
			const draft = r.ok && typeof r.body.text === "string" && r.body.text.trim() ? r.body.text.trim() : undefined;
			const error = draft ? undefined : r.ok ? "The model gave no usable text. Try again." : r.error;
			set({ busy: { ...state.busy, [key]: false }, errors: { ...state.errors, [key]: error } });
			if (!draft) return false;
			storage.set(LS.tipWorkspace, workspaceId);
			const { original, ...f } = state.todoForm;
			const had = !!(f.text && f.text.trim());
			tuneSeq++; // a Tune that began while the draft was written must not put its text over the draft
			set({ tipUse: { open: false, workspaceId }, todoForm: { ...f, tuning: false, open: true, error: undefined, text: had ? f.text.trimEnd() + "\n\n" + draft : draft, workspaceId, sparc: had ? !!f.sparc : false } });
			return true;
		}
		/** Start (or Retry) a todo in the picked workspace, else the suggested or given one. */
		/** The user's answer to one open question of a tune (panel input); blank means no answer. */
		function setTuneAnswer(index, value) {
			const qs = state.todoForm.questions;
			if (!qs || !qs[index]) return;
			patchForm({ questions: qs.map((q, i) => (i === index ? { ...q, answer: String(value == null ? "" : value) } : q)) });
		}
		/** The panel's Add answers: every non-blank answer goes to the end of the prompt as a Decisions list; blank ones stay out (the prompt stays neutral there). */
		function applyTuneAnswers() {
			const f = state.todoForm;
			if (!f.questions) return;
			const lines = f.questions.filter((q) => q.answer.trim()).map((q) => "- " + q.question + " " + q.answer.trim());
			set({ todoForm: { ...f, text: lines.length ? f.text.replace(/\s+$/, "") + "\n\nDecisions:\n" + lines.join("\n") : f.text, questions: undefined, error: undefined } });
		}
		/** The panel's Skip: the questions are dropped and the prompt stays as tuned. */
		function skipTuneQuestions() { if (state.todoForm.questions) patchForm({ questions: undefined }); }
		/** Start (or Retry) a todo in the picked workspace, else the suggested or given one; a follow-up is sent to the picked session, else the suggested one. */
		async function confirmTodo(item, pick) {
			const target = todoTarget(item, pick);
			const ok = await act("/v1/todo-confirm", { id: item.id, ...(target ? { [isFollowUp(item) ? "sessionId" : "workspaceId"]: target } : {}) }, item.id);
			if (ok) set({ todoPick: { ...state.todoPick, [item.id]: undefined } });
			return ok;
		}
		const cancelTodo = (item) => act("/v1/todo-cancel", { id: item.id }, item.id, { advance: true });
		/** Resumes one paused session; { ok } or { ok: false, error: code }. */
		async function resumeOne(item) {
			try {
				const res = await fetch(API + "/v1/paused-resume", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id }) });
				const j = await res.json().catch(() => ({}));
				return res.ok ? { ok: true } : { ok: false, error: (j && j.error) || "HTTP " + res.status };
			} catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
		}
		/**
		 * Is the session of a resumed item still working? 'running' | 'stopped' | 'unknown'. Asks this app (POST /v1/running-sessions: its running top-level
		 * sessions). A session of ANOTHER app (hub: the item's owner is not the app that answered) is never in that list, so it is 'unknown' (settled item or
		 * slot time decide); so is any failure. An item without an owner (standalone, or this app's own item while the hub is away) is this app's:
		 * every item of a hub snapshot has an owner, so an ownerless item cannot belong to another app.
		 */
		async function pollRunning(item) {
			if (item.owner !== undefined && runInstanceId !== undefined && item.owner !== runInstanceId) return "unknown"; // another app's item: not worth a request
			const j = await fetchRunning();
			if (!j) return "unknown";
			runInstanceId = j.instanceId;
			if (item.owner !== undefined && item.owner !== j.instanceId) return "unknown";
			return j.ids.includes(item.sessionId) ? "running" : "stopped";
		}
		let runningCall; // the last POST /v1/running-sessions: { done, doneAt, promise }
		let runInstanceId; // the app that answered the first poll of this Resume all run (reset when a run starts)
		/**
		 * The answer of POST /v1/running-sessions ({ ok: true, ids, instanceId? }) or undefined when it failed. The lanes of Resume all poll on the same
		 * rhythm, so a call that is still in flight, or completed less than half a poll interval ago, is shared (one controller list instead of one per lane);
		 * a lane polls a whole interval apart, so two polls of one lane never come from one answer. A failed answer is not kept.
		 */
		function fetchRunning() {
			const age = runningCall && runningCall.done ? Date.now() - runningCall.doneAt : 0; // a clock that stepped back gives a negative age: expired
			if (runningCall && (!runningCall.done || (age >= 0 && age < RESUME_POLL_MS / 2))) return runningCall.promise;
			const call = { done: false, doneAt: 0, promise: undefined };
			call.promise = (async () => {
				try {
					const res = await fetch(API + "/v1/running-sessions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(RESUME_POLL_TIMEOUT_MS) });
					if (!res.ok) return undefined;
					const j = await res.json().catch(() => ({}));
					return j && j.ok === true && Array.isArray(j.ids) ? j : undefined;
				} catch (_e) { return undefined; }
			})().then((j) => { call.done = true; call.doneAt = Date.now(); if (!j && runningCall === call) runningCall = undefined; return j; });
			runningCall = call;
			return call.promise;
		}
		const pausedOpen = () => (state.snap ? state.snap.open.filter((i) => i.type === "paused") : []);
		const askResumeAll = () => { const n = pausedOpen().length; if (n) set({ resumeAll: { phase: "confirm", total: n } }); };
		const closeResumeAll = () => set({ resumeAll: null });
		let resumeAbort;
		/** After the user confirmed: resumes every paused session, a few at a time; each place is held until its session reports back. */
		async function startResumeAll() {
			const items = pausedOpen();
			if (!items.length) { set({ resumeAll: null }); return; }
			resumeAbort = new AbortController();
			runInstanceId = undefined;
			const since = {};
			set({ resumeAll: { phase: "running", total: items.length, progress: { total: items.length, started: 0, ok: 0, failed: 0, running: 0, waiting: items.length } } });
			const result = await runResumeAll({
				items, signal: resumeAbort.signal,
				resume: (item) => { since[item.id] = Date.now() + state.skew; return resumeOne(item); },
				poll: pollRunning,
				settled: (item, stop) => new Promise((resolve) => {
					const check = () => { if (settledAfter(state.snap, item, since[item.id])) { off(); resolve(); } };
					const off = subscribe(check);
					if (stop) stop.addEventListener("abort", off, { once: true }); // the place was freed another way: stop watching the snapshot
					check();
				}),
				onProgress: (progress) => { if (state.resumeAll && state.resumeAll.phase === "running") set({ resumeAll: { ...state.resumeAll, progress } }); },
			});
			set({ resumeAll: { phase: "done", total: items.length, result } });
		}
		const stopResumeAll = () => { if (resumeAbort) resumeAbort.abort(); };
		/** Looks for sessions a restart cut off, now. */
		async function scanPaused() {
			set({ scanning: true, scanNote: undefined });
			try {
				const res = await fetch(API + "/v1/paused-scan", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
				const j = await res.json().catch(() => ({}));
				set({ scanning: false, scanNote: res.ok ? (j.added ? "Found " + j.added + " paused session" + (j.added === 1 ? "" : "s") + "." : "No new paused sessions.") : errorText(res.status, j) });
			} catch (e) { set({ scanning: false, scanNote: "Request failed: " + String((e && e.message) || e) }); }
		}
		function setOverlay(on) { if (!on) stopReading(); storage.set(LS.overlay, on ? "1" : "0"); set({ overlay: on }); if (pollCtl) pollCtl.abort(); }

		// =====================================================================================
		// Styles
		// =====================================================================================

		const CSS = ".rq{--rq-fg:var(--dsw-alias-label-primary,#f9fafb);--rq-mute:var(--dsw-alias-label-tertiary,#adb2b8);--rq-border:var(--dsw-alias-border-l2,#ffffff26);--rq-hover:var(--dsw-alias-interactive-bg-hover,#ffffff14);--rq-layer:var(--dsw-alias-bg-layer-1,#232324);--rq-layer2:var(--dsw-alias-bg-layer-2,#2c2c2e);--rq-base:var(--dsw-alias-bg-base,#151517);--rq-accent:var(--dsw-alias-link,#7aaaff);--rq-err:var(--dsw-alias-state-error-primary,#f25a5a);--rq-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--rq-ok:var(--dsw-alias-state-success-primary,#22c55e);color:var(--rq-fg);font-size:13px;line-height:1.45;box-sizing:border-box}"
			+ ".rq *{box-sizing:border-box}:where(.rq) button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0}:where(.rq) button:disabled{opacity:.5;cursor:default}"
			+ ".rq-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--rq-border)}"
			+ ".rq-head h2{margin:0;font-size:14px;font-weight:600}.rq-count{background:var(--rq-layer2);border-radius:9px;padding:1px 8px;font-size:11px;color:var(--rq-mute)}"
			+ ".rq-grow{flex:1}.rq-link{color:var(--rq-mute);padding:4px 8px;border-radius:6px}.rq-link:hover{background:var(--rq-hover);color:var(--rq-fg)}.rq-row>.rq-link:first-child{margin-left:-8px}"
			+ ".rq-body{flex:1;min-height:0;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px}.rq-banner{padding:8px 14px;background:#f25a5a22;color:var(--rq-err);font-size:12px}.rq-notice{padding:6px 14px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#8883}.rq-notice-warn{background:#f2b5301f;color:var(--rq-fg)}"
			+ ".rq-empty{margin:auto;text-align:center;color:var(--rq-mute);padding:32px 24px}"
			+ ".rq-card{border:1px solid var(--rq-border);border-radius:9px;background:var(--rq-layer);padding:12px 14px;display:flex;flex-direction:column;gap:10px}.rq-card.sel{border-color:var(--rq-accent)}"
			+ ".rq-card-h{display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0}.rq-chip{flex:none;padding:1px 8px;border-radius:9px;font-size:11px;font-weight:600;background:var(--rq-layer2)}"
			+ ".rq-chip.question{color:var(--rq-accent)}.rq-chip.permission{color:var(--rq-warn)}.rq-chip.completed{color:var(--rq-ok)}.rq-chip.pr-merged{color:var(--rq-ok)}.rq-chip.todo{color:var(--rq-accent)}.rq-chip.paused{color:var(--rq-warn)}.rq-chip.onhold{color:var(--rq-mute)}.rq-pos{flex:none;color:var(--rq-mute);font-size:12px}"
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
			+ ".rq-action{font-weight:700;font-size:1.15em;line-height:1.3;text-decoration:none}.rq-md{font-size:13.5px;line-height:1.5}.rq-md p{margin:0 0 8px;white-space:pre-wrap;word-break:break-word}.rq-md ul,.rq-md ol{margin:0 0 8px;padding-left:22px}.rq-md blockquote{margin:0 0 8px;padding:2px 10px;border-left:3px solid var(--rq-border);color:var(--rq-mute)}"
			+ ".rq-md pre.rq-pre{margin:0 0 8px}.rq-code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;background:var(--rq-layer2);border-radius:4px;padding:0 4px}.rq-md a{color:var(--rq-accent)}.rq-h{font-weight:600;margin:6px 0 4px}.rq-h1{font-size:16px}.rq-h2{font-size:14.5px}"
			+ ".rq-replybox{max-height:360px;overflow:auto;background:var(--rq-base);border:1px solid var(--rq-border);border-radius:7px;padding:10px 12px;margin-top:6px}"
			+ ".rq-todoform{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 14px;border-bottom:1px solid var(--rq-border);background:var(--rq-layer)}.rq-sel{width:auto;max-width:260px;padding:6px 8px}.rq-thumbs{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.rq-tunequestions{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:1px solid var(--rq-border,rgba(127,127,127,.35));border-radius:8px}.rq-tq{display:flex;flex-direction:column;gap:3px;font-size:13px}.rq-thumb{position:relative;display:inline-flex}.rq-thumb img{height:56px;max-width:120px;object-fit:cover;border-radius:6px;border:1px solid var(--rq-border)}.rq-thumb-x{position:absolute;top:-7px;right:-7px;width:18px;height:18px;padding:0;border-radius:50%;border:1px solid var(--rq-border);background:var(--rq-layer);color:inherit;cursor:pointer;line-height:1;font-size:11px}"
			+ ".rq-risks{display:flex;flex-wrap:wrap;gap:6px}.rq-risk{background:#f25a5a22;color:var(--rq-err);border-radius:9px;padding:2px 10px;font-size:12px;font-weight:600}.rq-risk-dot{color:var(--rq-err);font-weight:700}"
			+ ".rq-filter{flex:none;display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid var(--rq-border);flex-wrap:wrap}.rq-fchip{padding:3px 12px;border-radius:9px;border:1px solid var(--rq-border)!important;font-size:12px;color:var(--rq-mute)}"
			+ ".rq-fchip.on{background:var(--rq-layer2)!important;color:var(--rq-fg);border-color:var(--rq-accent)!important}.rq-fsearch{flex:1;min-width:160px;width:auto;padding:4px 10px}.rq-hint{flex:none;padding:6px 14px;border-top:1px solid var(--rq-border);color:var(--rq-mute);font-size:11.5px}"
			+ ".rq-sess{font-variant-numeric:tabular-nums;white-space:nowrap}.rq-emptywrap{margin:auto;display:flex;flex-direction:column;gap:16px;align-items:stretch;max-width:100%}.rq-emptywrap .rq-empty{margin:0;padding:8px}"
			+ ".rq-tip{display:flex;flex-direction:column;gap:6px;text-align:left;width:100%;border:1px solid var(--rq-border)!important;border-radius:10px;padding:10px 12px;background:var(--rq-layer)}.rq-tip:hover{background:var(--rq-hover)}.rq-tip.on{border-color:var(--rq-accent)!important}"
			+ ".rq-tipwrap{max-width:680px;margin:8vh auto 0}.rq-tip-t{font-weight:600;font-size:17px}.rq-tip-b{font-size:16px;line-height:1.5;display:flex;flex-direction:column;gap:10px}.rq-tip-p{display:block}.rq-tip-f{color:var(--rq-mute);font-size:13px}"
			+ ".rq-tip-dw{display:flex;flex-direction:column;gap:10px;margin-top:10px;padding:0 4px}.rq-tip-d{margin:0;font-size:16px;line-height:1.5}.rq-btn.on{border-color:var(--rq-accent)!important}.rq-tip-actions{margin-top:10px}.rq-tip-use{margin-top:8px}"
			+ ".rq-modal-back{position:fixed;inset:0;z-index:9990;background:#0009;display:flex;align-items:center;justify-content:center;padding:24px}.rq-modal{width:min(640px,100%);max-height:100%;border:1px solid var(--rq-border);border-radius:12px;background:var(--rq-base);overflow:hidden;display:flex;flex-direction:column;box-shadow:0 12px 40px #000a}.rq-ov-back{position:fixed;inset:0;z-index:9980;background:#0009;padding:24px;display:flex}.rq-ov{flex:1;min-width:0;border:1px solid var(--rq-border);border-radius:12px;background:var(--rq-base);overflow:hidden;display:flex;flex-direction:column}"
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

		/** Send a question card's answers (the Send answer button and Enter in a box); a draft is forgotten once they are sent. One send at a time per card. */
		async function sendAnswers(item, path, answers) {
			if (state.busy[item.id]) return false;
			if (!(await act(path, { id: item.id, answers }, item.id, { advance: path === "/v1/answer" }))) return false;
			set({ drafts: { ...state.drafts, [item.id]: undefined } });
			return true;
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
					h("div", { className: "rq-text rq-clamp" }, q ? actionNodes(q.question) : ""),
					q && q.options && q.options.length ? h("div", { className: "rq-chips" }, q.options.slice(0, 4).map((o) => h("span", { key: o.label, className: "rq-pill" }, recommended(q, o.label) ? "★ " + o.label : o.label)), q.options.length > 4 ? h("span", { className: "rq-sub" }, "+" + (q.options.length - 4)) : null) : null,
					questions.length > 1 ? h("div", { className: "rq-sub" }, questions.length + " questions") : null);
			}
			const answers = buildAnswers(questions, drafts);
			const note = path === "/v1/answer" ? detachedNote(item) : undefined;
			return h(React.Fragment, null,
				note ? h("div", { className: "rq-sub" }, note) : null,
				questions.map((q) => {
					const d = drafts[q.id] || { selected: [], custom: "" };
					return h("div", { key: q.id, className: "rq-opts" },
						q.header ? h("div", { className: "rq-sub" }, actionNodes(q.header)) : null,
						h("div", { className: "rq-text", style: { fontWeight: 600 } }, actionNodes(q.question)),
						(q.options || []).map((o) => h("button", {
							key: o.label, className: "rq-opt" + (d.selected.includes(o.label) ? " on" : ""), disabled: busy,
							onClick: () => setDraft(q.id, toggleChoice(d, o.label, !!q.multiSelect)), "aria-pressed": d.selected.includes(o.label),
						}, h("span", null, d.selected.includes(o.label) ? (q.multiSelect ? "☑" : "◉") : (q.multiSelect ? "☐" : "○")),
							h("span", null, h("span", null, recommended(q, o.label) ? h("span", { className: "rq-star" }, "★ ") : null, o.label), o.description ? h("div", { className: "d" }, actionNodes(o.description)) : null))),
						h("input", { className: "rq-input", placeholder: "Other answer…", value: d.custom || "", disabled: busy, onChange: (e) => setDraft(q.id, { selected: q.multiSelect ? d.selected : [], custom: e.target.value }), onKeyDown: (e) => { const sendNow = enterAnswers(e.nativeEvent || e, questions, drafts, q.id); if (sendNow && !busy) { e.preventDefault(); sendAnswers(item, path, sendNow); } } }));
				}),
				h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: !answers || busy, onClick: () => sendAnswers(item, path, answers) }, busy ? "Sending…" : sendLabel),
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
				full && p.reason ? h("div", { className: "rq-sub" }, actionNodes(p.reason)) : null,
				h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: busy, onClick: () => act("/v1/approve", { id: item.id }, item.id, { advance: true }) }, "Approve"),
					h("button", { className: "rq-btn bad", disabled: busy, onClick: () => act("/v1/deny", { id: item.id }, item.id, { advance: true }) }, "Deny"),
					same > 1 ? h("button", { className: "rq-btn", disabled: busy, title: "Approve this request and the identical ones from the same session", onClick: () => act("/v1/approve-similar", { id: item.id }, item.id, { advance: true }) }, "Approve all " + same + " identical") : null));
		}

		/** Markdown as React elements (no HTML injection: text goes through React, links are http(s) only). */
		function mdNodes(s) {
			return mdInline(s).map((tok, i) => {
				switch (tok.t) {
					case "b": return h("strong", { key: i }, tok.text);
					case "bu": return h("strong", { key: i, className: "rq-action" }, tok.text);
					case "i": return h("em", { key: i }, tok.text);
					case "code": return h("code", { key: i, className: "rq-code" }, tok.text);
					case "a": return h("a", { key: i, href: tok.href, target: "_blank", rel: "noopener noreferrer" }, tok.text);
					default: return tok.text;
				}
			});
		}

		/** A plain text with its action items as emphasis (nothing else is read as markdown): question, option and reason text. */
		function actionNodes(s) {
			return actionTokens(s).map((tok, i) => (tok.t === "bu" ? h("strong", { key: i, className: "rq-action" }, tok.text) : tok.text));
		}

		function Md({ text }) {
			const inline = mdNodes;
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
				h("div", { className: "rq-text" + (full ? "" : " rq-clamp"), style: { whiteSpace: "pre-line" } }, item.summary ? mdNodes(item.summary) : "Finished."), // pre-line: the action items sit in a paragraph of their own
				full ? h(React.Fragment, null,
					item.payload && item.payload.reply ? h("details", { open: detailsOpen(st.replyOpen, item), onToggle: (e) => { const now = !!e.currentTarget.open; if (now !== detailsOpen(state.replyOpen, item)) set({ replyOpen: { ...state.replyOpen, [item.id]: now } }); } }, h("summary", { className: "rq-sub", style: { cursor: "pointer" } }, "Full reply"), h("div", { className: "rq-replybox" }, h(Md, { text: item.payload.reply }))) : null,
					h("textarea", { className: "rq-ta", placeholder: "Reply to this session… (Enter sends, Shift+Enter for a new line)", value: reply, disabled: busy, onChange: (e) => set({ replies: { ...st.replies, [item.id]: e.target.value } }), onKeyDown: (e) => { if (isSendKey(e.nativeEvent || e)) { e.preventDefault(); if (reply.trim() && !busy) send(); } } })) : null,
				h("div", { className: "rq-row" },
					full ? h("button", { className: "rq-btn pri", disabled: busy || !reply.trim(), onClick: send }, "Send reply") : null,
					h("button", { className: "rq-btn", disabled: busy, onClick: () => act("/v1/reviewed", { id: item.id }, item.id, { advance: true }) }, "Reviewed"),
					full ? h(HoldButton, { item }) : null),
				full ? h(HoldForm, { item }) : null);
		}

		/** A merged pull request: archive the session that worked on it (the follow-up sessions were already told to start). */
		function PrMergedBody({ item }) {
			const st = useStore();
			const busy = st.busy[item.id];
			const p = item.payload || {};
			const followUps = p.followUps || [];
			return h(React.Fragment, null,
				h("div", { className: "rq-text" }, "Pull request " + p.prId + " is merged."),
				followUps.length
					? h("div", { className: "rq-sub" }, (followUps.length === 1 ? "Follow-up session told to start: " : "Follow-up sessions told to start: ") + followUps.map((f) => f.title || f.id).join(", "))
					: h("div", { className: "rq-sub" }, "No follow-up session was waiting for this PR."),
				h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: busy, title: "Archive this session (stops anything it is still running)", onClick: () => act("/v1/archive", { id: item.id }, item.id, { advance: true }) }, busy ? "Archiving…" : "Archive session"),
					h("button", { className: "rq-btn", disabled: busy, title: "Keep the session and clear this item", onClick: () => act("/v1/reviewed", { id: item.id }, item.id, { advance: true }) }, "Keep session")));
		}

		/** A todo: confirm where it starts (nothing is created before), watch it start, retry a failure. The session is never opened by itself; Open session is a button. */
		function TodoBody({ item, full }) {
			const st = useStore();
			const busy = st.busy[item.id];
			const s = todoCardState(item);
			const pick = st.todoPick[item.id] || "";
			const sel = todoSelect(item, pick, st.workspaces);
			const waiting = s === "confirm" || s === "pick" || s === "suggesting" || s === "failed";
			useEffect(() => { if (waiting) ensureWorkspaces(); }, [waiting]);
			return h(React.Fragment, null,
				h("div", { className: "rq-text" + (full ? "" : " rq-clamp") }, item.text),
				item.sparc ? h("div", { className: "rq-sub" }, "Use SPARC") : null,
				item.effort ? h("div", { className: "rq-sub" }, "Effort: " + effortName(st.efforts, item.effort)) : null,
				h("div", { className: s === "failed" ? "rq-err" : "rq-sub" }, todoLine(item, pick, st.workspaces)),
				waiting ? h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: busy || !canConfirm(item, pick), onClick: () => confirmTodo(item, pick) }, s === "failed" ? "Retry" : "Start"),
					h("select", { className: "rq-input rq-sel", value: sel.value, disabled: busy, "aria-label": "Change workspace", onChange: (e) => set({ todoPick: { ...state.todoPick, [item.id]: e.target.value } }) },
						sel.placeholder ? h("option", { value: "" }, sel.placeholder) : null, sel.options.map((w) => h("option", { key: w.id, value: w.id }, w.title))),
					h("button", { className: "rq-btn", disabled: busy, onClick: () => cancelTodo(item) }, "Cancel")) : null,
				(s === "starting" || s === "started") && item.sessionId && hostApi.openSession ? h("div", { className: "rq-row" }, h("button", { className: "rq-btn", onClick: () => openSession(item) }, "Open session")) : null);
		}

		/** A follow-up: confirm the session the text goes to (nothing is sent before), watch it go, retry a failure. Never asks for workspaces; no key is bound. */
		function FollowUpBody({ item, full }) {
			const st = useStore();
			const busy = st.busy[item.id];
			const s = todoCardState(item);
			const pick = st.todoPick[item.id] || "";
			const sel = todoSelect(item, pick);
			const waiting = s === "confirm" || s === "pick" || s === "suggesting" || s === "failed";
			return h(React.Fragment, null,
				h("div", { className: "rq-text" + (full ? "" : " rq-clamp") }, item.text),
				h("div", { className: s === "failed" ? "rq-err" : "rq-sub" }, todoLine(item, pick)),
				waiting ? h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: busy || !canConfirm(item, pick), onClick: () => confirmTodo(item, pick) }, s === "failed" ? "Retry" : "Send"),
					h("select", { className: "rq-input rq-sel", value: sel.value, disabled: busy, "aria-label": "Change session", onChange: (e) => set({ todoPick: { ...state.todoPick, [item.id]: e.target.value } }) },
						sel.placeholder ? h("option", { value: "" }, sel.placeholder) : null, sel.options.map((o) => h("option", { key: o.id, value: o.id }, o.title))),
					h("button", { className: "rq-btn", disabled: busy, onClick: () => cancelTodo(item) }, "Cancel")) : null);
		}

		/** A session a restart cut off: why it is listed, then Resume (prompts the session itself) or Dismiss (it stays dismissed). */
		function PausedBody({ item, full }) {
			const st = useStore();
			const busy = st.busy[item.id];
			const facts = pausedFacts(item, useNow(false));
			return h(React.Fragment, null,
				h("div", { className: "rq-text" }, facts[0]),
				(full ? facts.slice(1) : facts.slice(1, 2)).map((f, n) => h("div", { key: n, className: "rq-sub" }, f)),
				h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: busy, title: "Prompt the session to check its worktree and continue where it stopped", onClick: () => act("/v1/paused-resume", { id: item.id }, item.id, { advance: true }) }, busy ? "Resuming…" : "Resume"),
					h("button", { className: "rq-btn", disabled: busy, title: "Do not resume it; it stays out of the list", onClick: () => act("/v1/paused-dismiss", { id: item.id }, item.id, { advance: true }) }, "Dismiss"),
					h(HoldButton, { item })),
				h(HoldForm, { item }));
		}

		function Card({ item, forceFull, selected, onSelect }) {
			const st = useStore();
			const now = useNow(item.type === "question" && !!item.expiresAt);
			const full = forceFull || !!st.expanded[item.id];
			const left = item.expiresAt ? item.expiresAt - now : undefined;
			const Body = item.type === "question" ? QuestionBody : item.type === "permission" ? PermissionBody : item.type === "pr-merged" ? PrMergedBody : item.type === "todo" ? (isFollowUp(item) ? FollowUpBody : TodoBody) : item.type === "paused" ? PausedBody : item.type === "onhold" ? OnHoldBody : CompletedBody;
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
					hostApi.openSession && item.type !== "todo" ? h("button", { className: "rq-link", onClick: () => openSession(item) }, "Open session ↗") : null));
		}

		/** The Hold button of a Done or Paused card: it opens the reason line (HoldForm) under the row. */
		function HoldButton({ item }) {
			const st = useStore();
			return h("button", { className: "rq-btn", disabled: st.busy[item.id] || st.holdOpen[item.id] !== undefined, title: "Park this session in the On hold queue; with an Azure DevOps ticket it is watched and continued when the ticket changes", onClick: () => set({ holdOpen: { ...state.holdOpen, [item.id]: "" } }) }, "Hold…");
		}
		/** The reason line and the confirm of a hold (the reason is optional; a ticket in the session title is found by the plugin). */
		function HoldForm({ item }) {
			const st = useStore();
			const draft = st.holdOpen[item.id];
			if (draft === undefined) return null;
			const busy = st.busy[item.id];
			const close = () => { const m = { ...state.holdOpen }; delete m[item.id]; set({ holdOpen: m }); };
			const send = async () => { if (await act("/v1/hold", { id: item.id, reason: draft }, item.id, { advance: true })) close(); };
			return h("div", { className: "rq-row" },
				h("input", { className: "rq-input rq-fsearch", placeholder: "Why? (optional, e.g. waiting for the customer)", value: draft, disabled: busy, maxLength: 300, autoFocus: true, onChange: (e) => set({ holdOpen: { ...state.holdOpen, [item.id]: e.target.value } }), onKeyDown: (e) => { const ne = e.nativeEvent || e; if (isSendKey(ne)) { e.preventDefault(); if (!busy) send(); } else if (e.key === "Escape") { e.stopPropagation(); close(); } } }),
				h("button", { className: "rq-btn pri", disabled: busy, onClick: send }, busy ? "Holding…" : "Put on hold"),
				h("button", { className: "rq-btn", disabled: busy, onClick: close }, "Cancel"));
		}

		/** A session on hold: why, the ticket being watched, when it was last checked; Continue prompts the session now, Release just takes it off hold. */
		function OnHoldBody({ item, full }) {
			const st = useStore();
			const busy = st.busy[item.id];
			const facts = heldFacts(item, useNow(false));
			return h(React.Fragment, null,
				h("div", { className: "rq-text" }, facts[0]),
				(full ? facts.slice(1) : facts.slice(1, 3)).map((x, n) => h("div", { key: n, className: "rq-sub" }, x)),
				h("div", { className: "rq-row" },
					h("button", { className: "rq-btn pri", disabled: busy, title: "Prompt the session to continue now", onClick: () => act("/v1/hold-continue", { id: item.id }, item.id, { advance: true }) }, busy ? "Continuing…" : "Continue"),
					h("button", { className: "rq-btn", disabled: busy, title: "Take it off hold without prompting the session", onClick: () => act("/v1/hold-release", { id: item.id }, item.id, { advance: true }) }, "Release")));
		}

		/** A resolved card can jump to its session when the host can open sessions and the item knows one (also after session-ended: the host may still refuse). */
		function resolvedOpenAction(it, hostHasOpen) { return hostHasOpen && it && typeof it.sessionId === "string" && it.sessionId ? "open" : "none"; }
		/** True when a click landed on (or inside) a button, link or form control: those keep their own action. */
		function isButtonClick(target) { return !!(target && typeof target.closest === "function" && target.closest("button, a, input, textarea, select, summary")); }

		function ResolvedCard({ it }) {
			const st = useStore();
			const canOpen = resolvedOpenAction(it, !!hostApi.openSession) === "open";
			const asButton = openControl(it, !!hostApi.openSession) === "button";
			const late = it.type === "question" && it.resolution && it.resolution.kind === "expired";
			const open = !!st.lateOpen[it.id];
			const reopenable = isReopenable(it);
			// A todo that started ends up here with no other trace of its text: it can be read aloud like an open card (the service reads any item by id).
			const reading = !!(st.snap && st.snap.reading === it.id);
			return h("div", { className: "rq-card rq-res" },
				h("div", { className: "rq-card-h", title: canOpen ? "Open session" : undefined, style: { cursor: canOpen ? "pointer" : "default" }, onClick: canOpen ? (e) => { if (!isButtonClick(e && e.target)) openSession(it); } : undefined }, h("span", { className: "rq-chip " + it.type }, typeLabel(it.type)), h("span", { className: "rq-title", title: canOpen ? "Open session" + (it.sessionTitle ? ": " + it.sessionTitle : "") : it.sessionTitle }, cardTitle(it)), h("span", { className: "rq-meta" }, fmtAge(Date.now() + state.skew - (it.resolvedAt || 0)))),
				h("div", { className: "rq-sub", title: it.resolution && it.resolution.kind === "no-action" ? plainAction(it.summary) : undefined }, resolutionText(it)),
				canOpen ? h("div", { className: "rq-row" }, h("button", { className: asButton ? "rq-btn pri" : "rq-link", onClick: () => openSession(it) }, asButton ? "Open session" : "Open session ↗")) : null,
				reopenable ? h("div", { className: "rq-row" }, h("button", { className: "rq-btn", disabled: st.busy[it.id], onClick: () => act("/v1/reopen", { id: it.id }, it.id) }, "Reopen")) : null,
				it.type === "todo" ? h("div", { className: "rq-row" }, h("button", { className: "rq-btn rq-play", disabled: st.busy[it.id], title: reading ? "Stop reading" : "Read the whole todo aloud", "aria-pressed": reading, onClick: () => (reading ? act("/v1/stop", {}, it.id) : act("/v1/read", { id: it.id }, it.id)) }, reading ? "■ Stop reading" : "▶ Read aloud")) : null,
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
			if (!filterBarVisible(snap, f)) return null;
			return h("div", { className: "rq-filter" },
				FILTER_TYPES.map((t) => h("button", { key: t, className: "rq-fchip" + (f.type === t ? " on" : ""), "aria-pressed": f.type === t, onClick: () => set({ filter: { ...f, type: t } }) }, t === "all" ? "All" : typeLabel(t))),
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

		/** The "+ New todo" form: New session (the task, the workspace - "Choose for me" asks before anything starts - and Use SPARC) or Follow up (the text and which existing session, in words). */
		function TodoForm() {
			const st = useStore();
			const f = st.todoForm;
			if (!f.open) return null;
			const follow = isFollowUpForm(f);
			const note = follow ? undefined : workspacesNote(st.workspaces);
			const submitOnKey = (e) => { if (isSubmitKey(e.nativeEvent || e)) { e.preventDefault(); submitTodo(); } };
			return h("div", { className: "rq-todoform" },
				h("div", { className: "rq-row", role: "group", "aria-label": "Kind of todo" },
					[["new", "New session"], ["followup", "Follow up"]].map(([mode, label]) => h("button", { key: mode, className: "rq-fchip" + (follow === (mode === "followup") ? " on" : ""), "aria-pressed": follow === (mode === "followup"), disabled: f.busy || f.tuning, onClick: () => setTodoMode(mode) }, label))),
				h("textarea", { className: "rq-ta", autoFocus: true, placeholder: follow ? "What should the existing session do next? (Ctrl+Enter adds it)" : "What should the new session do? (Ctrl+Enter adds it)", value: f.text, disabled: f.busy || f.tuning, onChange: (e) => patchForm({ text: e.target.value, error: undefined }), onKeyDown: submitOnKey, onPaste: onPasteImages }),
				!follow && ((f.images && f.images.length) || f.uploading > 0) ? h("div", { className: "rq-thumbs" },
					(f.images || []).map((im) => h("span", { key: im.id, className: "rq-thumb" },
						im.url ? h("img", { src: im.url, alt: im.name || "Pasted image", title: im.name || "" }) : h("span", { className: "rq-sub" }, im.name || "image"),
						h("button", { className: "rq-thumb-x", type: "button", title: "Remove this image", "aria-label": "Remove image " + (im.name || ""), disabled: f.busy, onClick: () => removeImage(im.id) }, "✕"))),
					f.uploading > 0 ? h("span", { className: "rq-sub" }, "Uploading…") : null) : null,
				follow ? h("select", { className: "rq-input rq-sel", required: true, "aria-label": "Which session", value: f.followUp || "", disabled: f.busy, onChange: (e) => patchForm({ followUp: e.target.value, error: undefined }), onKeyDown: submitOnKey },
					h("option", { value: "" }, followPlaceholder(st.followSessions, st.followSessionsError)),
					(st.followSessions || []).map((c) => h("option", { key: c.sessionId, value: c.sessionId }, followLabel(c)))) : null,
				h("div", { className: "rq-row" },
					follow ? null : h("select", { className: "rq-input rq-sel", value: f.workspaceId, disabled: f.busy, "aria-label": "Workspace", onChange: (e) => patchForm({ workspaceId: e.target.value }) }, h("option", { value: "" }, "Choose for me"), (st.workspaces || []).map((w) => h("option", { key: w.id, value: w.id }, w.title))),
					follow ? null : h("label", { className: "rq-sub" }, h("input", { type: "checkbox", checked: !!f.sparc, disabled: f.busy, onChange: (e) => patchForm({ sparc: e.target.checked }) }), " Use SPARC"),
					follow || !effortChoices(st.efforts).length ? null : h("select", { className: "rq-input rq-sel", value: f.effort || "", disabled: f.busy, "aria-label": "Effort", title: "Only this session uses it; the default effort stays as it is", onChange: (e) => patchForm({ effort: e.target.value }) },
						h("option", { value: "" }, defaultEffortLabel(st.efforts)),
						effortChoices(st.efforts).map((x) => h("option", { key: x.id, value: x.id }, x.name || x.id))),
					h("span", { className: "rq-grow" }),
					h("button", { className: "rq-btn", title: "Rewrite the prompt with the prompt-tune rules and put the result in the box", disabled: !canTune(f), onClick: tuneTodo }, f.tuning ? "Tuning…" : "Tune prompt"),
					f.original ? h("button", { className: "rq-link", title: "Put back the text you typed before tuning", disabled: f.busy || f.tuning, onClick: undoTune }, "Undo tune") : null,
					h("button", { className: "rq-btn pri", disabled: f.busy || f.tuning || !f.text.trim() || (!follow && f.uploading > 0), onClick: submitTodo }, f.busy ? "Adding…" : follow ? "Add follow-up" : "Add todo"),
					h("button", { className: "rq-link", disabled: f.busy, onClick: closeTodoForm }, "Cancel")),
				f.questions && f.questions.length ? h("div", { className: "rq-tunequestions", role: "group", "aria-label": "Questions about the prompt" },
					h("div", { className: "rq-sub" }, "The tuned prompt has open choices. Answer what you want to decide (a blank answer leaves it out):"),
					f.questions.map((q, i) => h("label", { key: i, className: "rq-tq" },
						h("span", null, q.question),
						h("input", { className: "rq-input", type: "text", value: q.answer, maxLength: 300, placeholder: q.default ? "Suggested: " + q.default : "Your answer", "aria-label": q.question, disabled: f.busy, onChange: (e) => setTuneAnswer(i, e.target.value) }))),
					h("div", { className: "rq-row" },
						h("button", { className: "rq-btn", disabled: f.busy, onClick: applyTuneAnswers }, "Add answers to the prompt"),
						h("button", { className: "rq-link", disabled: f.busy, onClick: skipTuneQuestions }, "Skip"))) : null,
				note ? h("div", { className: "rq-sub" }, note) : null,
				f.error ? h("div", { className: "rq-err" }, f.error) : null,
				h("div", { className: "rq-sub" }, follow ? "Nothing is sent until you confirm the session." : (f.workspaceId ? "Starts in the background right away." : "Nothing starts until you confirm the workspace.") + " Paste an image (Ctrl+V) to attach it to the session."));
		}

		function Head({ snap, extra }) {
			const st = useStore();
			const n = snap ? waitingCount(snap.open) : 0;
			const paused = snap ? pausedCount(snap.open) : 0;
			const held = snap ? heldCount(snap.open) : 0;
			const sessions = sessionsText(snap && snap.sessions);
			return h("div", { className: "rq-head" }, h("h2", null, "Coding Boss Review Queue"), h("span", { className: "rq-count" }, n),
				sessions ? h("span", { className: "rq-count rq-sess", title: sessionsTitle }, sessions) : null,
				paused ? h("span", { className: "rq-count", title: "Sessions a restart cut off" }, "⏸ " + paused + " paused") : null,
				h("span", { className: "rq-grow" }),
				h("button", { className: "rq-btn pri", title: "Start a new session and follow it from this list", onClick: openTodoForm }, "+ New todo"),
				paused ? h("button", { className: "rq-btn pri", title: "Resume every paused session, " + RESUME_AT_A_TIME + " at a time", disabled: !!st.resumeAll, onClick: askResumeAll }, "Resume all (" + paused + ")") : null,
				h("button", { className: "rq-btn", title: "Look for sessions a restart cut off", disabled: st.scanning, onClick: scanPaused }, st.scanning ? "Looking…" : "Find paused"),
				held || st.showHeld ? h("button", { className: "rq-btn", title: "Sessions parked until they can continue; a held session with a ticket is checked " + HELD_CHECK_TEXT, "aria-pressed": st.showHeld, onClick: () => set({ showHeld: !st.showHeld, showResolved: false, showPhone: false, selected: null }) }, st.showHeld ? "Waiting" : "On hold (" + held + ")") : null,
				h("button", { className: "rq-btn", onClick: () => set({ showResolved: !st.showResolved, showHeld: false, showPhone: false, selected: null }) }, st.showResolved ? "Waiting" : "Resolved (" + (snap ? snap.resolved.length : 0) + ")"),
				h("button", { className: "rq-btn", title: "Pair a phone and manage the paired phones (opens a window)", "aria-haspopup": "dialog", onClick: () => set({ showPhone: !st.showPhone }) }, "Phone"),
				extra);
		}

		// The phone panel (pairing code, paired phones, revoke) is lib/phone-panel.js. This file has to stay one self-contained script, so the panel is
		// imported from the app's own route on first use and given React.
		let phoneImporter = (url) => import(url);
		let phonePanel;
		function loadPhonePanel() {
			phonePanel = phonePanel || phoneImporter(API + "/m/phone-panel.js").then((m) => m.createPhonePanel(React, { API, fmtAge }), (e) => { phonePanel = undefined; throw e; });
			return phonePanel;
		}
		function PhoneHost() {
			const [Loaded, setLoaded] = useState(null);
			const [failed, setFailed] = useState(null);
			useEffect(() => { loadPhonePanel().then((C) => setLoaded(() => C), (e) => setFailed(String((e && e.message) || e))); }, []);
			if (Loaded) return h(Loaded);
			return h("div", { className: failed ? "rq-err" : "rq-sub", style: { padding: "12px 20px" } }, failed ? "The phone panel could not be loaded (" + failed + "). Restart DSH if the plugin was just updated." : "Loading…");
		}

		/** The Phone window: a dialog over the task list (the list stays under it), closed by its Close button, Esc or a click outside it. */
		function PhoneDialog() {
			return h("div", { className: "rq-modal-back", "data-rq": "phone-dialog", onMouseDown: (e) => { if (e.target === e.currentTarget) set({ showPhone: false }); } },
				h("div", { className: "rq-modal", role: "dialog", "aria-modal": "true", "aria-label": "Phone" },
					h("div", { className: "rq-head" }, h("h2", null, "Phone"), h("span", { className: "rq-grow" }), h("button", { className: "rq-btn", title: "Close (Esc)", onClick: () => set({ showPhone: false }) }, "✕ Close")),
					h("div", { className: "rq-body" }, h(PhoneHost))));
		}

		/** The hub's one-line notice (phone sync off, hub unreachable); nothing when the snapshot carries none. */
		function noticeBanner(snap) {
			const n = snap && snap.notice;
			const words = n && typeof n.text === "string" ? n.text.slice(0, 200) : "";
			return words ? h("div", { className: "rq-notice rq-notice-" + (n.level === "warn" ? "warn" : "info"), role: "status" }, words) : null;
		}

		/** The Resume all bar: the confirmation with the count, the progress while it runs, the outcome. Also the note of the last scan. */
		function ResumeAllBar() {
			const st = useStore();
			const r = st.resumeAll;
			if (!r && !st.scanNote) return null;
			if (!r) return h("div", { className: "rq-sub", style: { padding: "6px 14px" }, role: "status" }, st.scanNote, " ", h("button", { className: "rq-link", onClick: () => set({ scanNote: undefined }) }, "✕"));
			let body;
			if (r.phase === "confirm") body = [h("span", { key: "t" }, resumeAllText(r.total)), h("span", { key: "g", className: "rq-grow" }), h("button", { key: "y", className: "rq-btn pri", onClick: startResumeAll }, r.total === 1 ? "Resume" : "Resume all"), h("button", { key: "n", className: "rq-link", onClick: closeResumeAll }, "Cancel")];
			else if (r.phase === "running") body = [h("span", { key: "t" }, resumeProgressText(r.progress)), h("span", { key: "g", className: "rq-grow" }), h("button", { key: "s", className: "rq-btn", onClick: stopResumeAll }, "Stop")];
			else body = [h("span", { key: "t" }, "Resumed " + r.result.ok + " of " + r.total + (r.result.failed.length ? "; " + r.result.failed.length + " could not be resumed (" + r.result.failed.map((f) => f.error).filter((e, n, all) => all.indexOf(e) === n).join(", ") + ")" : "") + (r.result.cancelled ? "; stopped" : "") + "."), h("span", { key: "g", className: "rq-grow" }), h("button", { key: "c", className: "rq-link", onClick: closeResumeAll }, "Close")];
			return h("div", { className: "rq-todoform", role: "status" }, h("div", { className: "rq-row" }, body));
		}

		/** A tip body as sentences, one per paragraph: the copy of tipSentences in speech.js (this file is one self-contained script; a test checks both agree). No lookbehind: old iOS Safari parses this whole file too. */
		const TIP_ABBREVIATION = /^[("'\[]*(?:e\.g|i\.e|vs|cf|approx|fig|dr|mr|mrs|ms|prof)\.$/i;
		function tipSentences(text) {
			const words = String(text == null ? "" : text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
			const out = [];
			let cur = [];
			words.forEach((w, i) => {
				cur.push(w);
				const next = words[i + 1];
				if (next !== undefined && /[.!?]$/.test(w) && /^[A-Z0-9"'(\[`]/.test(next) && !TIP_ABBREVIATION.test(w)) { out.push(cur.join(" ")); cur = []; }
			});
			if (cur.length) out.push(cur.join(" "));
			return out;
		}

		/** The tip of the day (a model-written bit of general knowledge, tip.js): a button that reads it aloud, and stops when pressed again. */
		function TipCard({ tip }) {
			const st = useStore();
			const key = "tip:" + tip.id; // the same form as TIP_READING in service.js (this file is one self-contained script)
			const reading = !!(st.snap && st.snap.reading === key);
			const deeperKey = "tip-deeper:" + tip.id;
			const todoKey = "tip-todo:" + tip.id;
			const longer = tipParagraphs(tip.deeper ? tip.deeper.paragraphs : st.tipDeeper[tip.id]);
			const use = st.tipUse.open;
			const list = st.workspaces || [];
			const picked = use ? tipWorkspaceId(list) : ""; // only while the pick is open (the card renders on every store change)
			const note = Array.isArray(st.workspaces) && !st.workspaces.length ? "No workspace is listed yet (the app may still be loading them)." : undefined;
			return h("div", null,
				h("button", { type: "button", className: "rq-tip" + (reading ? " on" : ""), "aria-pressed": reading, disabled: !!st.busy[key], title: reading ? "Stop reading" : "Read this tip aloud", onClick: () => (reading ? act("/v1/stop", {}, key) : act("/v1/read-tip", { id: tip.id }, key)) },
					h("span", null, h("span", { className: "rq-chip" }, tip.category), " ", h("span", { className: "rq-sub" }, "Tip of the day"), tip.source === "model" ? h("span", { className: "rq-sub" }, " · AI-generated") : null),
					h("span", { className: "rq-tip-t" }, tip.title),
					h("span", { className: "rq-tip-b" }, tipSentences(tip.body).map((s, n) => h("span", { key: n, className: "rq-tip-p" }, s))),
					h("span", { className: "rq-tip-f" }, reading ? "■ Stop reading" : "▶ Read aloud")),
				longer.length ? h("div", { className: "rq-tip-dw" }, longer.map((p, n) => h("p", { key: n, className: "rq-tip-d" }, p))) : null,
				h("div", { className: "rq-row rq-tip-actions" },
					longer.length ? null : h("button", { type: "button", className: "rq-btn", title: "A longer explanation of this tip, with an example", disabled: !!st.busy[deeperKey], onClick: () => goDeeper(tip) }, st.busy[deeperKey] ? "Writing…" : "Go deeper"),
					h("button", { type: "button", className: "rq-btn" + (use ? " on" : ""), "aria-expanded": use, title: "Draft a todo that applies this tip to one of your workspaces", onClick: toggleTipUse }, "Use in my code")),
				use ? h("div", { className: "rq-row rq-tip-use" },
					h("select", { className: "rq-input rq-sel", value: picked, disabled: !!st.busy[todoKey], "aria-label": "Workspace for the todo", onChange: (e) => set({ tipUse: { ...state.tipUse, workspaceId: e.target.value } }) }, list.map((w) => h("option", { key: w.id, value: w.id }, w.title))),
					h("button", { type: "button", className: "rq-btn pri", disabled: !!st.busy[todoKey] || !picked || !!st.todoForm.busy || !!st.todoForm.tuning, title: "Write the todo text; you can edit it before it is sent", onClick: () => draftTipTodo(tip) }, st.busy[todoKey] ? "Drafting…" : "Draft todo"),
					note ? h("span", { className: "rq-sub" }, note) : null) : null,
				st.errors[key] ? h("div", { className: "rq-err" }, st.errors[key]) : null,
				st.errors[deeperKey] ? h("div", { className: "rq-err" }, st.errors[deeperKey]) : null,
				st.errors[todoKey] ? h("div", { className: "rq-err" }, st.errors[todoKey]) : null);
		}

		function Panel() {
			const st = useStore();
			const snap = st.snap;
			const open = visibleOpen();
			const sel = currentItem();
			const none = st.showHeld ? "No session is on hold." : snap && snap.open.some((i) => i.type !== "onhold") ? "Nothing matches this filter." : "Nothing waiting on you.";
			const banner = st.error ? h("div", { className: "rq-banner" }, st.error) : null;
			// With no open item at all the tip shows in the right panel (the detail pane, empty then); the left list keeps only the message.
			// The narrow layout hides both panes and shows one column, so there the tip sits under the message. Never next to cards, never in Resolved.
			const tip = snap && !st.showHeld && !snap.open.some((i) => i.type !== "onhold") && snap.tip ? h(TipCard, { tip: snap.tip }) : null;
			const emptySide = h("div", { className: "rq-emptywrap" }, h("div", { className: "rq-empty" }, none));
			const empty = h("div", { className: "rq-emptywrap" }, h("div", { className: "rq-empty" }, none), tip);
			const list = open.length ? open.map((it) => h(Card, { key: it.id, item: it })) : snap ? empty : h("div", { className: "rq-empty" }, "Loading…");
			const extra = h("button", { className: "rq-btn", title: "Close (Esc)", onClick: () => setOverlay(false) }, "✕ Close");
			return h("div", { className: "rq rq-ov", "data-rq": "overlay", role: "dialog", "aria-label": "Coding Boss Review Queue" }, h(Head, { snap, extra }), noticeBanner(snap), banner, h(ResumeAllBar), h(TodoForm), st.showPhone ? h(PhoneDialog) : null, st.showHeld ? null : h(FilterBar, { snap }),
				st.showResolved ? h("div", { className: "rq-body" }, h(ResolvedList, { items: snap ? snap.resolved : [] }))
					: h("div", { className: "rq-split" },
						h("div", { className: "rq-side" }, open.length ? open.map((it) => h(SideRow, { key: it.id, it, selected: !!sel && sel.id === it.id })) : emptySide),
						h("div", { className: "rq-detail" }, sel ? h(Card, { key: sel.id, item: sel, forceFull: true, selected: false }) : tip ? h("div", { className: "rq-tipwrap" }, tip) : null),
						h("div", { className: "rq-narrow" }, list)),
				st.showResolved ? null : h("div", { className: "rq-hint" }, "j / k or ↑ ↓ move · r read aloud · e reviewed · Shift+A approve · Shift+D deny · Enter sends when all questions are answered · Esc or Ctrl+Alt+L close"));
		}

		/** The full-screen overlay: mounted once, in a root on document.body (the queue is global, not per session). */
		function Overlay() {
			const st = useStore();
			useEffect(() => {
				if (!st.overlay) return undefined;
				const onKey = (e) => {
					if (e.key === "Escape") { if (state.todoForm.open) closeTodoForm(); else if (state.showPhone) set({ showPhone: false }); else setOverlay(false); return; }
					if (state.showResolved || state.showPhone) return;
					const action = keyAction(e);
					const cur = action ? currentItem() : undefined;
					if (!cur) return;
					const open = visibleOpen();
					const i = open.findIndex((x) => x.id === cur.id);
					if (action === "next" || action === "prev") { e.preventDefault(); const to = open[Math.min(open.length - 1, Math.max(0, i + (action === "next" ? 1 : -1)))]; if (to) set({ selected: to.id }); return; }
					if (state.busy[cur.id]) return;
					e.preventDefault();
					if (action === "read") { if (state.snap && state.snap.reading === cur.id) act("/v1/stop", {}, cur.id); else act("/v1/read", { id: cur.id }, cur.id); }
					else { const route = keyRoute(action, cur); if (route) act(route, { id: cur.id }, cur.id, { advance: true }); }
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
			const n = st.snap ? waitingCount(st.snap.open) : 0;
			return h("span", { className: "rq rq-hwrap" }, h("button", { className: "rq-hbtn" + (st.overlay ? " on" : ""), "data-rq": "anchor", title: st.overlay ? "Close the Coding Boss Review Queue" : "Open the Coding Boss Review Queue (" + n + " waiting)", "aria-keyshortcuts": "Control+Alt+L", "aria-label": "Coding Boss Review Queue", "aria-expanded": st.overlay, onClick: () => setOverlay(!st.overlay) },
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
			if (state.todoForm.open) { if (isFollowUpForm(state.todoForm)) loadFollowSessions(); else { ensureWorkspaces(); loadEfforts(); } } // a draft restored open needs its dropdown (the workspaces, or for a follow-up the sessions)
			ctx.effect(() => { pollLoop(); return () => { stopped = true; if (pollCtl) pollCtl.abort(); }; }, "review-queue: polling");
			ctx.effect(() => (typeof document === "undefined" || typeof document.addEventListener !== "function" ? () => {} : installRepoll(document)), "review-queue: visibility");
			ctx.effect(mountOverlayRoot, "review-queue: overlay");
			ctx.effect(() => (typeof window === "undefined" || typeof window.addEventListener !== "function" ? () => {} : installHotkey(window)), "review-queue: hotkey");
			ctx.effect(() => (typeof window === "undefined" || typeof document === "undefined" || typeof window.addEventListener !== "function" ? () => {} : installDraftFlush(window, document)), "review-queue: todo draft flush");
			// order 1000: after every other utility, i.e. next to the right-sidebar (corner) button.
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: ANCHOR_ID, order: 1000, label: () => "Coding Boss Review Queue" }, HeaderAnchor)), "review-queue: header button");
		}

		/** Pure card helpers the phone page (lib/mobile) reuses by loading this file with a stub React; keep them free of React and of this module's state. */
		exports.shared = { detachedNote, isReopenable, nextAfter, filterItems, similarCount, mdInline, mdBlocks, actionTokens, plainAction, cardTitle, fmtAge, fmtLeft, toggleChoice, buildAnswers, answerText, resolutionText, typeLabel, errorText, pruneSaved, sinceOf, sessionsText, sessionsTitle, tipSentences, detailsOpen, isSendKey, recommended, waitingCount, pausedCount, pausedFacts, heldCount, heldFacts, FILTER_TYPES, filterBarVisible, todoLine, todoCardState, todoSelect, todoTarget };
		exports.inject = inject;
		exports.apply = apply;
		exports.HeaderAnchor = HeaderAnchor;
		exports.__test = { detachedNote, isReopenable, nextAfter, keyAction, filterItems, similarCount, pruneSaved, mdInline, mdBlocks, isSendKey, cardTitle, fmtAge, fmtLeft, baseName, toggleChoice, buildAnswers, answerText, resolutionText, typeLabel, CSS, LS, detailsOpen, pruneToggles, set, applySnapshot, setOverlay, state };
		Object.assign(exports.__test, { uiStep, sinceOf, sessionsText, applyUi, setOverlay, state, uiPeek: () => ({ overlay: state.overlay, uiSeen }) });
		Object.assign(exports.__test, { loadFollowSessions, followLabel, followPlaceholder, todoCardState, todoTarget, canConfirm, todoSelect, todoLine, waitingCount, FILTER_TYPES, filterBarVisible, keyRoute, isSubmitKey, todoFormProblem, openControl, loadWorkspaces, ensureWorkspaces, workspacesNote, submitTodo, confirmTodo, cancelTodo, TodoBody, FollowUpBody, Card, TodoForm, setTodoMode });
		Object.assign(exports.__test, { RESUME_AT_A_TIME, RESUME_SLOT_MS, RESUME_POLL_MS, RESUME_GRACE_MS, resumeProgressText, pollRunning, sleepFor, resumeAllText, settledAfter, runResumeAll, resumeOne, pausedCount, pausedFacts, heldCount, heldFacts, OnHoldBody, HoldForm, HoldButton, PausedBody, startResumeAll, askResumeAll });
		Object.assign(exports.__test, { enterAnswers, QuestionBody });
		Object.assign(exports.__test, { mdNodes, Md, CompletedBody, PermissionBody, ResolvedCard, actionTokens, plainAction, actionNodes });
		Object.assign(exports.__test, { patchForm, openTodoForm, closeTodoForm, installDraftFlush, canTune, nextFormAfterTune, tuneTodo, undoTune, setTuneAnswer, applyTuneAnswers, skipTuneQuestions, revealSessionRow, setHostOpen: (fn) => { hostApi.openSession = fn; }, imageFilesOf, addImages, removeImage, clearImages, TodoForm, loadEfforts });
		Object.assign(exports.__test, { hotkeyAction, installHotkey, act, errorText, openSession, resolvedOpenAction, isButtonClick, Panel, PhoneHost, loadPhonePanel, setPhoneImporter: (fn) => { phoneImporter = fn; phonePanel = undefined; } });
		return module.exports;
	}
});
