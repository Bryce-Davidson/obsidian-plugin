import { Plugin, Notice, TFile, WorkspaceLeaf, ItemView } from "obsidian";
import Konva from "konva";
import MyPlugin from "./main"; // Import the main plugin class
import { OcclusionShape, OcclusionData } from "./main"; // Import the interfaces from main.ts

export const VIEW_TYPE_OCCLUSION = "occlusion-view";

export class OcclusionView extends ItemView {
	plugin: MyPlugin; // Change the type to MyPlugin

	containerEl: HTMLElement;
	fileSelectEl: HTMLSelectElement;
	addRectButton: HTMLButtonElement;
	deleteButton: HTMLButtonElement;
	saveButton: HTMLButtonElement;
	konvaContainer: HTMLDivElement;
	colorInput: HTMLInputElement;
	widthInput: HTMLInputElement;
	heightInput: HTMLInputElement;
	controlsDiv: HTMLElement;
	modeToggleButton: HTMLButtonElement;
	resizeObserver: ResizeObserver;

	stage: Konva.Stage;
	imageLayer: Konva.Layer;
	shapeLayer: Konva.Layer;
	transformer: Konva.Transformer;

	selectedRect: Konva.Rect | null = null;
	reviewMode: boolean = false;

	// New zoom properties
	currentScale: number = 1;
	initialScale: number = 1;

	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_OCCLUSION;
	}

	getDisplayText(): string {
		return "Occlusion Editor";
	}

	getIcon(): string {
		return "image-file";
	}

	async onOpen() {
		this.containerEl = this.contentEl.createDiv("occlusion-editor");
		this.containerEl.style.display = "flex";
		this.containerEl.style.flexDirection = "column";
		this.containerEl.style.height = "100%";

		// Create a fixed toolbar for controls.
		const toolbarEl = this.containerEl.createDiv("toolbar");
		toolbarEl.style.position = "sticky";
		toolbarEl.style.top = "0";
		toolbarEl.style.zIndex = "1000";
		toolbarEl.style.background = "rgba(255,255,255,0.9)";
		toolbarEl.style.padding = "10px";
		toolbarEl.style.border = "1px solid #ccc";
		toolbarEl.style.display = "flex";
		toolbarEl.style.flexWrap = "wrap";
		toolbarEl.style.gap = "10px";
		toolbarEl.style.flexShrink = "0";

		// File selector control.
		this.fileSelectEl = toolbarEl.createEl("select") as HTMLSelectElement;
		const files = this.plugin.app.vault.getFiles();
		const imageFiles = files.filter((f) =>
			f.extension.match(/(png|jpe?g|gif)/i)
		);
		imageFiles.forEach((f: TFile) => {
			const option = this.fileSelectEl.createEl("option", {
				text: f.path,
			}) as HTMLOptionElement;
			option.value = f.path;
		});
		this.fileSelectEl.onchange = () => {
			this.loadImage(this.fileSelectEl.value);
		};

		// Mode toggle button.
		this.modeToggleButton = toolbarEl.createEl("button", {
			text: "Switch to Review Mode",
		});
		this.modeToggleButton.onclick = () => this.toggleReviewMode();

		// Add zoom controls to the toolbar.
		const zoomInButton = toolbarEl.createEl("button", { text: "Zoom In" });
		const zoomOutButton = toolbarEl.createEl("button", {
			text: "Zoom Out",
		});
		const resetZoomButton = toolbarEl.createEl("button", {
			text: "Reset Zoom",
		});

		zoomInButton.onclick = () => {
			this.currentScale *= 1.1;
			this.stage.scale({ x: this.currentScale, y: this.currentScale });
			this.stage.draw();
		};

		zoomOutButton.onclick = () => {
			this.currentScale *= 0.9;
			this.stage.scale({ x: this.currentScale, y: this.currentScale });
			this.stage.draw();
		};

		resetZoomButton.onclick = () => {
			this.currentScale = this.initialScale;
			this.stage.scale({ x: this.currentScale, y: this.currentScale });
			this.stage.draw();
		};

		// Create a sub-container for additional controls.
		this.controlsDiv = toolbarEl.createDiv("controls");

		// Color input.
		this.colorInput = this.controlsDiv.createEl("input", { type: "color" });
		this.colorInput.onchange = (e: Event) => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.fill((e.target as HTMLInputElement).value);
				this.shapeLayer.draw();
			}
		};

		// Width input.
		this.widthInput = this.controlsDiv.createEl("input", {
			type: "number",
			value: "100",
			attr: { placeholder: "Width" },
		});
		this.widthInput.onchange = () => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.width(parseFloat(this.widthInput.value));
				this.shapeLayer.draw();
			}
		};

		// Height input.
		this.heightInput = this.controlsDiv.createEl("input", {
			type: "number",
			value: "100",
			attr: { placeholder: "Height" },
		});
		this.heightInput.onchange = () => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.height(parseFloat(this.heightInput.value));
				this.shapeLayer.draw();
			}
		};

		// Add occlusion button.
		this.addRectButton = toolbarEl.createEl("button", {
			text: "Add Occlusion",
		}) as HTMLButtonElement;
		this.addRectButton.onclick = () => this.addRectangle();

		// Delete occlusion button.
		this.deleteButton = toolbarEl.createEl("button", {
			text: "Delete Occlusion",
		}) as HTMLButtonElement;
		this.deleteButton.onclick = () => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.destroy();
				this.transformer.nodes([]);
				this.selectedRect = null;
				this.shapeLayer.draw();
			}
		};

		// Save button.
		this.saveButton = toolbarEl.createEl("button", {
			text: "Save",
		}) as HTMLButtonElement;
		this.saveButton.onclick = () => this.saveOcclusionData();

		// Create the Konva container with flex properties
		this.konvaContainer = this.containerEl.createEl("div", {
			cls: "konva-container",
		}) as HTMLDivElement;
		this.konvaContainer.style.border = "1px solid #ccc";
		this.konvaContainer.style.flex = "1";
		this.konvaContainer.style.position = "relative";
		this.konvaContainer.style.overflow = "auto";

		// Initialize stage with placeholder dimensions
		this.stage = new Konva.Stage({
			container: this.konvaContainer,
			width: 800,
			height: 600,
		});
		this.imageLayer = new Konva.Layer();
		this.shapeLayer = new Konva.Layer();
		this.stage.add(this.imageLayer);
		this.stage.add(this.shapeLayer);

		this.transformer = new Konva.Transformer();
		this.shapeLayer.add(this.transformer);

		this.stage.on("click", (e) => {
			if (this.reviewMode) return;
			if (e.target === this.stage) {
				this.transformer.nodes([]);
				this.selectedRect = null;
			}
		});

		// Instead of using ResizeObserver, we can listen for leaf resize events
		this.registerInterval(
			window.setInterval(() => {
				// Check if container dimensions have changed
				if (this.konvaContainer && this.stage) {
					const containerWidth = this.konvaContainer.clientWidth;
					const containerHeight = this.konvaContainer.clientHeight;

					if (
						this.stage.width() !== containerWidth ||
						this.stage.height() !== containerHeight
					) {
						this.resizeStage();
					}
				}
			}, 500) // Check every 500ms
		);

		if (this.fileSelectEl.value) {
			this.loadImage(this.fileSelectEl.value);
		}
	}

	toggleReviewMode(): void {
		this.reviewMode = !this.reviewMode;
		if (this.reviewMode) {
			this.controlsDiv.style.display = "none";
			this.addRectButton.style.display = "none";
			this.deleteButton.style.display = "none";
			this.saveButton.style.display = "none";
			this.transformer.nodes([]);
			this.transformer.visible(false);
			this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
				if (child instanceof Konva.Rect) child.draggable(false);
			});
			this.modeToggleButton.textContent = "Switch to Edit Mode";
		} else {
			this.controlsDiv.style.display = "";
			this.addRectButton.style.display = "";
			this.deleteButton.style.display = "";
			this.saveButton.style.display = "";
			this.transformer.visible(true);
			this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
				if (child instanceof Konva.Rect) child.draggable(true);
			});
			this.modeToggleButton.textContent = "Switch to Review Mode";
		}
		this.shapeLayer.draw();
	}

	async loadImage(filePath: string): Promise<void> {
		this.imageLayer.destroyChildren();
		this.shapeLayer.destroyChildren();
		this.transformer = new Konva.Transformer();
		this.shapeLayer.add(this.transformer);
		this.imageLayer.draw();
		this.shapeLayer.draw();

		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			new Notice("File not found or not a valid image file");
			return;
		}
		const data = await this.plugin.app.vault.readBinary(file);
		const blob = new Blob([data]);
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			const nativeWidth = img.naturalWidth;
			const nativeHeight = img.naturalHeight;

			// Add the image to the stage
			const kImage = new Konva.Image({
				image: img,
				x: 0,
				y: 0,
				width: nativeWidth,
				height: nativeHeight,
			});
			this.imageLayer.add(kImage);

			// Resize the stage to fit the container
			this.resizeStage();

			this.loadSavedShapes(filePath);
		};
		img.src = url;
	}

	addRectangle(): void {
		const rect = new Konva.Rect({
			x: 50,
			y: 50,
			width: 100,
			height: 100,
			fill: "#000000",
			opacity: 1,
			draggable: true,
		});
		rect.on("click", (e) => {
			e.cancelBubble = true;
			if (this.reviewMode) {
				rect.visible(!rect.visible());
				this.shapeLayer.draw();
			} else {
				this.selectedRect = rect;
				this.transformer.nodes([rect]);
				this.colorInput.value = rect.fill() as string;
				this.widthInput.value = rect.width().toString();
				this.heightInput.value = rect.height().toString();
			}
		});
		this.shapeLayer.add(rect);
		this.shapeLayer.draw();
	}

	async saveOcclusionData(): Promise<void> {
		const filePath = this.fileSelectEl.value;
		if (!filePath) return;
		const shapes: OcclusionShape[] = this.shapeLayer
			.getChildren()
			.map((shape: Konva.Node) => {
				if (shape instanceof Konva.Rect) {
					return {
						x: shape.x(),
						y: shape.y(),
						width: shape.width(),
						height: shape.height(),
						fill: shape.fill() as string,
						opacity: shape.opacity(),
					};
				}
				return null;
			})
			.filter((s): s is OcclusionShape => s !== null);

		// Update the plugin's occlusion data directly
		this.plugin.occlusion.attachments[filePath] = shapes;
		await this.plugin.savePluginData();
		new Notice("Occlusion data saved!");
	}

	async loadSavedShapes(filePath: string): Promise<void> {
		// Access the occlusion data directly from the plugin
		const shapes = this.plugin.occlusion.attachments[filePath] || [];

		shapes.forEach((s: OcclusionShape) => {
			const rect = new Konva.Rect({
				x: s.x,
				y: s.y,
				width: s.width,
				height: s.height,
				fill: s.fill,
				opacity: s.opacity,
				draggable: !this.reviewMode,
			});
			rect.on("click", (e) => {
				e.cancelBubble = true;
				if (this.reviewMode) {
					rect.visible(!rect.visible());
					this.shapeLayer.draw();
				} else {
					this.selectedRect = rect;
					this.transformer.nodes([rect]);
					this.colorInput.value = rect.fill() as string;
					this.widthInput.value = rect.width().toString();
					this.heightInput.value = rect.height().toString();
				}
			});
			this.shapeLayer.add(rect);
		});
		this.shapeLayer.draw();
	}

	// Add a new method to handle stage resizing
	resizeStage(): void {
		if (!this.stage) return;

		const containerWidth = this.konvaContainer.clientWidth;
		const containerHeight = this.konvaContainer.clientHeight;

		this.stage.width(containerWidth);
		this.stage.height(containerHeight);

		// If we have an image loaded, adjust the scale to fit
		const backgroundImage = this.imageLayer.findOne("Image") as Konva.Image;
		if (backgroundImage) {
			const imgWidth = backgroundImage.width();
			const imgHeight = backgroundImage.height();

			// Calculate scale to fit the container while maintaining aspect ratio
			const scale = Math.min(
				containerWidth / imgWidth,
				containerHeight / imgHeight,
				1
			);

			this.initialScale = scale;
			this.currentScale = scale;
			this.stage.scale({ x: scale, y: scale });
		}

		this.stage.draw();
	}

	async onClose(): Promise<void> {
		// Optional cleanup if needed in the future
	}
}

// Change the default export to be a class that extends MyPlugin
// This is no longer needed since we're using MyPlugin directly
// export default class OcclusionPlugin extends Plugin { ... }
