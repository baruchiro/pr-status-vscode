(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById("root");
	const footer = document.getElementById("footer");
	const saved = vscode.getState() || {};
	let state = saved.state;
	const expanded = new Set(saved.expanded || []);
	let timeEl;
	let updated = 0;

	function save() {
		vscode.setState({ state, expanded: [...expanded] });
	}

	function send(msg) {
		vscode.postMessage(msg);
	}

	function el(tag, className, text) {
		const e = document.createElement(tag);
		if (className) {
			e.className = className;
		}
		if (text !== undefined) {
			e.textContent = text;
		}
		return e;
	}

	function icon(name) {
		const i = el("i", "codicon codicon-" + name);
		i.setAttribute("aria-hidden", "true");
		return i;
	}

	function button(text, className, focusId, onClick) {
		const b = el("button", className, text);
		b.type = "button";
		b.dataset.focus = focusId;
		b.addEventListener("click", onClick);
		return b;
	}

	function pill(label, tone, extraClass) {
		return el("span", "pill tone-" + tone + (extraClass ? " " + extraClass : ""), label);
	}

	function keyOf(pr) {
		return pr.repo + "#" + pr.number;
	}

	function titleOf(pr, className) {
		const t = el("span", className);
		t.append(el("span", "num", "#" + pr.number), " " + pr.title);
		return t;
	}

	function actions(pr, focusId) {
		const row = el("div", "actions");
		row.append(button("Open PR", "btn primary", focusId + "\nopen", () => send({ type: "open", url: pr.url })));
		if (pr.reviewOrder === "stale") {
			const stale = el("span", "btn secondary stale", "Review order (stale)");
			stale.setAttribute("aria-disabled", "true");
			stale.title = "The review order is out of date for the latest commits";
			row.append(stale);
		} else if (pr.reviewOrder) {
			row.append(button("Review order", "btn secondary", focusId + "\nreview", () => send({ type: "open", url: pr.reviewOrder })));
		}
		return row;
	}

	function metaPills(pr) {
		const pills = [];
		if (pr.phase === "draft") {
			pills.push(pill("Draft", "neutral", "meta"));
		}
		pills.push(pill(pr.repo + " → " + pr.base, "neutral", "meta"));
		return pills;
	}

	function localPill(text) {
		const p = el("span", "pill tone-purple");
		p.title = text;
		p.append(icon("sync"), "Local changes");
		return p;
	}

	function heading(text) {
		return el("h2", "heading", text);
	}

	function nextCard() {
		const group = el("section", "group");
		group.append(heading("Next for you"));
		const card = el("article", "card");
		const next = state.next;
		const section = next && state.sections.find(s => s.folder === next.folder);
		const pr = section && section.prs.find(p => keyOf(p) === next.key);
		if (pr) {
			const title = el("h3", "card-title");
			title.append(el("span", "num", "#" + pr.number), " " + pr.title);
			const pills = el("div", "pills");
			pills.append(pill(pr.pill.label, pr.pill.tone), ...metaPills(pr));
			card.append(title, pills);
			if (pr.hint) {
				card.append(el("div", "hint", pr.hint));
			}
			card.append(actions(pr, "next\n" + next.folder + "\n" + next.key));
		} else {
			card.classList.add("idle");
			card.append(el("h3", "card-title", "Nothing needs you"));
			const upNext = state.sections.flatMap(s => s.prs).find(p => p.next !== "none");
			if (upNext) {
				card.append(el("div", "hint", "Up next: #" + upNext.number + " " + upNext.title + " — " + upNext.pill.label));
			}
		}
		group.append(card);
		return group;
	}

	function sectionList(section, sectionIndex) {
		const group = el("section", "group");
		const h = heading("Review order · " + section.prs.length);
		if (section.label) {
			const label = el("span", "label", section.label);
			label.title = section.folder;
			h.append(label);
		}
		group.append(h);
		if (section.error) {
			const error = el("div", "error");
			error.append(icon("warning"), el("span", undefined, section.error));
			group.append(error);
		}
		const list = el("ol", "list");
		section.prs.forEach((pr, i) => {
			const id = section.folder + "\n" + keyOf(pr);
			const item = el("li", "item");
			if (pr.state === "MERGED" || pr.state === "CLOSED") {
				item.classList.add("done");
			}
			if (state.next && state.next.folder === section.folder && state.next.key === keyOf(pr)) {
				item.classList.add("next");
			}
			const details = el("div", "details");
			details.id = "details-" + sectionIndex + "-" + i;
			details.hidden = !expanded.has(id);
			if (pr.hint) {
				details.append(el("div", "hint", pr.hint));
			}
			const pills = el("div", "pills");
			pills.append(...metaPills(pr));
			details.append(pills, actions(pr, id));

			const row = button("", "row", id, () => {
				const open = details.hidden;
				details.hidden = !open;
				row.setAttribute("aria-expanded", String(open));
				if (open) {
					expanded.add(id);
				} else {
					expanded.delete(id);
				}
				save();
			});
			row.setAttribute("aria-expanded", String(!details.hidden));
			row.setAttribute("aria-controls", details.id);
			const pos = el("span", "pos", String(i + 1));
			pos.setAttribute("aria-hidden", "true");
			row.append(pos, titleOf(pr, "title"));
			if (pr.local) {
				row.append(localPill(pr.local));
			}
			row.append(pill(pr.pill.label, pr.pill.tone));
			row.title = "#" + pr.number + " " + pr.title;

			item.append(row, details);
			list.append(item);
		});
		group.append(list);
		return group;
	}

	function link(text, msg) {
		return button(text, "link", "footer\n" + msg.type, () => send(msg));
	}

	function renderFooter() {
		footer.replaceChildren();
		timeEl = undefined;
		const refresh = state.refresh;
		if (refresh.scriptMissing) {
			footer.append("Auto refresh off: skill not found · ", link("Install skill", { type: "installSkill" }), " · ", link("Settings", { type: "openSettings" }));
		} else if (refresh.error) {
			const error = el("span", "error");
			error.append(icon("warning"), " " + refresh.error);
			footer.append(error, " · ", link("Retry", { type: "refresh" }));
		} else {
			timeEl = el("span");
			footer.append(timeEl);
			tick();
		}
	}

	function ago(ms) {
		const minutes = Math.floor(Math.max(0, ms) / 60000);
		if (minutes < 1) {
			return "just now";
		}
		if (minutes < 60) {
			return minutes + "m ago";
		}
		const hours = Math.floor(minutes / 60);
		return hours < 24 ? hours + "h ago" : Math.floor(hours / 24) + "d ago";
	}

	function countdown(ms) {
		const seconds = Math.max(0, Math.ceil(ms / 1000));
		return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
	}

	function tick() {
		if (!timeEl) {
			return;
		}
		const now = Date.now();
		const parts = [];
		if (updated) {
			parts.push("Updated " + ago(now - updated));
		}
		if (state.refresh.nextRun) {
			parts.push("next check in " + countdown(new Date(state.refresh.nextRun).getTime() - now));
		}
		timeEl.textContent = parts.join(" · ");
	}

	function render() {
		if (!state) {
			return;
		}
		const active = document.activeElement;
		const focused = active instanceof HTMLElement ? active.dataset.focus : undefined;
		updated = Math.max(0, ...state.sections.map(s => Date.parse(s.generatedAt)).filter(t => !isNaN(t)));
		root.replaceChildren(nextCard(), ...state.sections.map(sectionList));
		renderFooter();
		if (focused) {
			const target = [...document.querySelectorAll("[data-focus]")].find(e => e instanceof HTMLElement && e.dataset.focus === focused);
			if (target instanceof HTMLElement) {
				target.focus();
			}
		}
	}

	window.addEventListener("message", event => {
		if (event.data && event.data.type === "state") {
			state = event.data;
			save();
			render();
		}
	});

	render();
	setInterval(tick, 1000);
	send({ type: "ready" });
})();
