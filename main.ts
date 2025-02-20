import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// Ribbon icon example
		const ribbonIconEl = this.addRibbonIcon("dice", "Sample Plugin", () => {
			new Notice("Looks a!");
		});
		ribbonIconEl.addClass("my-plugin-ribbon-class");

		// Status bar example
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Status Bar Text");

		// Adds a simple command
		this.addCommand({
			id: "open-sample-modal-simple",
			name: "Open sample modal (simple)",
			callback: () => {
				new SampleModal(this.app).open();
			},
		});

		// Adds an editor command
		this.addCommand({
			id: "sample-editor-command",
			name: "Sample editor command",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection("Sample Editor Command");
			},
		});

		// Adds a complex command
		this.addCommand({
			id: "open-sample-modal-complex",
			name: "Open sample modal (complex)",
			checkCallback: (checking: boolean) => {
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) {
						new SampleModal(this.app).open();
					}
					return true;
				}
			},
		});

		// Adds a settings tab
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// Register a global DOM event
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			console.log("click", evt);
		});

		// Register an interval
		this.registerInterval(
			window.setInterval(() => console.log("setInterval"), 5 * 60 * 1000)
		);

		// --- Toggle Hidden Content Markdown Post-Processor ---
		this.registerMarkdownPostProcessor((element, context) => {
			// (1) Hide {{...}} text by walking text nodes, skipping KaTeX nodes
			hideCustomBracesText(element);

			// (2) Wrap all math elements (covers both inline and display)
			const mathEls = element.querySelectorAll(".math");
			mathEls.forEach((mathEl) => wrapMathElement(mathEl));
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText("Woah!");
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Setting #1")
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder("Enter your secret")
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

/**
 * Walk the DOM text nodes (excluding KaTeX sections) and replace `{{...}}` with
 * clickable "hidden text" spans for NON-math content.
 */
function hideCustomBracesText(rootEl: HTMLElement) {
	const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			// If the node's parent is inside a KaTeX container, skip it
			if (isInsideMath(node.parentElement)) {
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	const textNodes: Text[] = [];
	while (walker.nextNode()) {
		textNodes.push(walker.currentNode as Text);
	}

	// Regex to match {{...}} with non-greedy capture
	const braceRegex = /\{\{(.*?)\}\}/g;

	for (const textNode of textNodes) {
		const nodeText = textNode.nodeValue;
		if (!nodeText) continue;

		let match;
		let lastIndex = 0;
		const fragments: (string | Node)[] = [];

		// Find all {{...}} matches
		while ((match = braceRegex.exec(nodeText)) !== null) {
			const startIndex = match.index;
			const endIndex = startIndex + match[0].length;
			const contentInside = match[1]; // text between {{ and }}

			// Push the text before the match
			if (startIndex > lastIndex) {
				fragments.push(nodeText.slice(lastIndex, startIndex));
			}

			// Create the hidden text span
			const span = createHiddenTextSpan(contentInside);
			fragments.push(span);

			lastIndex = endIndex;
		}

		// If we had matches or leftover text after the last match,
		// we need to replace the text node with new fragments
		if (lastIndex > 0) {
			// Push any leftover text after the last match
			if (lastIndex < nodeText.length) {
				fragments.push(nodeText.slice(lastIndex));
			}

			// Replace the original text node with fragments
			const parent = textNode.parentNode;
			if (parent) {
				fragments.forEach((frag) => {
					if (typeof frag === "string") {
						parent.insertBefore(
							document.createTextNode(frag),
							textNode
						);
					} else {
						parent.insertBefore(frag, textNode);
					}
				});
				parent.removeChild(textNode);
			}
		}
	}
}

/**
 * Check if an element (or its ancestors) has a KaTeX-related class
 */
function isInsideMath(el: HTMLElement | null): boolean {
	if (!el) return false;
	if (
		el.classList &&
		(el.classList.contains("math") ||
			el.classList.contains("toggle-hidden-math-wrapper"))
	) {
		return true;
	}
	return isInsideMath(el.parentElement);
}

/**
 * Create a span that hides the original content, showing `[hidden]` initially.
 */
function createHiddenTextSpan(originalContent: string): HTMLSpanElement {
	const span = document.createElement("span");
	span.className = "toggle-hidden-text";
	span.setAttribute("data-original", originalContent);
	span.setAttribute("data-hidden", "true");
	span.style.cursor = "pointer";
	span.style.color = "gray";
	span.style.textDecoration = "underline";

	// Instead of a dash placeholder, we show "[hidden]"
	span.textContent = "[hidden]";

	// On click, toggle between hidden and revealed
	span.addEventListener("click", () => {
		const isHidden = span.getAttribute("data-hidden") === "true";
		if (isHidden) {
			// Reveal
			span.innerHTML = `<span class="bracket" style="color: gray;">[</span>
				<span class="revealed-text">${originalContent}</span>
				<span class="bracket" style="color: gray;">]</span>`;
			span.setAttribute("data-hidden", "false");
			span.style.textDecoration = "";
			span.style.color = "";
		} else {
			// Hide again
			span.textContent = "[hidden]";
			span.setAttribute("data-hidden", "true");
			span.style.color = "gray";
		}
	});

	return span;
}

/**
 * Wrap an inline or display math element in a toggle-hidden-math-wrapper
 * and remove any surrounding `{{ }}` braces so they don't appear in the final display.
 * Uses "[hidden]" for the placeholder as well.
 */
function wrapMathElement(mathEl: Element) {
	// If it's already wrapped, skip
	const parent = mathEl.parentElement;
	if (!parent || parent.classList.contains("toggle-hidden-math-wrapper")) {
		return;
	}

	// (1) Remove visible `{{ }}` around the math (if present)
	let foundBraces = false;

	// Check previous sibling for trailing `{{`
	const prevSibling = mathEl.previousSibling;
	if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
		const txt = prevSibling.nodeValue ?? "";
		// e.g. "some text {{" or just "{{"
		const match = txt.match(/^(.*)\{\{\s*$/);
		if (match) {
			prevSibling.nodeValue = match[1]; // remove braces portion
			foundBraces = true;
		}
	}

	// Check next sibling for leading `}}`
	const nextSibling = mathEl.nextSibling;
	if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
		const txt = nextSibling.nodeValue ?? "";
		// e.g. "}} more text" or just "}}"
		const match = txt.match(/^\s*\}\}(.*)$/);
		if (match) {
			nextSibling.nodeValue = match[1]; // remove braces portion
			foundBraces = true;
		}
	}

	// (2) Proceed with normal math wrapping
	const isDisplay = mathEl.classList.contains("math-display");
	// For block math, use <div>; for inline math, use <span>.
	const wrapperTag = isDisplay ? "div" : "span";

	const wrapper = document.createElement(wrapperTag);
	wrapper.className = "toggle-hidden-math-wrapper";
	wrapper.setAttribute("data-hidden", "true");
	wrapper.style.cursor = "pointer";

	parent.insertBefore(wrapper, mathEl);

	// CREATE THE PLACEHOLDER (shown initially): "[hidden]"
	const placeholder = document.createElement(wrapperTag);
	placeholder.className = "toggle-hidden-math-placeholder";
	placeholder.style.cursor = "pointer";
	placeholder.innerHTML = `<span style="color: gray;">[hidden]</span>`;

	// CREATE A "REVEALED" CONTAINER with greyed-out brackets around the math
	const revealedContainer = document.createElement(wrapperTag);
	revealedContainer.className = "toggle-hidden-math-revealed";

	// Use a small space after '[' and before ']' to create a gap:
	const leftBracket = document.createElement("span");
	leftBracket.className = "bracket";
	leftBracket.style.color = "gray";
	leftBracket.textContent = "[ ";

	const rightBracket = document.createElement("span");
	rightBracket.className = "bracket";
	rightBracket.style.color = "gray";
	rightBracket.textContent = " ]";

	// Place the math in between these two brackets
	revealedContainer.appendChild(leftBracket);
	revealedContainer.appendChild(mathEl);
	revealedContainer.appendChild(rightBracket);

	// Hide the revealed container by default (show placeholder)
	revealedContainer.style.display = "none";

	// Append both states to the wrapper
	wrapper.appendChild(placeholder);
	wrapper.appendChild(revealedContainer);

	// (3) Toggle on click
	wrapper.addEventListener("click", () => {
		const isHidden = wrapper.getAttribute("data-hidden") === "true";
		if (isHidden) {
			// Reveal
			placeholder.style.display = "none";
			revealedContainer.style.display = "";
			wrapper.setAttribute("data-hidden", "false");
		} else {
			// Hide
			placeholder.style.display = "";
			revealedContainer.style.display = "none";
			wrapper.setAttribute("data-hidden", "true");
		}
	});
}
