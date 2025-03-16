import { Plugin, Notice, TFile, WorkspaceLeaf, ItemView } from "obsidian";
import Konva from "konva";

// Define an interface for a single occlusion shape.
interface OcclusionShape {
	x: number;
	y: number;
	width: number;
	height: number;
	fill: string;
	opacity: number;
}

// Define the occlusion data structure.
interface OcclusionData {
	attachments: { [filePath: string]: OcclusionShape[] };
}

export default class OcclusionPlugin extends Plugin {
	cachedOcclusionData: OcclusionData = { attachments: {} };
	globalObserver: MutationObserver;

	async onload() {
		// Load occlusion data from disk.
		this.cachedOcclusionData = (await this.loadData()) || {
			attachments: {},
		};

		// Register the custom occlusion editor view.
		this.registerView(
			OcclusionView.VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new OcclusionView(leaf, this)
		);

		// Add a ribbon icon to launch the occlusion editor.
		this.addRibbonIcon("image-file", "Open Occlusion Editor", () => {
			this.activateView();
		});

		// Global MutationObserver to watch for new <img> elements.
		// When an image is added, if we have occlusion data for it,
		// we swap the image for a Konva-rendered version with occlusions.
		const processImageElement = (imgElement: HTMLImageElement) => {
			// Avoid processing the same element more than once.
			if (imgElement.getAttribute("data-occlusion-processed")) return;
			imgElement.setAttribute("data-occlusion-processed", "true");

			// Use the alt attribute (assumed to be the file name) to help resolve the file.
			const alt = imgElement.getAttribute("alt");
			if (!alt) return;

			// Find the file in the vault that matches the alt text.
			const file = this.app.vault
				.getFiles()
				.find((f) => f.name === alt || f.path.endsWith(alt));
			if (!file) return;
			const key = file.path;
			// If we don't have occlusion data for this file, do nothing.
			if (!this.cachedOcclusionData.attachments[key]) return;

			// Create a container element to host the custom rendering.
			const container = document.createElement("div");
			container.classList.add("occluded-image-container");

			// Create a new Image object to load the source.
			const newImg = new Image();
			newImg.onload = () => {
				const nativeWidth = newImg.naturalWidth;
				const nativeHeight = newImg.naturalHeight;
				container.style.width = nativeWidth + "px";
				container.style.height = nativeHeight + "px";

				// Create a Konva stage in the container.
				const stage = new Konva.Stage({
					container: container,
					width: nativeWidth,
					height: nativeHeight,
				});
				const imageLayer = new Konva.Layer();
				const shapeLayer = new Konva.Layer();
				stage.add(imageLayer);
				stage.add(shapeLayer);

				// Add the image to the stage.
				const kImage = new Konva.Image({
					image: newImg,
					x: 0,
					y: 0,
					width: nativeWidth,
					height: nativeHeight,
				});
				imageLayer.add(kImage);
				imageLayer.draw();

				// Render the occlusion shapes, each with a click handler to toggle visibility.
				const shapes = this.cachedOcclusionData.attachments[key];
				if (shapes && shapes.length > 0) {
					shapes.forEach((s: OcclusionShape) => {
						const rect = new Konva.Rect({
							x: s.x,
							y: s.y,
							width: s.width,
							height: s.height,
							fill: s.fill,
							opacity: s.opacity,
						});
						// When a rectangle is clicked, toggle its visibility.
						rect.on("click", (e) => {
							e.cancelBubble = true;
							rect.visible(!rect.visible());
							shapeLayer.draw();
						});
						shapeLayer.add(rect);
					});
					shapeLayer.draw();
				}
			};
			newImg.src = imgElement.src;
			// Replace the original <img> element with the custom container.
			imgElement.replaceWith(container);
		};

		this.globalObserver = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				mutation.addedNodes.forEach((node) => {
					if (node.nodeType === Node.ELEMENT_NODE) {
						const element = node as HTMLElement;
						if (element.tagName === "IMG") {
							processImageElement(element as HTMLImageElement);
						} else {
							const imgs = element.querySelectorAll("img");
							imgs.forEach((img) =>
								processImageElement(img as HTMLImageElement)
							);
						}
					}
				});
			});
		});
		this.globalObserver.observe(document.body, {
			childList: true,
			subtree: true,
		});
		console.log("Global mutation observer attached to document.body");
	}

	async onunload() {
		this.app.workspace
			.getLeavesOfType(OcclusionView.VIEW_TYPE)
			.forEach((leaf) => {
				if (leaf) leaf.detach();
			});
		if (this.globalObserver) {
			this.globalObserver.disconnect();
			console.log("Global mutation observer disconnected.");
		}
	}

	async activateView() {
		this.app.workspace.detachLeavesOfType(OcclusionView.VIEW_TYPE);
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("Could not get a workspace leaf");
			return;
		}
		await leaf.setViewState({
			type: OcclusionView.VIEW_TYPE,
			active: true,
		});
		this.app.workspace.revealLeaf(leaf);
	}
}

class OcclusionView extends ItemView {
	static VIEW_TYPE = "occlusion-view";
	plugin: OcclusionPlugin;

	containerEl: HTMLElement;
	fileSelectEl: HTMLSelectElement;
	addRectButton: HTMLButtonElement;
	saveButton: HTMLButtonElement;
	konvaContainer: HTMLDivElement;
	colorInput: HTMLInputElement;
	widthInput: HTMLInputElement;
	heightInput: HTMLInputElement;
	controlsDiv: HTMLElement;
	modeToggleButton: HTMLButtonElement;

	stage: Konva.Stage;
	imageLayer: Konva.Layer;
	shapeLayer: Konva.Layer;
	transformer: Konva.Transformer;

	selectedRect: Konva.Rect | null = null;
	reviewMode: boolean = false;

	constructor(leaf: WorkspaceLeaf, plugin: OcclusionPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return OcclusionView.VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Occlusion Editor";
	}

	async onOpen() {
		this.containerEl = this.contentEl.createDiv("occlusion-editor");

		this.fileSelectEl = this.containerEl.createEl(
			"select"
		) as HTMLSelectElement;
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

		this.modeToggleButton = this.containerEl.createEl("button", {
			text: "Switch to Review Mode",
		});
		this.modeToggleButton.onclick = () => this.toggleReviewMode();

		this.controlsDiv = this.containerEl.createDiv("controls");
		this.colorInput = this.controlsDiv.createEl("input", { type: "color" });
		this.colorInput.onchange = (e: Event) => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.fill((e.target as HTMLInputElement).value);
				this.shapeLayer.draw();
			}
		};
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

		this.addRectButton = this.containerEl.createEl("button", {
			text: "Add Occlusion",
		}) as HTMLButtonElement;
		this.addRectButton.onclick = () => this.addRectangle();

		this.saveButton = this.containerEl.createEl("button", {
			text: "Save",
		}) as HTMLButtonElement;
		this.saveButton.onclick = () => this.saveOcclusionData();

		this.konvaContainer = this.containerEl.createDiv(
			"konva-container"
		) as HTMLDivElement;
		this.konvaContainer.style.border = "1px solid #ccc";
		this.konvaContainer.style.width = "800px";
		this.konvaContainer.style.height = "600px";

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

		if (this.fileSelectEl.value) {
			this.loadImage(this.fileSelectEl.value);
		}
	}

	toggleReviewMode(): void {
		this.reviewMode = !this.reviewMode;
		if (this.reviewMode) {
			this.controlsDiv.style.display = "none";
			this.addRectButton.style.display = "none";
			this.saveButton.style.display = "none";
			this.transformer.nodes([]);
			this.transformer.visible(false);
			this.shapeLayer.getChildren().forEach((child) => {
				if (child instanceof Konva.Rect) child.draggable(false);
			});
			this.modeToggleButton.textContent = "Switch to Edit Mode";
		} else {
			this.controlsDiv.style.display = "";
			this.addRectButton.style.display = "";
			this.saveButton.style.display = "";
			this.transformer.visible(true);
			this.shapeLayer.getChildren().forEach((child) => {
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
			this.stage.width(nativeWidth);
			this.stage.height(nativeHeight);
			this.konvaContainer.style.width = nativeWidth + "px";
			this.konvaContainer.style.height = nativeHeight + "px";
			const kImage = new Konva.Image({
				image: img,
				x: 0,
				y: 0,
				width: nativeWidth,
				height: nativeHeight,
			});
			this.imageLayer.add(kImage);
			this.imageLayer.draw();
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
		const savedData =
			(await this.plugin.loadData()) as OcclusionData | null;
		const saved: OcclusionData = savedData || { attachments: {} };
		saved.attachments[filePath] = shapes;
		await this.plugin.saveData(saved);
		this.plugin.cachedOcclusionData = saved;
		new Notice("Occlusion data saved!");
	}

	async loadSavedShapes(filePath: string): Promise<void> {
		const savedData =
			(await this.plugin.loadData()) as OcclusionData | null;
		const saved: OcclusionData = savedData || { attachments: {} };
		if (saved.attachments[filePath]) {
			saved.attachments[filePath].forEach((s: OcclusionShape) => {
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
	}

	async onClose(): Promise<void> {
		// Optional cleanup.
	}
}
