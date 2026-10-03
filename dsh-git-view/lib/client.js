window.__ModuleLoader__.load({
	id: "dsh-git-view",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useMemo, useCallback } = React;

		const TAB_ID = "dsh-git-view";
		const TAB_KIND = "git";
		const API = `http://${(typeof location !== "undefined" && location.hostname) || "127.0.0.1"}:${(typeof window !== "undefined" && window.__GIT_VIEW_PORT__) || 3082}`;
		const POLL_MS = 3000;
		const CONTEXT_FULL = 100000;
		const FOLD_KEEP = 3;
		const FOLD_MIN = 8;
		const MAX_ROWS = 3000;
		const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;

		// =====================================================================================
		// Pure helpers (exported through exports.__test for unit tests)
		// =====================================================================================

		/** Decode a git path field: strip the TAB git appends to ---/+++ names with spaces, and undo C-style quoting. */
		function gitPathField(raw) {
			let s = raw.replace(/\t$/, "");
			if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
				const bytes = [];
				const body = s.slice(1, -1);
				for (let i = 0; i < body.length; i++) {
					const c = body[i];
					if (c !== "\\") { for (const b of new TextEncoder().encode(c)) bytes.push(b); continue; }
					const n = body[++i];
					if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(body[i + 1] || "")) o += body[++i]; bytes.push(parseInt(o, 8) & 255); }
					else bytes.push(({ t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11 })[n] || n.charCodeAt(0));
				}
				s = new TextDecoder().decode(new Uint8Array(bytes));
			}
			return s;
		}

		/** Parse a unified diff (as printed by `git diff` / `git show`) into files, hunks and lines. */
		function parseUnifiedDiff(patch) {
			const files = [];
			if (!patch) return files;
			const chunks = patch.split(/^(?=diff --(?:git|cc|combined) )/m).filter((c) => c.startsWith("diff --"));
			for (const chunk of chunks) {
				const lines = chunk.split("\n");
				if (lines[lines.length - 1] === "") lines.pop();
				const combined = !/^diff --git /.test(lines[0]);
				const f = { oldPath: undefined, newPath: undefined, path: "", status: "M", binary: false, combined, hunks: [], added: 0, deleted: 0 };
				const quotedHead = /^diff --git ("(?:[^"\\]|\\.)*"|a\/\S.*?) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(lines[0]);
				const head = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]);
				if (quotedHead && (quotedHead[1][0] === '"' || quotedHead[2][0] === '"')) { f.oldPath = gitPathField(quotedHead[1]).replace(/^a\//, ""); f.newPath = gitPathField(quotedHead[2]).replace(/^b\//, ""); }
				else if (head) { f.oldPath = head[1]; f.newPath = head[2]; }
				else { const cc = /^diff --(?:cc|combined) (.+)$/.exec(lines[0]); if (cc) f.newPath = f.oldPath = cc[1]; }
				let i = 1;
				for (; i < lines.length && !lines[i].startsWith("@@"); i++) {
					const l = lines[i];
					if (l.startsWith("new file mode")) f.status = "A";
					else if (l.startsWith("deleted file mode")) f.status = "D";
					else if (l.startsWith("rename from ")) { f.status = "R"; f.oldPath = l.slice(12); }
					else if (l.startsWith("rename to ")) { f.status = "R"; f.newPath = l.slice(10); }
					else if (l.startsWith("copy from ")) { f.status = "C"; f.oldPath = l.slice(10); }
					else if (l.startsWith("copy to ")) { f.status = "C"; f.newPath = l.slice(8); }
					else if (l.startsWith("--- ") && l !== "--- /dev/null") f.oldPath = gitPathField(l.slice(4)).replace(/^a\//, "");
					else if (l.startsWith("+++ ") && l !== "+++ /dev/null") f.newPath = gitPathField(l.slice(4)).replace(/^b\//, "");
					else if (/^Binary files .* differ$/.test(l) || l.startsWith("GIT binary patch")) f.binary = true;
				}
				f.path = f.newPath || f.oldPath || "";
				let hunk;
				let o = 0, n = 0;
				const cols = combined ? 2 : 1;
				for (; i < lines.length; i++) {
					const l = lines[i];
					const m = /^@@+ (.*?) @@+(.*)$/.exec(l);
					if (l.startsWith("@@") && m) {
						const nums = /\+(\d+)(?:,(\d+))?/.exec(m[1]);
						const olds = /-(\d+)(?:,(\d+))?/.exec(m[1]);
						o = olds ? Number(olds[1]) : 0;
						n = nums ? Number(nums[1]) : 0;
						hunk = { header: l, section: m[2].trim(), lines: [] };
						f.hunks.push(hunk);
						continue;
					}
					if (!hunk) continue;
					if (l.startsWith("\\")) { const last = hunk.lines[hunk.lines.length - 1]; if (last) last.noNewline = true; continue; }
					const prefix = l.slice(0, cols);
					const text = l.slice(cols);
					if (prefix.includes("+")) { hunk.lines.push({ t: "add", text, n: n++ }); f.added++; }
					else if (prefix.includes("-")) { hunk.lines.push({ t: "del", text, o: o++ }); f.deleted++; }
					else { hunk.lines.push({ t: "ctx", text, o: o++, n: n++ }); }
				}
				files.push(f);
			}
			return files;
		}

		/** Common prefix/suffix word-level highlight of a changed line pair; undefined when too different. */
		function intraline(a, b) {
			if (a === b) return undefined;
			let p = 0;
			const max = Math.min(a.length, b.length);
			while (p < max && a[p] === b[p]) p++;
			let s = 0;
			while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
			const shared = p + s;
			if (shared < Math.min(a.length, b.length) * 0.3) return undefined;
			return {
				a: [a.slice(0, p), a.slice(p, a.length - s), a.slice(a.length - s)],
				b: [b.slice(0, p), b.slice(p, b.length - s), b.slice(b.length - s)],
			};
		}

		/**
		 * Split a hunk's lines into visible lines and foldable runs of unchanged context.
		 * Leading and trailing runs keep FOLD_KEEP lines next to the change; inner runs keep FOLD_KEEP on each side.
		 */
		function segmentHunk(lines, hunkKey) {
			const out = [];
			let i = 0;
			while (i < lines.length) {
				if (lines[i].t !== "ctx") { out.push({ kind: "line", line: lines[i] }); i++; continue; }
				let j = i;
				while (j < lines.length && lines[j].t === "ctx") j++;
				const run = lines.slice(i, j);
				const lead = i === 0, trail = j === lines.length;
				const keepHead = lead ? 0 : FOLD_KEEP;
				const keepTail = trail ? 0 : FOLD_KEEP;
				if (run.length > FOLD_MIN && run.length > keepHead + keepTail + 2) {
					run.slice(0, keepHead).forEach((line) => out.push({ kind: "line", line }));
					out.push({ kind: "fold", key: `${hunkKey}:${i}`, lines: run.slice(keepHead, run.length - keepTail) });
					run.slice(run.length - keepTail).forEach((line) => out.push({ kind: "line", line }));
				} else run.forEach((line) => out.push({ kind: "line", line }));
				i = j;
			}
			return out;
		}

		/** Pair removed and added lines into side-by-side rows. */
		function pairRows(items) {
			const rows = [];
			let dels = [], adds = [];
			const flush = () => {
				const n = Math.max(dels.length, adds.length);
				for (let k = 0; k < n; k++) rows.push({ kind: "pair", l: dels[k], r: adds[k] });
				dels = []; adds = [];
			};
			for (const it of items) {
				if (it.kind !== "line") { flush(); rows.push(it); continue; }
				const t = it.line.t;
				if (t === "del") dels.push(it.line);
				else if (t === "add") adds.push(it.line);
				else { flush(); rows.push({ kind: "pair", l: it.line, r: it.line, ctx: true }); }
			}
			flush();
			return rows;
		}

		// One shared collator: localeCompare with options builds a new collator per call.
		const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
		const byName = (a, b) => collator.compare(a, b);

		/** Directory tree over file entries; single-child directory chains are compacted into `a/b/c`. */
		function buildTree(files) {
			const root = { dirs: new Map(), files: [] };
			for (const f of files) {
				const parts = f.path.split("/");
				let node = root;
				for (let i = 0; i < parts.length - 1; i++) {
					if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
					node = node.dirs.get(parts[i]);
				}
				node.files.push(f);
			}
			const convert = (node, prefix) => {
				const out = [];
				for (const [name, child] of [...node.dirs.entries()].sort((a, b) => byName(a[0], b[0]))) {
					let label = name, cur = child, path = prefix ? prefix + "/" + name : name;
					while (cur.files.length === 0 && cur.dirs.size === 1) {
						const [n2, c2] = [...cur.dirs.entries()][0];
						label += "/" + n2; path += "/" + n2; cur = c2;
					}
					out.push({ type: "dir", name: label, path, children: convert(cur, path), count: countFiles(cur) });
				}
				for (const f of [...node.files].sort((a, b) => byName(a.path, b.path))) out.push({ type: "file", name: f.path.split("/").pop(), file: f });
				return out;
			};
			const countFiles = (node) => node.files.length + [...node.dirs.values()].reduce((s, d) => s + countFiles(d), 0);
			return convert(root, "");
		}

		/** Why a file entry has no diff to show (too large, symlink, server error), or undefined when it is a normal entry. */
		function filePlaceholder(file) {
			if (file.tooLarge) return "File too large to diff";
			if (file.symlink) return "Symbolic link: not followed, so no content is shown";
			if (file.error) return String(file.error);
			return undefined;
		}

		function relTime(ms) {
			const s = Math.max(0, (Date.now() - ms) / 1000);
			if (s < 60) return "just now";
			if (s < 3600) return Math.floor(s / 60) + "m ago";
			if (s < 86400) return Math.floor(s / 3600) + "h ago";
			if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
			return new Date(ms).toLocaleDateString();
		}

		const baseName = (p) => p.split("/").pop();
		const dirName = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
		const cleanRef = (r) => (r || "").replace(/^refs\/(remotes|heads|tags)\//, "");
		const STATUS_TITLE = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked", T: "Type changed" };

		// =====================================================================================
		// Transport
		// =====================================================================================

		async function getJson(path, params, signal) {
			const qs = new URLSearchParams();
			for (const k in params) if (params[k] !== undefined && params[k] !== null && params[k] !== "") qs.set(k, String(params[k]));
			const res = await fetch(`${API}${path}?${qs}`, { signal, cache: "no-store" });
			if (!res.ok) {
				// 429 = the git service is shedding load: callers back off (honoring Retry-After) instead of reporting it as down.
				const err = new Error(res.status === 429 ? "Git service busy, retrying shortly" : `HTTP ${res.status}`);
				err.status = res.status;
				if (res.status === 429) err.retryAfterMs = Math.min(60000, Math.max(1000, (Number(res.headers.get("Retry-After")) || 1) * 1000));
				throw err;
			}
			return res.json();
		}

		/** Run n over items with at most limit in flight; results keep input order. */
		async function mapLimit(items, limit, fn, signal) {
			const out = new Array(items.length);
			let next = 0;
			const worker = async () => { while (next < items.length && !(signal && signal.aborted)) { const i = next++; out[i] = await fn(items[i]); } };
			await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
			return out;
		}

		// =====================================================================================
		// Preferences
		// =====================================================================================

		const PREF_KEY = "dsh-git-view:prefs2";
		const DEFAULT_PREFS = { view: "tree", diffMode: "inline", wrap: true, ws: false, lineNumbers: true, full: false, fileTree: false, collapsed: {} };
		function loadJson(key, fallback) { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") }; } catch (_e) { return { ...fallback }; } }
		function usePrefs() {
			const [prefs, setPrefs] = useState(() => loadJson(PREF_KEY, DEFAULT_PREFS));
			const set = useCallback((patch) => setPrefs((p) => {
				const next = { ...p, ...(typeof patch === "function" ? patch(p) : patch) };
				try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch (_e) { /* private mode */ }
				return next;
			}), []);
			return [prefs, set];
		}

		// =====================================================================================
		// Styles
		// =====================================================================================

		const CSS = `
.gv{--gv-fg:var(--dsw-alias-label-primary,#f9fafb);--gv-mute:var(--dsw-alias-label-tertiary,#adb2b8);--gv-border:var(--dsw-alias-border-l2,#ffffff1f);
--gv-hover:var(--dsw-alias-interactive-bg-hover,#ffffff14);--gv-layer:var(--dsw-alias-bg-layer-1,#232324);--gv-layer2:var(--dsw-alias-bg-layer-2,#2c2c2e);
--gv-accent:var(--dsw-alias-link,#7aaaff);--gv-err:var(--dsw-alias-state-error-primary,#f25a5a);--gv-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--gv-ok:var(--dsw-alias-state-success-primary,#22c55e);
--gv-add-bg:var(--dsw-alias-file-diff-added-bg,#1f3124);--gv-add-gutter:var(--dsw-alias-file-diff-added-gutter,#132016);--gv-add-mark:var(--dsw-alias-file-diff-added-marker,#41c977);
--gv-del-bg:var(--dsw-alias-file-diff-deleted-bg,#3c1f1b);--gv-del-gutter:var(--dsw-alias-file-diff-deleted-gutter,#28130e);--gv-del-mark:var(--dsw-alias-file-diff-deleted-marker,#fa423e);
--gv-s-M:#e2c08d;--gv-s-A:#81b88b;--gv-s-D:#c74e39;--gv-s-R:#73c991;--gv-s-U:#73c991;--gv-s-C:#73c991;--gv-s-T:#e2c08d;
display:flex;flex-direction:column;height:100%;min-height:0;color:var(--gv-fg);font-size:12.5px;line-height:1.4;box-sizing:border-box;position:relative}
.gv.light{--gv-s-M:#895503;--gv-s-A:#587c0c;--gv-s-D:#ad0707;--gv-s-R:#007acc;--gv-s-U:#007100;--gv-s-C:#007acc;--gv-s-T:#895503}
.gv *{box-sizing:border-box}
.gv button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.gv input{font:inherit;color:inherit}
.gv-ic{display:inline-flex;flex:none;align-items:center;justify-content:center}
.gv-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border-radius:5px;color:var(--gv-mute)}
.gv-btn:hover:not(:disabled){background:var(--gv-hover);color:var(--gv-fg)}
.gv-btn:disabled{opacity:.4;cursor:default}
.gv-back{display:inline-flex;align-items:center;gap:6px;padding:6px 14px 6px 10px;margin-right:6px;border-radius:7px;border:1px solid var(--gv-border);background:var(--gv-layer2);color:var(--gv-fg);font-size:13px;font-weight:600;cursor:pointer}.gv-back:hover{background:var(--gv-hover);border-color:var(--gv-accent)}
.gv-btn.on{background:var(--gv-hover);color:var(--gv-fg)}
.gv-head{flex:none;padding:8px 10px 6px;border-bottom:1px solid var(--gv-border);display:flex;flex-direction:column;gap:6px}
.gv-row{display:flex;align-items:center;gap:6px;min-width:0}
.gv-grow{flex:1;min-width:0}
.gv-mono{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace)}
.gv-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.gv-branch{font-weight:600}
.gv-chip{display:inline-flex;align-items:center;gap:3px;padding:0 6px;border-radius:9px;background:var(--gv-layer2);color:var(--gv-mute);font-size:11px;white-space:nowrap}
.gv-chip.warn{color:var(--gv-warn)}.gv-chip.accent{color:var(--gv-accent)}
.gv-body{flex:1;min-height:0;overflow:auto}
.gv-sec{border-bottom:1px solid var(--gv-border)}
.gv-sec-h{display:flex;align-items:center;gap:4px;padding:5px 8px;position:sticky;top:0;background:var(--dsw-alias-bg-base,#151517);z-index:2;cursor:pointer;user-select:none}
.gv-sec-h .t{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--gv-mute)}
.gv-sec-h .c{font-size:11px;color:var(--gv-mute);background:var(--gv-layer2);border-radius:9px;padding:0 6px}
.gv-sec-h .acts{margin-left:auto;display:flex;gap:2px}
.gv-file{display:flex;align-items:center;gap:6px;padding:2px 8px 2px 14px;cursor:pointer;position:relative;min-height:24px}
.gv-file:hover,.gv-file.sel{background:var(--gv-hover)}
.gv-file .nm{color:var(--gv-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gv-file .dir{color:var(--gv-mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;min-width:0;flex:0 1 auto}
.gv-file .stat{margin-left:auto;display:flex;gap:6px;align-items:center;flex:none;font-size:11.5px}
.gv-add{color:var(--gv-s-A)}.gv-del{color:var(--gv-s-D)}
.gv-letter{display:inline-block;width:14px;text-align:center;font-weight:600}
.gv-s-M{color:var(--gv-s-M)}.gv-s-A{color:var(--gv-s-A)}.gv-s-D{color:var(--gv-s-D)}.gv-s-R{color:var(--gv-s-R)}.gv-s-U{color:var(--gv-s-U)}.gv-s-C{color:var(--gv-s-C)}.gv-s-T{color:var(--gv-s-T)}
.gv-badge{display:inline-flex;align-items:center;gap:3px;padding:0 6px;border-radius:9px;font-size:11px}
.gv-badge.bad{background:color-mix(in srgb,var(--gv-err) 14%,transparent);color:var(--gv-err)}
.gv-banner{margin:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--gv-border);background:var(--gv-layer);display:flex;flex-direction:column;gap:4px}
.gv-banner.warn{border-color:color-mix(in srgb,var(--gv-warn) 50%,transparent);background:color-mix(in srgb,var(--gv-warn) 8%,transparent)}
.gv-banner.bad{border-color:color-mix(in srgb,var(--gv-err) 50%,transparent);background:color-mix(in srgb,var(--gv-err) 8%,transparent)}
.gv-banner b{font-weight:600}
.gv-empty{padding:28px 16px;text-align:center;color:var(--gv-mute)}
.gv-empty b{display:block;color:var(--gv-fg);margin-bottom:4px}
.gv-filter{background:var(--gv-layer);border:1px solid var(--gv-border);border-radius:6px;padding:3px 8px;outline:none;width:100%}
.gv-dir{display:flex;align-items:center;gap:4px;padding:2px 8px;cursor:pointer;min-height:24px;color:var(--gv-mute)}
.gv-dir:hover{background:var(--gv-hover)}
.gv-hist{display:flex;gap:8px;padding:0 8px;cursor:pointer}
.gv-hist:hover{background:var(--gv-hover)}
.gv-hist .rail{width:16px;flex:none;position:relative}
.gv-hist .rail:before{content:"";position:absolute;left:7px;top:0;bottom:0;width:2px;background:var(--gv-border)}
.gv-hist.first .rail:before{top:50%}.gv-hist.last .rail:before{bottom:50%}
.gv-hist .dot{position:absolute;left:3px;top:calc(50% - 5px);width:10px;height:10px;border-radius:50%;background:var(--gv-accent);border:2px solid var(--dsw-alias-bg-base,#151517)}
.gv-hist .dot.merge{border-radius:2px}.gv-hist .dot.out{background:var(--gv-ok)}.gv-hist .dot.head{box-shadow:0 0 0 2px color-mix(in srgb,var(--gv-accent) 50%,transparent)}
.gv-hist .main{padding:5px 0;min-width:0;flex:1}
.gv-ref{display:inline-block;padding:0 5px;border-radius:4px;font-size:10.5px;background:color-mix(in srgb,var(--gv-accent) 18%,transparent);color:var(--gv-accent);margin-left:4px}
.gv-dv{display:flex;flex-direction:column;height:100%;min-height:0}
.gv-dv-tools{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid var(--gv-border)}
.gv-dv-body{flex:1;min-height:0;overflow:auto}
.gv-fsec{border-bottom:1px solid var(--gv-border)}
.gv-fsec-h{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--dsw-alias-bg-layer-1,#232324);cursor:pointer;border-bottom:1px solid var(--gv-border)}
.gv-diffwrap{overflow-x:auto}
.gv-diff{border-collapse:collapse;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;line-height:1.5;width:max-content;min-width:100%}
.gv-diff.wrap{width:100%;table-layout:fixed}
.gv-diff td{padding:0 6px;vertical-align:top}
.gv-ln{width:44px;min-width:44px;text-align:right;color:var(--gv-mute);user-select:none;background:color-mix(in srgb,var(--gv-fg) 4%,transparent)}
.gv-code{white-space:pre}
.gv-diff.wrap .gv-code{white-space:pre-wrap;word-break:break-all}
.gv-mk{width:14px;min-width:14px;text-align:center;user-select:none;color:var(--gv-mute);padding:0 !important}
tr.add td.gv-code,tr.add td.gv-mk{background:var(--gv-add-bg)}tr.add td.gv-ln{background:var(--gv-add-gutter)}
tr.del td.gv-code,tr.del td.gv-mk{background:var(--gv-del-bg)}tr.del td.gv-ln{background:var(--gv-del-gutter)}
tr.add .gv-mk{color:var(--gv-add-mark)}tr.del .gv-mk{color:var(--gv-del-mark)}
td.gv-code.add{background:var(--gv-add-bg)}td.gv-code.del{background:var(--gv-del-bg)}td.gv-code.none{background:color-mix(in srgb,var(--gv-fg) 3%,transparent)}
td.gv-ln.add{background:var(--gv-add-gutter)}td.gv-ln.del{background:var(--gv-del-gutter)}
.gv-iw-add{background:color-mix(in srgb,var(--gv-add-mark) 38%,transparent);border-radius:2px}
.gv-iw-del{background:color-mix(in srgb,var(--gv-del-mark) 38%,transparent);border-radius:2px}
tr.hunk td{background:color-mix(in srgb,var(--gv-accent) 10%,transparent);color:var(--gv-mute);padding:2px 8px;font-style:italic}
tr.fold td{background:var(--gv-layer);color:var(--gv-accent);text-align:center;cursor:pointer;padding:2px 0}
tr.fold:hover td{background:var(--gv-layer2)}
.gv-split td.gv-code{width:50%}
.gv-split td.sepl{border-left:1px solid var(--gv-border)}
.gv-img{display:flex;flex-direction:column;gap:8px;padding:10px}
.gv-img .pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.gv-img .cell{border:1px solid var(--gv-border);border-radius:6px;padding:6px;text-align:center;background:repeating-conic-gradient(#8883 0 25%,transparent 0 50%) 0 0/16px 16px}
.gv-img img{max-width:100%;max-height:320px;object-fit:contain}
.gv-img .cap{font-size:11px;color:var(--gv-mute);margin-bottom:4px}
.gv-stack{position:relative;display:inline-block}
.gv-stack img{display:block}.gv-stack img+img{position:absolute;left:0;top:0}
.gv-tree{max-height:220px;overflow:auto;border-bottom:1px solid var(--gv-border);padding:4px 0}
.gv-spin{width:12px;height:12px;border:2px solid var(--gv-border);border-top-color:var(--gv-accent);border-radius:50%;animation:gvspin .8s linear infinite;display:inline-block}
@keyframes gvspin{to{transform:rotate(360deg)}}
.gv-link{color:var(--gv-accent);cursor:pointer}.gv-link:hover{text-decoration:underline}
.gv-sub{font-size:11px;color:var(--gv-mute)}
`;

		// =====================================================================================
		// Icons
		// =====================================================================================

		const ICONS = {
			chevR: "M6 3.5 10.5 8 6 12.5", chevD: "M3.5 6 8 10.5 12.5 6",
			refresh: "M13 3v3.5h-3.5M3 13V9.5h3.5M12.4 6.5A5 5 0 0 0 4 5M3.6 9.5A5 5 0 0 0 12 11",
			search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM14 14l-3.5-3.5",
			list: "M2.5 4h11M2.5 8h11M2.5 12h11", tree: "M2.5 3.5h5M5 8h8M5 12.5h8M3 3.5v9M3 8h2M3 12.5h2",
			back: "M10 3 5 8l5 5", arrowUp: "M8 13V3M4 7l4-4 4 4", arrowDown: "M8 3v10M4 9l4 4 4-4",
			branch: "M5 3v10M5 9a3 3 0 0 0 3-3V5.5M11 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM5 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
			folder: "M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z",
			file: "M4 2h5l3 3v8.5a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5zM9 2v3h3",
			warn: "M8 2 14.5 13.5h-13zM8 6.5v3M8 11.5h.01", check: "M3 8.5 6.5 12 13 4.5",
			columns: "M2.5 3h11v10h-11zM8 3v10", rows: "M2.5 3h11v10h-11zM2.5 8h11",
			wrap: "M2.5 4h11M2.5 8h8a2.5 2.5 0 0 1 0 5H8m0 0 1.5-1.5M8 13l1.5 1.5M2.5 12h2",
			ws: "M3 4.5v7M13 4.5v7M5.5 8h5", expand: "M8 2v4M5.5 4 8 6.5 10.5 4M8 14v-4M5.5 12 8 9.5 10.5 12M2.5 8h11",
			collapse: "M8 6V2M5.5 4.5 8 2l2.5 2.5M8 10v4M5.5 11.5 8 14l2.5-2.5M2.5 8h11",
			hash: "M6 2.5 5 13.5M11 2.5l-1 11M2.5 6h11M2.5 10h11", image: "M2.5 3h11v10h-11zM2.5 11l3.5-4 3 3 2-2 2.5 3",
			full: "M3 3h4M3 3v4M13 13H9M13 13V9M13 3H9M13 3v4M3 13h4M3 13V9",
		};
		function Icon({ name, size = 14, className }) {
			return h("span", { className: "gv-ic" + (className ? " " + className : ""), style: { width: size, height: size } },
				h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" },
					h("path", { d: ICONS[name] || "" })));
		}
		function Btn({ icon, title, onClick, on, disabled, children, className }) {
			return h("button", { type: "button", className: "gv-btn" + (on ? " on" : "") + (className ? " " + className : ""), title, "aria-label": title, "aria-pressed": on === undefined ? undefined : !!on, disabled, onClick },
				icon ? h(Icon, { name: icon }) : null, children);
		}

		// =====================================================================================
		// Diff rendering
		// =====================================================================================

		function Hl({ parts, cls }) {
			return h(React.Fragment, null, parts[0], parts[1] ? h("span", { className: cls }, parts[1]) : null, parts[2]);
		}

		function InlineRows({ file, hunks, prefs, expanded, toggleFold, fileKey, limit }) {
			const rows = [];
			let count = 0;
			outer: for (let hi = 0; hi < hunks.length; hi++) {
				const hunk = hunks[hi];
				rows.push(h("tr", { className: "hunk", key: `h${hi}` }, h("td", { colSpan: 4 }, hunk.header.replace(/^@@+ /, "@@ ").replace(/ @@+/, " @@"))));
				const segs = segmentHunk(hunk.lines, `${fileKey}:${hi}`);
				// pair adjacent del/add runs for intra-line highlight
				const hl = new Map();
				for (let k = 0; k < segs.length; k++) {
					if (segs[k].kind !== "line" || segs[k].line.t !== "del") continue;
					let a = k; while (a < segs.length && segs[a].kind === "line" && segs[a].line.t === "del") a++;
					let b = a; while (b < segs.length && segs[b].kind === "line" && segs[b].line.t === "add") b++;
					const nd = a - k, na = b - a;
					for (let q = 0; q < Math.min(nd, na); q++) {
						const x = intraline(segs[k + q].line.text, segs[a + q].line.text);
						if (x) { hl.set(segs[k + q].line, x.a); hl.set(segs[a + q].line, x.b); }
					}
					k = b - 1;
				}
				for (let si = 0; si < segs.length; si++) {
					const s = segs[si];
					if (s.kind === "fold" && !expanded.has(s.key)) {
						rows.push(h("tr", { className: "fold", key: `f${hi}-${si}`, onClick: () => toggleFold(s.key) }, h("td", { colSpan: 4 }, `⋯ ${s.lines.length} unchanged lines`)));
						continue;
					}
					const lines = s.kind === "fold" ? s.lines : [s.line];
					for (const l of lines) {
						if (++count > limit) break outer;
						const parts = hl.get(l);
						rows.push(h("tr", { className: l.t, key: `${hi}-${si}-${l.o ?? ""}-${l.n ?? ""}` },
							prefs.lineNumbers ? h("td", { className: "gv-ln" }, l.o ?? "") : null,
							prefs.lineNumbers ? h("td", { className: "gv-ln" }, l.n ?? "") : null,
							h("td", { className: "gv-mk" }, l.t === "add" ? "+" : l.t === "del" ? "−" : ""),
							h("td", { className: "gv-code" }, parts ? h(Hl, { parts, cls: l.t === "add" ? "gv-iw-add" : "gv-iw-del" }) : (l.text || " "))));
					}
				}
			}
			return { rows, truncated: count > limit };
		}

		function SplitRows({ hunks, prefs, expanded, toggleFold, fileKey, limit }) {
			const rows = [];
			let count = 0;
			outer: for (let hi = 0; hi < hunks.length; hi++) {
				const hunk = hunks[hi];
				rows.push(h("tr", { className: "hunk", key: `h${hi}` }, h("td", { colSpan: 4 }, hunk.header.replace(/^@@+ /, "@@ ").replace(/ @@+/, " @@"))));
				const segs = segmentHunk(hunk.lines, `${fileKey}:${hi}`);
				const flat = [];
				for (const s of segs) {
					if (s.kind === "fold" && expanded.has(s.key)) s.lines.forEach((line) => flat.push({ kind: "line", line }));
					else flat.push(s);
				}
				const paired = pairRows(flat);
				for (let ri = 0; ri < paired.length; ri++) {
					const r = paired[ri];
					if (r.kind === "fold") {
						rows.push(h("tr", { className: "fold", key: `f${hi}-${ri}`, onClick: () => toggleFold(r.key) }, h("td", { colSpan: 4 }, `⋯ ${r.lines.length} unchanged lines`)));
						continue;
					}
					if (++count > limit) break outer;
					const x = !r.ctx && r.l && r.r ? intraline(r.l.text, r.r.text) : undefined;
					const cell = (line, side, parts) => h("td", { className: "gv-code " + (line ? (line.t === "ctx" ? "" : line.t) : "none") }, line ? (parts ? h(Hl, { parts, cls: side === "l" ? "gv-iw-del" : "gv-iw-add" }) : (line.text || " ")) : "");
					const ln = (line, side) => h("td", { className: "gv-ln " + (line && line.t !== "ctx" ? line.t : "") }, line ? (side === "l" ? line.o : line.n) : "");
					rows.push(h("tr", { key: `${hi}-${ri}` },
						prefs.lineNumbers ? ln(r.l, "l") : null, cell(r.l, "l", x && x.a),
						prefs.lineNumbers ? h("td", { className: "gv-ln sepl " + (r.r && r.r.t !== "ctx" ? r.r.t : "") }, r.r ? r.r.n : "") : null, cell(r.r, "r", x && x.b)));
				}
			}
			return { rows, truncated: count > limit };
		}

		function FileDiffBody({ file, prefs, fileKey }) {
			const [expanded, setExpanded] = useState(() => new Set());
			const [limit, setLimit] = useState(MAX_ROWS);
			const toggleFold = useCallback((k) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; }), []);
			const split = prefs.diffMode === "split";
			const built = useMemo(() => (split ? SplitRows : InlineRows)({ file, hunks: file.hunks, prefs, expanded, toggleFold, fileKey, limit }),
				[file, split, prefs.lineNumbers, expanded, limit, fileKey]);
			if (file.hunks.length === 0) return h("div", { className: "gv-empty" }, file.status === "R" ? "Renamed without changes" : "No textual changes");
			return h("div", null,
				h("div", { className: "gv-diffwrap" },
					h("table", { className: "gv-diff" + (prefs.wrap ? " wrap" : "") + (split ? " gv-split" : "") },
						h("colgroup", null,
							split ? [prefs.lineNumbers ? h("col", { key: 1, style: { width: 44 } }) : null, h("col", { key: 2 }), prefs.lineNumbers ? h("col", { key: 3, style: { width: 44 } }) : null, h("col", { key: 4 })]
								: [prefs.lineNumbers ? h("col", { key: 1, style: { width: 44 } }) : null, prefs.lineNumbers ? h("col", { key: 2, style: { width: 44 } }) : null, h("col", { key: 3, style: { width: 14 } }), h("col", { key: 4 })]),
						h("tbody", null, built.rows))),
				built.truncated ? h("div", { className: "gv-empty" }, h("button", { className: "gv-link", onClick: () => setLimit((n) => n + MAX_ROWS) }, `Large diff: showing first ${limit} rows. Show more`)) : null);
		}

		// ---- image diff ----
		function useBlobUrl(params, q) {
			const [state, setState] = useState({ loading: true });
			const key = JSON.stringify([params.session, params.worktree, q]);
			useEffect(() => {
				let alive = true, url;
				const qs = new URLSearchParams();
				for (const k in { ...params, ...q }) { const v = { ...params, ...q }[k]; if (v !== undefined && v !== "" && v !== null) qs.set(k, v); }
				fetch(`${API}/v1/blob?${qs}`, { cache: "no-store" }).then(async (res) => {
					if (!alive) return;
					if (res.status === 204) return setState({ missing: true });
					const type = res.headers.get("content-type") || "";
					if (!type.startsWith("image/")) { const j = await res.json().catch(() => ({})); return setState({ error: j.error || "unavailable" }); }
					url = URL.createObjectURL(await res.blob());
					if (alive) setState({ url }); else URL.revokeObjectURL(url);
				}).catch((e) => alive && setState({ error: String(e && e.message || e) }));
				return () => { alive = false; if (url) URL.revokeObjectURL(url); };
			}, [key]);
			return state;
		}
		function ImageDiff({ params, scope, path, sha }) {
			const [mode, setMode] = useState("side");
			const [pos, setPos] = useState(50);
			const oldImg = useBlobUrl(params, { scope, path, sha, side: "old" });
			const newImg = useBlobUrl(params, { scope, path, sha, side: "new" });
			const cell = (cap, s) => h("div", { className: "cell" }, h("div", { className: "cap" }, cap),
				s.loading ? h("span", { className: "gv-spin" }) : s.url ? h("img", { src: s.url, alt: cap }) : h("div", { className: "gv-sub" }, s.missing ? "(none)" : s.error || "unavailable"));
			return h("div", { className: "gv-img" },
				h("div", { className: "gv-row" },
					["side", "swipe", "onion"].map((m) => h(Btn, { key: m, on: mode === m, onClick: () => setMode(m) }, m === "side" ? "Side by side" : m === "swipe" ? "Swipe" : "Onion skin")),
					mode !== "side" ? h("input", { type: "range", min: 0, max: 100, value: pos, onChange: (e) => setPos(Number(e.target.value)), "aria-label": "blend position", style: { flex: 1 } }) : null),
				mode === "side" ? h("div", { className: "pair" }, cell("Before", oldImg), cell("After", newImg))
					: (oldImg.url || newImg.url) ? h("div", { className: "cell" }, h("div", { className: "gv-stack" },
						oldImg.url ? h("img", { src: oldImg.url, alt: "Before" }) : null,
						newImg.url ? h("img", { src: newImg.url, alt: "After", style: mode === "onion" ? { opacity: pos / 100 } : { clipPath: `inset(0 0 0 ${pos}%)` } }) : null))
						: h("div", { className: "gv-sub" }, "Loading…"));
		}

		/** One file's section: header + text diff / image / binary notice. */
		function FileSection({ file, prefs, params, scope, sha, collapsed, onToggle, viewed, onView, deferred, onLoad, sectionRef }) {
			const changed = file.added + file.deleted;
			const isImage = IMAGE_EXT.test(file.path);
			const placeholder = filePlaceholder(file);
			return h("div", { className: "gv-fsec", ref: sectionRef },
				h("div", { className: "gv-fsec-h", onClick: onToggle },
					h(Icon, { name: collapsed ? "chevR" : "chevD" }),
					h("span", { className: "gv-letter gv-s-" + (file.status === "A" && scope === "untracked" ? "U" : file.status) }, scope === "untracked" ? "U" : file.status),
					h("span", { className: "gv-ell", title: file.path, style: { fontWeight: 600 } }, baseName(file.path)),
					h("span", { className: "gv-ell gv-sub" }, dirName(file.path)),
					file.status === "R" && file.oldPath ? h("span", { className: "gv-sub gv-ell" }, `← ${file.oldPath}`) : null,
					h("span", { style: { marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" } },
						file.added ? h("span", { className: "gv-add" }, "+" + file.added) : null,
						file.deleted ? h("span", { className: "gv-del" }, "−" + file.deleted) : null,
						onView ? h("button", { className: "gv-btn", title: viewed ? "Mark as not viewed" : "Mark as viewed", onClick: (e) => { e.stopPropagation(); onView(); } }, h(Icon, { name: "check", size: 13, className: viewed ? "gv-add" : "" })) : null)),
				collapsed ? null
					: placeholder ? h("div", { className: "gv-empty" }, h("b", null, placeholder))
					: file.binary ? (isImage ? h(ImageDiff, { params, scope, path: file.path, sha }) : h("div", { className: "gv-empty" }, h("b", null, "Binary file changed"), "Text diff is unavailable for this file."))
					: deferred ? h("div", { className: "gv-empty" }, h("b", null, `Large diff (${changed.toLocaleString()} changed lines)`), h("button", { className: "gv-link", onClick: onLoad }, "Load diff"))
					: h(FileDiffBody, { file, prefs, fileKey: scope + ":" + file.path }));
		}

		// =====================================================================================
		// Diff view (single file or all files of a scope)
		// =====================================================================================

		function DiffView({ spec, params, prefs, setPrefs, onBack, onNavigate }) {
			const [state, setState] = useState({ loading: true, files: [] });
			const [collapsed, setCollapsed] = useState({});
			const [viewed, setViewed] = useState({});
			const [loadedBig, setLoadedBig] = useState({});
			const refs = useRef({});
			const multi = spec.mode === "multi";
			const q = { scope: spec.scope, sha: spec.sha };
			// Key from primitives only: stringifying spec would serialize every file entry of a View-all on each render.
			const sf = spec.file;
			const key = [spec.scope, spec.sha, sf && sf.path, sf && sf.origPath, spec.mode, spec.title, spec.files && spec.files.length, params.session, params.worktree, prefs.full, prefs.ws].join("\0");

			useEffect(() => {
				let alive = true;
				const ctrl = new AbortController();
				setState({ loading: true, files: [] });
				setCollapsed({}); setViewed({}); setLoadedBig({});
				const ctx = prefs.full ? CONTEXT_FULL : undefined;
				const common = { ...params, ...q, context: ctx, ws: prefs.ws ? "1" : undefined };
				(async () => {
					try {
						let files = [], note;
						if (spec.scope === "untracked") {
							const list = multi ? spec.files : [spec.file];
							const capped = list.slice(0, 60);
							// At most 4 requests in flight so View all cannot flood the git service (it sheds load with 429).
							const out = await mapLimit(capped, 4, (f) => getJson("/v1/diff", { ...common, path: f.path }, ctrl.signal).then((r) => ({ f, r })), ctrl.signal);
							for (const { f, r } of out.filter(Boolean)) {
								const parsed = r.ok ? parseUnifiedDiff(r.patch) : [];
								if (parsed[0]) files.push({ ...parsed[0], status: "A" });
								else files.push({ path: f.path, status: "A", binary: !!(r.binary), hunks: [], added: 0, deleted: 0, tooLarge: r.tooLarge, symlink: r.symlink, error: r.ok ? undefined : r.error });
							}
							if (list.length > capped.length) note = `Showing the first ${capped.length} of ${list.length} untracked files.`;
						} else {
							const r = await getJson("/v1/diff", { ...common, path: multi ? undefined : spec.file.path, origPath: multi ? undefined : spec.file.origPath }, ctrl.signal);
							if (!r.ok) throw new Error(r.error || "diff failed");
							if (r.truncated) note = "This diff is larger than the 4 MB limit and was not loaded.";
							files = parseUnifiedDiff(r.patch);
							if (!multi && files.length === 0) files = [{ path: spec.file.path, oldPath: spec.file.origPath, status: spec.file.status || "M", binary: false, hunks: [], added: 0, deleted: 0 }];
						}
						if (alive) setState({ loading: false, files, note });
					} catch (e) { if (alive && e.name !== "AbortError") setState({ loading: false, files: [], error: String(e && e.message || e) }); }
				})();
				return () => { alive = false; ctrl.abort(); };
			}, [key]);

			const files = state.files;
			const tree = useMemo(() => buildTree(files), [files]);
			const totals = files.reduce((a, f) => ({ a: a.a + f.added, d: a.d + f.deleted }), { a: 0, d: 0 });
			const allCollapsed = files.length > 0 && files.every((f) => collapsed[f.path]);
			const sib = spec.siblings, idx = sib ? sib.findIndex((f) => f.path === (spec.file && spec.file.path)) : -1;
			const title = multi ? spec.title : spec.file.path;
			const scrollTo = (p) => { const el = refs.current[p]; if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" }); };

			const renderTreeNode = (n, depth) => n.type === "dir"
				? [h("div", { key: "d" + n.path, className: "gv-dir", style: { paddingLeft: 8 + depth * 12 } }, h(Icon, { name: "folder", size: 13 }), h("span", { className: "gv-ell" }, n.name), h("span", { className: "gv-sub" }, n.count)), ...n.children.flatMap((c) => renderTreeNode(c, depth + 1))]
				: [h("div", { key: "f" + n.file.path, className: "gv-file", style: { paddingLeft: 8 + depth * 12 + 6 }, onClick: () => scrollTo(n.file.path) },
					h("span", { className: "gv-letter gv-s-" + (spec.scope === "untracked" ? "U" : n.file.status) }, spec.scope === "untracked" ? "U" : n.file.status),
					h("span", { className: "nm" }, n.name),
					viewed[n.file.path] ? h(Icon, { name: "check", size: 12, className: "gv-add" }) : null)];

			return h("div", { className: "gv-dv" },
				h("div", { className: "gv-dv-tools" },
					h("button", { type: "button", className: "gv-back", title: "Back to changes", "aria-label": "Back to changes", onClick: onBack }, h(Icon, { name: "back", size: 18 }), "Back"),
					!multi && sib && sib.length > 1 ? [
						h(Btn, { key: "p", icon: "arrowUp", title: "Previous file", disabled: idx <= 0, onClick: () => onNavigate(sib[idx - 1]) }),
						h(Btn, { key: "n", icon: "arrowDown", title: "Next file", disabled: idx < 0 || idx >= sib.length - 1, onClick: () => onNavigate(sib[idx + 1]) })] : null,
					h("span", { className: "gv-grow gv-ell", title, style: { fontWeight: 600, padding: "0 4px" } }, multi ? `${files.length} changed file${files.length === 1 ? "" : "s"} · ${spec.title}` : title),
					h("span", { className: "gv-sub", style: { padding: "0 4px" } }, h("span", { className: "gv-add" }, "+" + totals.a), " ", h("span", { className: "gv-del" }, "−" + totals.d)),
					h(Btn, { icon: prefs.diffMode === "split" ? "columns" : "rows", title: prefs.diffMode === "split" ? "Switch to inline" : "Switch to side by side", onClick: () => setPrefs({ diffMode: prefs.diffMode === "split" ? "inline" : "split" }) }),
					h(Btn, { icon: "wrap", title: "Word wrap", on: prefs.wrap, onClick: () => setPrefs({ wrap: !prefs.wrap }) }),
					h(Btn, { icon: "ws", title: prefs.ws ? "Showing whitespace changes: off" : "Ignore whitespace changes", on: prefs.ws, onClick: () => setPrefs({ ws: !prefs.ws }) }),
					h(Btn, { icon: "hash", title: "Line numbers", on: prefs.lineNumbers, onClick: () => setPrefs({ lineNumbers: !prefs.lineNumbers }) }),
					h(Btn, { icon: "full", title: prefs.full ? "Show changed hunks only" : "Show whole file", on: prefs.full, onClick: () => setPrefs({ full: !prefs.full }) }),
					multi ? [
						h(Btn, { key: "e", icon: allCollapsed ? "expand" : "collapse", title: allCollapsed ? "Expand all" : "Collapse all", onClick: () => setCollapsed(allCollapsed ? {} : Object.fromEntries(files.map((f) => [f.path, true]))) }),
						h(Btn, { key: "t", icon: "tree", title: "File tree", on: prefs.fileTree, onClick: () => setPrefs({ fileTree: !prefs.fileTree }) })] : null),
				multi && prefs.fileTree && files.length ? h("div", { className: "gv-tree" }, tree.flatMap((n) => renderTreeNode(n, 0))) : null,
				h("div", { className: "gv-dv-body" },
					state.loading ? h("div", { className: "gv-empty" }, h("span", { className: "gv-spin" })) : null,
					state.error ? h("div", { className: "gv-banner bad" }, h("b", null, "Could not load diff"), state.error) : null,
					state.note ? h("div", { className: "gv-banner warn" }, state.note) : null,
					!state.loading && !state.error && files.length === 0 ? h("div", { className: "gv-empty" }, h("b", null, "No differences"), prefs.ws ? "Try showing whitespace changes." : "") : null,
					files.map((f) => {
						const big = f.added + f.deleted > 10000 && !loadedBig[f.path];
						return h(FileSection, {
							key: f.path, file: f, prefs, params, scope: spec.scope, sha: spec.sha,
							collapsed: !!collapsed[f.path], onToggle: () => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] })),
							viewed: !!viewed[f.path], onView: multi ? () => { setViewed((v) => ({ ...v, [f.path]: !v[f.path] })); } : undefined,
							deferred: big, onLoad: () => setLoadedBig((l) => ({ ...l, [f.path]: true })),
							sectionRef: (el) => { refs.current[f.path] = el; },
						});
					})));
		}

		// =====================================================================================
		// Changes list
		// =====================================================================================

		function StatusLetter({ s }) {
			const shown = s === "?" ? "U" : s;
			return h("span", { className: "gv-letter gv-s-" + shown, title: STATUS_TITLE[shown] || shown }, shown);
		}
		function Counts({ stats }) {
			if (!stats || stats.binary || (!stats.added && !stats.deleted)) return null;
			return h("span", { className: "stat" },
				stats.added ? h("span", { className: "gv-add" }, "+" + stats.added) : null,
				stats.deleted ? h("span", { className: "gv-del" }, "−" + stats.deleted) : null);
		}

		function FileRow({ f, area, depth, treeMode, onOpen, selected }) {
			const status = area === "untracked" ? "U" : f.status;
			return h("div", { className: "gv-file" + (selected ? " sel" : ""), style: treeMode ? { paddingLeft: 14 + depth * 12 } : undefined, onClick: () => onOpen(f), title: f.path + (f.origPath ? `\n← ${f.origPath}` : ""), tabIndex: 0, onKeyDown: (e) => { if (e.key === "Enter") onOpen(f); } },
				h("span", { className: "gv-s-" + (status === "?" ? "U" : status), style: { display: "inline-flex" } }, h(Icon, { name: "file", size: 14 })),
				h("span", { className: "nm" }, baseName(f.path)),
				!treeMode ? h("span", { className: "dir" }, dirName(f.path)) : null,
				area === "conflict"
					? h("span", { className: "stat" }, h("span", { className: "gv-badge bad" }, h(Icon, { name: "warn", size: 11 }), "Unresolved"), h("span", { className: "gv-sub" }, f.label))
					: h("span", { className: "stat" }, f.submodule ? h("span", { className: "gv-sub" }, "submodule") : null, h(Counts, { stats: f.stats }), h(StatusLetter, { s: status })));
		}

		function TreeList({ files, area, onOpen, collapsedDirs, toggleDir }) {
			const tree = useMemo(() => buildTree(files), [files]);
			const out = [];
			const walk = (nodes, depth) => {
				for (const n of nodes) {
					if (n.type === "dir") {
						const k = `${area}::${n.path}`;
						const closed = collapsedDirs[k];
						out.push(h("div", { key: "d" + k, className: "gv-dir", style: { paddingLeft: 8 + depth * 12 }, onClick: () => toggleDir(k) },
							h(Icon, { name: closed ? "chevR" : "chevD", size: 12 }), h(Icon, { name: "folder", size: 13 }), h("span", { className: "gv-ell" }, n.name), h("span", { className: "gv-sub" }, n.count)));
						if (!closed) walk(n.children, depth + 1);
					} else out.push(h(FileRow, { key: "f" + area + n.file.path, f: n.file, area, depth, treeMode: true, onOpen }));
				}
			};
			walk(tree, 0);
			return h(React.Fragment, null, out);
		}

		function Section({ id, title, count, collapsed, onToggle, actions, children, sub }) {
			return h("section", { className: "gv-sec", "data-section": id },
				h("div", { className: "gv-sec-h", onClick: onToggle },
					h(Icon, { name: collapsed ? "chevR" : "chevD", size: 12 }),
					h("span", { className: "t" }, title), h("span", { className: "c" }, count),
					sub ? h("span", { className: "gv-badge bad" }, sub) : null,
					actions ? h("span", { className: "acts", onClick: (e) => e.stopPropagation() }, actions) : null),
				collapsed ? null : children);
		}


		// ---- history ----
		function History({ params, branchOid, onOpenCommitFile, collapsed, onToggle }) {
			const [data, setData] = useState(null);
			const [open, setOpen] = useState(null);
			const [files, setFiles] = useState({});
			const [limit, setLimit] = useState(50);
			useEffect(() => {
				if (collapsed) return;
				let alive = true;
				getJson("/v1/history", { ...params, limit }).then((r) => alive && setData(r)).catch((e) => { if (alive && e.name !== "AbortError") setData({ ok: false, error: "Could not load history: " + String(e && e.message || e) }); });
				return () => { alive = false; };
			}, [collapsed, branchOid, params.session, params.worktree, limit]);
			const expand = (c) => {
				setOpen((o) => (o === c.sha ? null : c.sha));
				if (!files[c.sha]) getJson("/v1/commit", { ...params, sha: c.sha }).then((r) => setFiles((f) => ({ ...f, [c.sha]: r }))).catch((e) => setFiles((f) => ({ ...f, [c.sha]: { ok: false, error: "Could not load commit: " + String(e && e.message || e) } })));
			};
			return h(Section, { id: "history", title: "History", count: data && data.ok ? data.commits.length + (data.hasMore ? "+" : "") : "", collapsed, onToggle }, collapsed ? null :
				!data ? h("div", { className: "gv-empty" }, h("span", { className: "gv-spin" }))
					: !data.ok ? h("div", { className: "gv-empty" }, data.error)
						: h("div", null,
							data.incoming ? h("div", { className: "gv-sub", style: { padding: "4px 12px" } }, `↓ ${data.incoming} incoming commit${data.incoming === 1 ? "" : "s"} on the upstream`) : null,
							data.commits.map((c, i) => h("div", { key: c.sha },
								h("div", { className: "gv-hist" + (i === 0 ? " first" : "") + (i === data.commits.length - 1 && !data.hasMore ? " last" : ""), onClick: () => expand(c), title: `${c.sha}\n${c.author}` },
									h("div", { className: "rail" }, h("span", { className: "dot" + (c.parents.length > 1 ? " merge" : "") + (c.outgoing ? " out" : "") + (c.head ? " head" : "") })),
									h("div", { className: "main" },
										h("div", { className: "gv-row" }, h("span", { className: "gv-ell gv-grow" }, c.subject),
											c.refs.slice(0, 2).map((r) => h("span", { key: r, className: "gv-ref" }, cleanRef(r))), c.refs.length > 2 ? h("span", { className: "gv-sub" }, "+" + (c.refs.length - 2)) : null),
										h("div", { className: "gv-sub gv-ell" }, `${c.short} · ${c.author} · ${relTime(c.at)}${c.outgoing ? " · not pushed" : ""}`))),
								open === c.sha ? h("div", { style: { paddingLeft: 16 } }, !files[c.sha] ? h("div", { className: "gv-empty" }, h("span", { className: "gv-spin" }))
									: !files[c.sha].ok ? h("div", { className: "gv-empty" }, files[c.sha].error)
										: [files[c.sha].message && files[c.sha].message.includes("\n") ? h("div", { key: "m", className: "gv-sub", style: { padding: "2px 12px", whiteSpace: "pre-wrap" } }, files[c.sha].message.split("\n").slice(1).join("\n").trim()) : null,
											...files[c.sha].files.map((f) => h(FileRow, { key: f.path, f, area: "branch", treeMode: false, onOpen: () => onOpenCommitFile(c, f, files[c.sha].files) }))]) : null)),
							data.hasMore ? h("div", { className: "gv-empty" }, h("button", { className: "gv-link", onClick: () => setLimit((n) => Math.min(n + 50, 200)) }, "Load more")) : null));
		}

		// =====================================================================================
		// Main tab
		// =====================================================================================

		function useSnapshot(params, active) {
			const [state, setState] = useState({ snap: null, error: null, loading: true });
			const raw = useRef("");
			const refresh = useRef(() => {});
			const key = JSON.stringify(params);
			useEffect(() => {
				if (!active) return undefined;
				let stop = false, timer, ctrl, delay = POLL_MS, busyMs = 0;
				const tick = async () => {
					clearTimeout(timer);
					if (typeof document !== "undefined" && document.hidden) { timer = setTimeout(tick, delay); return; }
					const t0 = Date.now();
					ctrl && ctrl.abort(); ctrl = new AbortController();
					try {
						const snap = await getJson("/v1/snapshot", params, ctrl.signal);
						const text = JSON.stringify(snap);
						if (!stop) setState((s) => {
							const same = raw.current === text;
							raw.current = text;
							// Unchanged snapshot: return the same state object so React skips the re-render.
							if (same && !s.error && !s.loading) return s;
							return same ? { ...s, error: null, loading: false } : { snap, error: null, loading: false };
						});
						busyMs = 0;
					} catch (e) {
						// 429 = busy, not unreachable: keep the last snapshot and back off for Retry-After.
						if (e && e.status === 429) busyMs = e.retryAfterMs || 1000;
						else if (!stop && e.name !== "AbortError") setState((s) => ({ ...s, error: "Git service unreachable (" + API + "). Is dsh-git-view loaded? Restart DSH after installing it.", loading: false }));
					}
					delay = Date.now() - t0 > 1500 ? Math.min(delay * 2, 60000) : POLL_MS;
					if (busyMs) delay = Math.max(delay, busyMs);
					if (!stop) timer = setTimeout(tick, delay);
				};
				refresh.current = tick;
				raw.current = "";
				setState((s) => ({ ...s, loading: true }));
				tick();
				return () => { stop = true; clearTimeout(timer); ctrl && ctrl.abort(); };
			}, [key, active]);
			return [state, () => refresh.current()];
		}

		function isDarkTheme() {
			try {
				const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
				if (!m) return true;
				return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) < 140;
			} catch (_e) { return true; }
		}

		function GitTab(props) {
			const sessionId = props.sessionId;
			const info = props.useTabInfo ? props.useTabInfo() : undefined;
			const cwd = props.useSessions ? props.useSessions((s) => s && s.byId && s.byId[sessionId] && s.byId[sessionId].cwd) : undefined;
			const active = !info || !info.tab || info.tab.visible !== false;
			const [prefs, setPrefs] = usePrefs();
			const [filter, setFilter] = useState("");
			const [filterOpen, setFilterOpen] = useState(false);
			const [view, setView] = useState(null);
			const [collapsedDirs, setCollapsedDirs] = useState({});
			const [histCollapsed, setHistCollapsed] = useState(true);

			const params = { session: sessionId, cwd };
			// No polling while a diff view covers the tab (Back refreshes once).
			const [{ snap, error, loading }, refresh] = useSnapshot(params, active && !view);
			// Theme is read when the tab (re)appears, not on every render.
			const dark = useMemo(isDarkTheme, [active, !!view]);

			const st = snap && snap.ok ? snap.status : null;
			const cmp = snap && snap.compare;
			const q = filter.trim().toLowerCase().slice(0, 2048);
			const match = (f) => !q || f.path.toLowerCase().includes(q);
			const lists = useMemo(() => st ? {
				conflict: st.conflicts.filter(match), unstaged: st.changes.filter(match), staged: st.staged.filter(match), untracked: st.untracked.filter(match),
				branch: cmp && cmp.ok ? cmp.files.filter(match) : [],
			} : null, [st, cmp, q]);

			const toggleSection = (id) => setPrefs((p) => ({ collapsed: { ...p.collapsed, [id]: !p.collapsed[id] } }));
			const toggleDir = (k) => setCollapsedDirs((c) => ({ ...c, [k]: !c[k] }));


			const openFile = (scope) => (f) => setView({ mode: "file", scope, file: f, siblings: lists ? lists[scope === "unstaged" ? "unstaged" : scope === "staged" ? "staged" : scope === "untracked" ? "untracked" : scope === "conflict" ? "conflict" : "branch"] : [] });
			const openAll = (scope, files, title) => setView({ mode: "multi", scope, files, title });

			// ---- diff view takes over the tab ----
			if (view) {
				const scope = view.scope === "conflict" ? "unstaged" : view.scope;
				return h("div", { className: "gv " + (dark ? "dark" : "light") }, h("style", null, CSS),
					h(DiffView, {
						spec: { ...view, scope }, params, prefs, setPrefs,
						onBack: () => { setView(null); refresh(); },
						onNavigate: (f) => setView((v) => ({ ...v, file: f })),
					}));
			}

			const header = (() => {
				if (!snap) return null;
				const b = st && st.branch;
				const baseRef = cmp && cmp.baseRef;
				return h("div", { className: "gv-head" },
					h("div", { className: "gv-row" },
						h("span", { className: "gv-grow gv-ell gv-sub", title: st ? st.root : "" }, st ? st.root : ""),
						filterOpen ? null : h(Btn, { icon: "search", title: "Filter files", onClick: () => setFilterOpen(true) }),
						h(Btn, { icon: "refresh", title: "Refresh", onClick: refresh }),
						h(Btn, { icon: prefs.view === "tree" ? "list" : "tree", title: prefs.view === "tree" ? "View as list" : "View as tree", onClick: () => setPrefs({ view: prefs.view === "tree" ? "list" : "tree" }) })),
					filterOpen ? h("div", { className: "gv-row" }, h("input", { className: "gv-filter", autoFocus: true, placeholder: "Filter files…", value: filter, onChange: (e) => setFilter(e.target.value), onKeyDown: (e) => { if (e.key === "Escape") { setFilter(""); setFilterOpen(false); } }, onBlur: () => { if (!filter) setFilterOpen(false); } })) : null,
					b ? h("div", { className: "gv-row", style: { flexWrap: "wrap" } },
						h(Icon, { name: "branch" }),
						h("span", { className: "gv-branch gv-mono gv-ell", title: b.detached ? "Detached HEAD" : b.name }, b.detached ? "HEAD (detached)" : b.unborn ? (b.name || "(no commits yet)") : b.name),
						st.linked ? h("span", { className: "gv-chip accent", title: "This is a linked git worktree: " + st.root }, "worktree") : null,
						b.upstream ? h("span", { className: "gv-chip", title: b.gone ? "Upstream branch no longer exists: " + b.upstream : "Upstream: " + b.upstream }, b.gone ? "upstream gone" : [b.ahead ? "↑" + b.ahead : null, b.behind ? "↓" + b.behind : null].filter(Boolean).join(" ") || "in sync") : null,
						st.stashCount ? h("span", { className: "gv-chip", title: "Stashes" }, "stash " + st.stashCount) : null) : null,
					!b || b.unborn ? null : h("div", { className: "gv-row gv-sub" },
						h("span", null, "→"),
						h("span", { className: "gv-mono gv-ell", title: "Compared against this ref" }, baseRef || (cmp && cmp.error) || "no base ref"),
						cmp && cmp.ok && cmp.ahead ? h("span", { title: cmp.ahead + " commit(s) ahead of " + baseRef }, "↑" + cmp.ahead) : null,
						cmp && cmp.ok && cmp.behind ? h("span", { title: cmp.behind + " commit(s) behind " + baseRef }, "↓" + cmp.behind) : null,
						cmp && cmp.ok ? (() => { const t = cmp.files.reduce((a, f) => ({ a: a.a + (f.stats ? f.stats.added : 0), d: a.d + (f.stats ? f.stats.deleted : 0) }), { a: 0, d: 0 }); return t.a || t.d ? h("span", { className: "gv-chip", title: "Lines changed on this branch vs " + baseRef }, h("span", { className: "gv-add" }, "+" + t.a), h("span", { className: "gv-del" }, "−" + t.d)) : null; })() : null));
			})();

			// ---- body ----
			let body;
			if (!snap) {
				body = error ? h("div", { className: "gv-banner bad" }, h("b", null, "Git view unavailable"), error)
					: h("div", { className: "gv-empty" }, h("span", { className: "gv-spin" }));
			} else if (!snap.ok) {
				body = h("div", { className: "gv-empty" }, h("b", null, snap.error === "not a git repository" ? "Not a git repository" : "Cannot show git status"), snap.error, snap.sessionCwd ? h("div", { className: "gv-sub gv-mono", style: { marginTop: 6 } }, snap.sessionCwd) : null);
			} else if (!st.ok) {
				body = h("div", { className: "gv-banner bad" }, h("b", null, "git status failed"), st.error);
			} else {
				const L = lists;
				const unresolved = st.conflicts.length;
				const opName = st.operation === "cherry-pick" ? "Cherry-pick" : st.operation ? st.operation[0].toUpperCase() + st.operation.slice(1) : "";
				const total = L.conflict.length + L.unstaged.length + L.staged.length + L.untracked.length;
				const nothing = st.conflicts.length + st.changes.length + st.staged.length + st.untracked.length === 0;
				const renderList = (files, area, scope) => prefs.view === "tree"
					? h(TreeList, { files, area, onOpen: openFile(scope), collapsedDirs, toggleDir })
					: files.map((f) => h(FileRow, { key: area + f.path, f, area, treeMode: false, onOpen: openFile(scope) }));
				const secActs = (list, scope, title) => [
					h("button", { key: "va", className: "gv-btn", title: "View all", onClick: () => openAll(scope, list, title) }, h(Icon, { name: "rows" }), "View all"),
				];
				body = h(React.Fragment, null,
					st.operation ? h("div", { className: "gv-banner warn" },
						h("b", null, unresolved ? `${opName} conflicts: ${unresolved} unresolved` : `${opName} in progress`),
						h("span", { className: "gv-sub" }, unresolved ? "Resolve them in the session. This view is read-only." : "Finish or abort it in the session.")) : null,
					st.truncated ? h("div", { className: "gv-banner warn" }, h("b", null, "Too many changes detected"), `Only the first 1,000 of ${st.total.toLocaleString()} are shown.`, h("button", { className: "gv-link", style: { alignSelf: "flex-start" }, onClick: refresh }, "Retry")) : null,
					q && total === 0 && L.branch.length === 0 ? h("div", { className: "gv-empty" }, h("b", null, "No matching files"), `No changed files match "${filter}".`) : null,
					!q && nothing && (!cmp || !cmp.ok || cmp.files.length === 0) ? h("div", { className: "gv-empty" }, h("b", null, "No changes on this branch"), `This worktree is clean${cmp && cmp.ok ? ` and the branch has no changes ahead of ${cmp.baseRef}` : ""}.`) : null,
					L.conflict.length ? h(Section, { id: "conflicts", title: "Conflicts", count: L.conflict.length, sub: `${st.conflicts.length} conflict${st.conflicts.length === 1 ? "" : "s"}`, collapsed: !!prefs.collapsed.conflicts, onToggle: () => toggleSection("conflicts") }, renderList(L.conflict, "conflict", "conflict")) : null,
					L.unstaged.length ? h(Section, { id: "unstaged", title: "Changes", count: L.unstaged.length, collapsed: !!prefs.collapsed.unstaged, onToggle: () => toggleSection("unstaged"), actions: secActs(L.unstaged, "unstaged", "Changes") }, renderList(L.unstaged, "unstaged", "unstaged")) : null,
					L.staged.length ? h(Section, { id: "staged", title: "Staged Changes", count: L.staged.length, collapsed: !!prefs.collapsed.staged, onToggle: () => toggleSection("staged"), actions: secActs(L.staged, "staged", "Staged Changes") }, renderList(L.staged, "staged", "staged")) : null,
					L.untracked.length ? h(Section, { id: "untracked", title: "Untracked Files", count: L.untracked.length, collapsed: !!prefs.collapsed.untracked, onToggle: () => toggleSection("untracked"), actions: secActs(L.untracked, "untracked", "Untracked Files") }, renderList(L.untracked, "untracked", "untracked")) : null,
					cmp && !cmp.ok ? h("div", { className: "gv-banner" }, h("b", null, "Branch compare unavailable"), cmp.error || "", h("button", { className: "gv-link", style: { alignSelf: "flex-start" }, onClick: refresh }, "Retry")) : null,
					cmp && cmp.ok && L.branch.length ? h(Section, {
						id: "branch", title: "Committed on Branch", count: L.branch.length, collapsed: !!prefs.collapsed.branch, onToggle: () => toggleSection("branch"),
						actions: h("button", { className: "gv-btn", title: `${cmp.files.length} files changed vs ${cmp.baseRef}`, onClick: () => openAll("branch", L.branch, `vs ${cmp.baseRef}`) }, h(Icon, { name: "rows" }), "View all"),
					}, prefs.view === "tree"
						? h(TreeList, { files: L.branch, area: "branch", onOpen: openFile("branch"), collapsedDirs, toggleDir })
						: L.branch.map((f) => h(FileRow, { key: "b" + f.path, f, area: "branch", treeMode: false, onOpen: openFile("branch") }))) : null,
					!st.branch.unborn ? h(History, {
						params, branchOid: st.branch.oid, collapsed: histCollapsed, onToggle: () => setHistCollapsed((c) => !c),
						onOpenCommitFile: (c, f, all) => setView({ mode: "file", scope: "commit", sha: c.sha, file: f, siblings: all }),
					}) : null);
			}

			return h("div", { className: "gv " + (dark ? "dark" : "light"), "data-gv": "root" },
				h("style", null, CSS),
				header,
				error && snap ? h("div", { className: "gv-banner warn" }, "Connection problem: " + error) : null,
				h("div", { className: "gv-body" }, body));
		}

		// =====================================================================================
		// Registration
		// =====================================================================================

		function GitIcon({ size }) {
			return h(Icon, { name: "branch", size: size || 16 });
		}

		const inject = ["slots", "sidebarRightTabs"];

		function apply(ctx) {
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				title: () => "Git",
				guide: [{
					id: "git", order: 40,
					title: () => "Git",
					description: () => "Branch or worktree, changes and diffs for this session",
					icon: GitIcon,
				}],
			}), "git-view: tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
				{ name: "sidebar.right.pane.tab", key: TAB_ID }, GitTab)), "git-view: tab body");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register(
				{ name: "sidebar.right.pane.tab.title", key: TAB_ID }, function GitTitle(p) {
					const info = p.useTabInfo ? p.useTabInfo() : undefined;
					return h(React.Fragment, null, h(Icon, { name: "branch", size: 14 }), " ", info && info.tab ? info.tab.title : "Git");
				})), "git-view: tab title");
		}

		exports.inject = inject;
		exports.apply = apply;
		exports.GitTab = GitTab;
		exports.__test = { parseUnifiedDiff, intraline, segmentHunk, pairRows, buildTree, relTime, cleanRef, filePlaceholder, CSS };
		return module.exports;
	}
});
