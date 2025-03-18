import React from "react";
import { createRoot, Root } from "react-dom/client";
import { ItemView, WorkspaceLeaf } from "obsidian";
import OcclusionEditor from "./OcclusionEditor";
import MyPlugin from "../../main";

export const VIEW_TYPE_OCCLUSION_REACT = "occlusion-react-view";

export class ReactOcclusionView extends ItemView {
	plugin: MyPlugin;
	reactComponent: React.ReactNode;
	rootEl: HTMLElement;
	root: Root | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_OCCLUSION_REACT;
	}

	getDisplayText(): string {
		return "Occlusion Editor";
	}

	getIcon(): string {
		return "image-file";
	}

	async onOpen() {
		// Create the root element for React
		this.rootEl = this.contentEl.createDiv({
			cls: "occlusion-react-container h-full",
		});

		// Render the React component
		this.renderReact();
	}

	async onClose() {
		// Clean up React on close
		if (this.root) {
			this.root.unmount();
		}
	}

	// Method to set the selected file programmatically
	setSelectedFile(filePath: string): void {
		// This would need a more elaborate state management solution
		// For now, we'll re-render the component with the selected file
		this.renderReact(filePath);
	}

	private renderReact(selectedFilePath?: string) {
		if (!this.root) {
			this.root = createRoot(this.rootEl);
		}

		this.root.render(
			<OcclusionEditor
				plugin={this.plugin}
				onClose={() => this.leaf.detach()}
				selectedFilePath={selectedFilePath}
			/>
		);
	}
}
