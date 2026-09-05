/**
 * Model Costs — pricing-aware model picker.
 *
 * The built-in /model selector does not show pricing. This extension adds:
 *
 *   /model-cost [query]  — model picker with $/1M-token pricing, context
 *                          window, cache rates, tiers and reasoning support.
 *                          Same flow as /model: arrows to navigate, type to
 *                          fuzzy-filter, Tab toggles all/scoped (when scoped
 *                          models are configured), Enter selects, Esc cancels.
 *
 *   Footer status        — pricing of the currently active model
 *                          (set SHOW_STATUS = false below to disable).
 */

import type { Api, Model, ModelCostTier, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, fuzzyFilter, Input, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

const SHOW_STATUS = true;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function trimZeros(s: string): string {
	return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Cost rates are USD per 1M tokens. */
function money(n: number): string {
	if (n === 0) return "0";
	if (n >= 100) return n.toFixed(0);
	if (n >= 1) return trimZeros(n.toFixed(2));
	return trimZeros(n.toFixed(3));
}

function tokens(n: number): string {
	if (n >= 1_000_000) return `${trimZeros((n / 1_000_000).toFixed(1))}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return `${n}`;
}

function isFree(model: Model<Api>): boolean {
	const c = model.cost;
	return c.input === 0 && c.output === 0 && c.cacheRead === 0 && c.cacheWrite === 0 && !c.tiers?.length;
}

/** Compact "$in/$out" used in list rows. */
function compactCost(model: Model<Api>): string {
	if (isFree(model)) return "free";
	return `$${money(model.cost.input)}/$${money(model.cost.output)}`;
}

function sameModel(a: Model<Api> | undefined, b: Model<Api>): boolean {
	return !!a && a.provider === b.provider && a.id === b.id;
}

// ---------------------------------------------------------------------------
// Picker component
// ---------------------------------------------------------------------------

interface ModelItem {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

interface Picked {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

type SortMode = "default" | "input-asc" | "input-desc" | "output-asc" | "output-desc" | "total-asc" | "total-desc";

const SORT_ORDER: SortMode[] = ["default", "input-asc", "input-desc", "output-asc", "output-desc", "total-asc", "total-desc"];

function sortLabel(mode: SortMode): string {
	switch (mode) {
		case "input-asc": return "in↑";
		case "input-desc": return "in↓";
		case "output-asc": return "out↑";
		case "output-desc": return "out↓";
		case "total-asc": return "total↑";
		case "total-desc": return "total↓";
		default: return "default";
	}
}

class ModelCostPicker extends Container implements Focusable {
	private searchInput = new Input();
	private listContainer = new Container();
	private detailContainer = new Container();

	// Focusable: propagate focus to the embedded input for IME positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private allItems: ModelItem[];
	private scopedItems: ModelItem[];
	private activeItems: ModelItem[];
	private filtered: ModelItem[];
	private selectedIndex = 0;
	private scope: "all" | "scoped";
	private scopeText: Text | undefined;
	private sortMode: SortMode = "default";
	private footerText!: Text;

	constructor(
		private tui: import("@earendil-works/pi-tui").TUI,
		private theme: Theme,
		private currentModel: Model<Api> | undefined,
		scopedModels: readonly { model: Model<Api>; thinkingLevel?: ThinkingLevel }[],
		availableModels: readonly Model<Api>[],
		initialQuery: string | undefined,
		private done: (value: Picked | null) => void,
	) {
		super();

		this.allItems = this.sortItems(availableModels.map((model) => ({ model })));
		this.scopedItems = this.sortItems([...scopedModels]);
		this.scope = this.scopedItems.length > 0 ? "scoped" : "all";
		this.activeItems = this.scope === "scoped" ? this.scopedItems : this.allItems;
		this.filtered = this.activeItems;

		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		if (this.scopedItems.length > 0) {
			this.scopeText = new Text(this.renderScopeText(), 0, 0);
			this.addChild(this.scopeText);
		} else {
			this.addChild(
				new Text(theme.fg("muted", "  Only configured providers are shown. Use /login to add more."), 0, 0),
			);
		}

		this.searchInput.onSubmit = () => {
			const item = this.filtered[this.selectedIndex];
			if (item) this.select(item);
		};
		if (initialQuery) this.searchInput.setValue(initialQuery);
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.addChild(this.listContainer);
		this.addChild(this.detailContainer);

		this.addChild(new Spacer(1));
		this.footerText = new Text(this.renderFooter(), 0, 0);
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		const currentIndex = this.activeItems.findIndex((item) => sameModel(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.applyFilter(initialQuery ?? "");
	}

	private compareItems(a: ModelItem, b: ModelItem): number {
		// ponytail: pin current-model on top only in default mode; cost sorts rank it purely
		if (this.sortMode === "default") {
			const aCurrent = sameModel(this.currentModel, a.model);
			const bCurrent = sameModel(this.currentModel, b.model);
			if (aCurrent && !bCurrent) return -1;
			if (!aCurrent && bCurrent) return 1;
		}
		const dir = this.sortMode.endsWith("desc") ? -1 : 1;
		let diff = 0;
		if (this.sortMode.startsWith("input")) diff = a.model.cost.input - b.model.cost.input;
		else if (this.sortMode.startsWith("output")) diff = a.model.cost.output - b.model.cost.output;
		else if (this.sortMode.startsWith("total")) diff = (a.model.cost.input + a.model.cost.output) - (b.model.cost.input + b.model.cost.output);
		if (diff !== 0) return diff * dir;
		const byProvider = a.model.provider.localeCompare(b.model.provider);
		return byProvider !== 0 ? byProvider : a.model.id.localeCompare(b.model.id);
	}

	private sortItems(items: ModelItem[]): ModelItem[] {
		return [...items].sort((a, b) => this.compareItems(a, b));
	}

	private renderFooter(): string {
		return this.theme.fg("dim", `  ↑↓ navigate · Enter select · Esc cancel · ctrl+s sort (${sortLabel(this.sortMode)}) · prices per 1M tokens`);
	}

	private cycleSort(): void {
		this.sortMode = SORT_ORDER[(SORT_ORDER.indexOf(this.sortMode) + 1) % SORT_ORDER.length] as SortMode;
		// ponytail: re-sort cached lists in place, full re-query if model count grows large
		this.allItems = this.sortItems(this.allItems);
		this.scopedItems = this.sortItems(this.scopedItems);
		this.activeItems = this.scope === "scoped" ? this.scopedItems : this.allItems;
		this.footerText.setText(this.renderFooter());
		this.applyFilter(this.searchInput.getValue());
		// ponytail: jump selection to current model so it stays visible after re-sort
		const curIdx = this.filtered.findIndex((item) => sameModel(this.currentModel, item.model));
		this.selectedIndex = curIdx >= 0 ? curIdx : 0;
		this.updateList();
	}

	private renderScopeText(): string {
		const all = this.scope === "all" ? this.theme.fg("accent", "all") : this.theme.fg("muted", "all");
		const scoped = this.scope === "scoped" ? this.theme.fg("accent", "scoped") : this.theme.fg("muted", "scoped");
		return `${this.theme.fg("muted", "  Scope: ")}${all}${this.theme.fg("muted", " | ")}${scoped}${this.theme.fg("dim", "  (Tab to toggle)")}`;
	}

	private applyFilter(query: string): void {
		if (query) {
			this.filtered = fuzzyFilter(this.activeItems, query, (item) =>
				`${item.model.provider}/${item.model.id} ${item.model.name} ${compactCost(item.model)}`,
			);
			this.selectedIndex = 0;
		} else {
			this.filtered = this.activeItems;
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		}
		this.updateList();
	}

	private updateList(): void {
		const theme = this.theme;
		this.listContainer.clear();
		this.detailContainer.clear();

		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filtered[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const isCurrent = sameModel(this.currentModel, item.model);

			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const idText = isSelected ? theme.fg("accent", item.model.id) : item.model.id;
			const providerBadge = theme.fg("muted", ` [${item.model.provider}]`);
			const cost = isFree(item.model)
				? theme.fg("success", "free")
				: theme.fg("warning", `$${money(item.model.cost.input)}/$${money(item.model.cost.output)}`);
			const ctx = theme.fg("dim", ` · ${tokens(item.model.contextWindow)} ctx`);
			const check = isCurrent ? theme.fg("success", " ✓") : "";

			this.listContainer.addChild(new Text(`${prefix}${idText}${providerBadge} ${cost}${ctx}${check}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filtered.length) {
			this.listContainer.addChild(
				new Text(theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
			);
		}

		this.renderDetails(this.filtered[this.selectedIndex]?.model);
	}

	private renderDetails(model: Model<Api> | undefined): void {
		if (!model) return;
		const theme = this.theme;
		const c = model.cost;

		this.detailContainer.addChild(new Spacer(1));

		if (isFree(model)) {
			this.detailContainer.addChild(new Text(theme.fg("success", `  free — no per-token cost`), 0, 0));
		} else {
			let line = `  ${theme.fg("warning", `$${money(c.input)}`)} in · ${theme.fg("warning", `$${money(c.output)}`)} out`;
			if (c.cacheRead > 0 || c.cacheWrite > 0) {
				line += theme.fg("muted", ` · cache $${money(c.cacheRead)} read / $${money(c.cacheWrite)} write`);
			}
			this.detailContainer.addChild(new Text(line, 0, 0));

			for (const tier of c.tiers ?? []) {
				this.detailContainer.addChild(
					new Text(
						theme.fg(
							"muted",
							`  above ${tokens((tier as ModelCostTier).inputTokensAbove)} input tok: $${money(tier.input)}/$${money(tier.output)} · cache $${money(tier.cacheRead)}/$${money(tier.cacheWrite)}`,
						),
						0,
						0,
					),
				);
			}
		}

		const tags: string[] = [];
		if (model.reasoning) tags.push("reasoning");
		tags.push(model.input.includes("image") ? "text+image" : "text");
		this.detailContainer.addChild(
			new Text(
				theme.fg(
					"muted",
					`  ${model.name} · ${tokens(model.contextWindow)} ctx · ${tokens(model.maxTokens)} max out · ${tags.join(" · ")}`,
				),
				0,
				0,
			),
		);
	}

	private select(item: ModelItem): void {
		this.done({ model: item.model, thinkingLevel: item.thinkingLevel });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab") && this.scopedItems.length > 0) {
			this.scope = this.scope === "all" ? "scoped" : "all";
			this.activeItems = this.scope === "scoped" ? this.scopedItems : this.allItems;
			const currentIndex = this.activeItems.findIndex((item) => sameModel(this.currentModel, item.model));
			this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
			if (this.scopeText) this.scopeText.setText(this.renderScopeText());
			this.applyFilter(this.searchInput.getValue());
		} else if (matchesKey(data, "ctrl+s")) {
			this.cycleSort();
		} else if (matchesKey(data, "up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (matchesKey(data, "down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (matchesKey(data, "return")) {
			const item = this.filtered[this.selectedIndex];
			if (item) this.select(item);
			return;
		} else if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		} else {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const statusText = (model: Model<Api> | undefined): string | undefined => {
		if (!model) return undefined;
		if (isFree(model)) return `${model.id} · free`;
		return `${model.id} · $${money(model.cost.input)}/$${money(model.cost.output)} per 1M`;
	};

	if (SHOW_STATUS) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.setStatus("model-costs", statusText(ctx.model));
		});

		pi.on("model_select", async (event, ctx) => {
			ctx.ui.setStatus("model-costs", statusText(event.model));
		});
	}

	pi.registerCommand("model-cost", {
		description: "Select a model with per-1M-token pricing, context window and cache rates",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/model-cost is only available in interactive mode", "warning");
				return;
			}

			const models = ctx.modelRegistry.getAvailable();
			if (models.length === 0) {
				ctx.ui.notify("No models available — check /login", "warning");
				return;
			}

			const query = args.trim() || undefined;
			const picked = await ctx.ui.custom<Picked | null>((tui, theme, _kb, done) =>
				new ModelCostPicker(tui, theme, ctx.model, ctx.scopedModels, models, query, done),
			);

			if (!picked) return;

			const success = await pi.setModel(picked.model);
			if (!success) {
				ctx.ui.notify(`No API key configured for provider "${picked.model.provider}"`, "error");
				return;
			}
			if (picked.thinkingLevel) {
				pi.setThinkingLevel(picked.thinkingLevel);
			}

			const c = picked.model.cost;
			ctx.ui.notify(
				isFree(picked.model)
					? `${picked.model.id} — free`
					: `${picked.model.id} — $${money(c.input)} in / $${money(c.output)} out per 1M tokens`,
				"info",
			);
		},
	});
}
