import "./main.css";

import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import * as d3 from "d3";
import MyPlugin from "./main";

export const VIEW_TYPE_GRAPH = "graph-view";

const ratingMap = new Map<number, string>([
	[1, "#D73027"],
	[2, "#FC8D59"],
	[3, "#FEE08B"],
	[4, "#91CF60"],
	[5, "#1A9850"],
]);

function getRatingColor(rating: number): string {
	return ratingMap.get(rating) || "#000000";
}

interface Node extends d3.SimulationNodeDatum {
	id: string;
	fileName?: string;
	path?: string;
	radius: number;
	color: string;
	type: "note" | "card";
	parent?: string;
	offsetX?: number;
	offsetY?: number;
	rating?: number;
	ratingHistory?: { rating: number; timestamp: number }[];
	// no longer needed: ratingInterpolator?: d3.ScaleLinear<number, number>;
}

interface Link extends d3.SimulationLinkDatum<Node> {
	source: string | Node;
	target: string | Node;
	value: number;
}

export class GraphView extends ItemView {
	private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
	private simulation!: d3.Simulation<Node, Link>;
	private noteNodes: Node[] = [];
	private cardNodes: Node[] = [];
	private links: Link[] = [];
	private zoom!: d3.ZoomBehavior<SVGSVGElement, unknown>;
	private container!: d3.Selection<SVGGElement, unknown, null, undefined>;
	private plugin: MyPlugin;
	private colorScale = d3.scaleOrdinal(d3.schemeCategory10);
	private edgeLength: number = 100;
	private chargeStrength: number = -100;

	// New timeline and animation state properties
	private timelineEvents: number[] = [];
	private currentEventIndex: number = 0;
	private animationTimer: d3.Timer | null = null;
	private isPlaying: boolean = false;
	private eventDuration: number = 2000; // default duration per event in ms

	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_GRAPH;
	}

	getIcon(): string {
		return "dot-network";
	}

	getDisplayText() {
		return "Graph View";
	}

	async onOpen() {
		const containerEl = this.containerEl;
		containerEl.empty();
		containerEl.addClass("relative");

		this.initControls();
		this.initSvg();
		await this.loadGraphData();
		this.renderGraph();
		this.registerEvents();
	}

	private initControls() {
		// Create a control box using Tailwind classes.
		const controlBox = this.containerEl.createDiv();
		controlBox.className =
			"fixed z-50 flex flex-col gap-4 p-4 border border-gray-200 rounded-lg shadow-lg top-4 left-4 bg-white/90 backdrop-blur-md";

		controlBox.innerHTML = `
			<div class="flex flex-col gap-3">
				<div class="flex items-center gap-2">
					<label class="text-sm font-medium text-gray-700" for="edgeLengthInput">Edge Length:</label>
					<input type="range" id="edgeLengthInput" min="50" max="300" value="${this.edgeLength}" class="w-32 h-2 appearance-none rounded-full bg-gray-200 focus:outline-none">
					<span id="edgeLengthValue" class="text-sm text-gray-600">${this.edgeLength}</span>
				</div>
				<div class="flex items-center gap-2">
					<label class="text-sm font-medium text-gray-700" for="chargeForceInput">Charge Force:</label>
					<input type="range" id="chargeForceInput" min="-300" max="0" value="${this.chargeStrength}" class="w-32 h-2 appearance-none rounded-full bg-gray-200 focus:outline-none">
					<span id="chargeForceValue" class="text-sm text-gray-600">${this.chargeStrength}</span>
				</div>
				<div class="flex items-center gap-2">
					<label class="text-sm font-medium text-gray-700" for="animationSpeedInput">Animation Speed:</label>
					<input type="range" id="animationSpeedInput" min="2000" max="50000" value="10000" step="1000" class="w-32 h-2 appearance-none rounded-full bg-gray-200 focus:outline-none">
					<span id="animationSpeedValue" class="text-sm text-gray-600">10s</span>
				</div>
				<!-- Original animate button (optional if still needed) -->
				<div>
					<button id="animateEF" class="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400">Animate Rating</button>
				</div>
				<div id="efProgressContainer" class="flex items-center gap-2">
					<label class="text-sm font-medium text-gray-700" for="efProgressBar">Animation Progress:</label>
					<progress id="efProgressBar" value="0" max="100" class="w-32 h-2"></progress>
					<span id="efProgressLabel" class="text-sm text-gray-600">0%</span>
				</div>
				<!-- New timeline and playback controls -->
				<div id="timelineControls" class="flex flex-col gap-3 border-t pt-3">
					<div class="flex items-center gap-2">
						<label for="timelineSlider" class="text-sm font-medium text-gray-700">Timeline:</label>
						<input type="range" id="timelineSlider" min="0" max="0" value="0" class="w-64 h-2 appearance-none rounded bg-gray-200 focus:outline-none">
						<span id="timelineLabel" class="text-sm text-gray-600">0 / 0</span>
					</div>
					<div class="flex items-center gap-2">
						<button id="prevEvent" class="px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none">Prev</button>
						<button id="playPause" class="px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none">Play</button>
						<button id="nextEvent" class="px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none">Next</button>
					</div>
					<div class="flex items-center gap-2">
						<label for="eventDurationInput" class="text-sm font-medium text-gray-700">Event Duration (ms):</label>
						<input type="number" id="eventDurationInput" min="500" max="10000" value="2000" class="w-20 h-8 border rounded focus:outline-none">
					</div>
				</div>
			</div>
		`;

		this.setupControlListeners(controlBox);

		// Listeners for new timeline and playback controls
		const timelineSlider =
			controlBox.querySelector<HTMLInputElement>("#timelineSlider");
		const timelineLabel =
			controlBox.querySelector<HTMLSpanElement>("#timelineLabel");
		const prevButton =
			controlBox.querySelector<HTMLButtonElement>("#prevEvent");
		const playPauseButton =
			controlBox.querySelector<HTMLButtonElement>("#playPause");
		const nextButton =
			controlBox.querySelector<HTMLButtonElement>("#nextEvent");
		const eventDurationInput = controlBox.querySelector<HTMLInputElement>(
			"#eventDurationInput"
		);

		if (timelineSlider && timelineLabel) {
			timelineSlider.addEventListener("input", () => {
				this.currentEventIndex = parseInt(timelineSlider.value);
				this.updateTimelineLabel();
				this.updateGraphForEvent(this.currentEventIndex);
			});
		}

		if (prevButton) {
			prevButton.addEventListener("click", () => {
				this.stepPrev();
			});
		}

		if (nextButton) {
			nextButton.addEventListener("click", () => {
				this.stepNext();
			});
		}

		if (playPauseButton) {
			playPauseButton.addEventListener("click", () => {
				if (this.isPlaying) {
					this.pauseAnimation();
					playPauseButton.textContent = "Play";
				} else {
					this.startAnimation();
					playPauseButton.textContent = "Pause";
				}
			});
		}

		if (eventDurationInput) {
			eventDurationInput.addEventListener("input", () => {
				this.eventDuration = parseInt(eventDurationInput.value);
			});
		}

		// Original animate button listener – can be repurposed or removed if desired.
		const animateButton =
			controlBox.querySelector<HTMLButtonElement>("#animateEF");
		if (animateButton) {
			animateButton.addEventListener("click", () =>
				this.startAnimation()
			);
		}
	}

	private setupControlListeners(controlBox: HTMLDivElement) {
		const edgeLengthInput =
			controlBox.querySelector<HTMLInputElement>("#edgeLengthInput");
		const chargeForceInput =
			controlBox.querySelector<HTMLInputElement>("#chargeForceInput");
		const edgeLengthValue =
			controlBox.querySelector<HTMLSpanElement>("#edgeLengthValue");
		const chargeForceValue =
			controlBox.querySelector<HTMLSpanElement>("#chargeForceValue");
		const animationSpeedInput = controlBox.querySelector<HTMLInputElement>(
			"#animationSpeedInput"
		);
		const animationSpeedValue = controlBox.querySelector<HTMLSpanElement>(
			"#animationSpeedValue"
		);

		if (edgeLengthInput && edgeLengthValue) {
			edgeLengthInput.addEventListener("input", () => {
				const val = parseInt(edgeLengthInput.value);
				this.edgeLength = val;
				edgeLengthValue.textContent = val.toString();
				this.updateForceParameters("link", val);
			});
		}

		if (chargeForceInput && chargeForceValue) {
			chargeForceInput.addEventListener("input", () => {
				const val = parseInt(chargeForceInput.value);
				this.chargeStrength = val;
				chargeForceValue.textContent = val.toString();
				this.updateForceParameters("charge", val);
			});
		}

		if (animationSpeedInput && animationSpeedValue) {
			animationSpeedInput.addEventListener("input", () => {
				// This control is still present from the original code.
				const val = parseInt(animationSpeedInput.value);
				animationSpeedValue.textContent = `${(val / 1000).toFixed(1)}s`;
			});
		}
	}

	private updateForceParameters(forceType: string, value: number) {
		if (!this.simulation) return;

		if (forceType === "link") {
			(
				this.simulation.force("link") as d3.ForceLink<Node, Link>
			).distance(value);
		} else if (forceType === "charge") {
			(
				this.simulation.force("charge") as d3.ForceManyBody<Node>
			).strength(value);
		}

		this.simulation.alpha(0.3).restart();
	}

	private initSvg() {
		this.svg = d3
			.select(this.containerEl)
			.append("svg")
			.attr("width", "100%")
			.attr("height", "100%")
			.classed("w-full h-full", true);

		this.zoom = d3
			.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.1, 8])
			.on("zoom", (event) => {
				this.container.attr("transform", event.transform.toString());
			});

		this.svg.call(this.zoom);
		this.container = this.svg.append("g").classed("graph-container", true);
	}

	private registerEvents() {
		this.registerEvent(
			this.app.vault.on("modify", () => this.refreshGraphView())
		);
		this.registerEvent(
			this.app.vault.on("create", () => this.refreshGraphView())
		);
		this.registerEvent(
			this.app.vault.on("delete", () => this.refreshGraphView())
		);
	}

	public async refreshGraphView() {
		await this.loadGraphData();
		this.updateLinks();
		this.updateNoteNodes();
		this.updateCardNodes();
		this.updateSimulation();
		// Recompute timeline events on refresh.
		this.setupTimelineEvents();
		this.updateTimelineLabel();
		this.updateGraphForEvent(this.currentEventIndex);
	}

	private updateLinks() {
		const link = this.container
			.selectAll<SVGLineElement, Link>(".link")
			.data(this.links, this.getLinkId);

		link.enter()
			.append("line")
			.attr("class", "link")
			.attr("stroke", "#999")
			.attr("stroke-opacity", 0.6)
			.attr("stroke-width", 1.5);

		link.exit().remove();
	}

	private getLinkId(d: Link): string {
		return `${typeof d.source === "object" ? d.source.id : d.source}-${
			typeof d.target === "object" ? d.target.id : d.target
		}`;
	}

	private updateNoteNodes() {
		const noteGroup = this.container
			.selectAll<SVGGElement, Node>(".note-node")
			.data(this.noteNodes, (d: Node) => d.id);

		// Update existing nodes
		noteGroup
			.select("circle")
			.attr("r", (d: Node) => d.radius)
			.attr("fill", (d: Node) => d.color);

		noteGroup
			.select("text")
			.attr("y", (d: Node) => d.radius + 15)
			.text(this.truncateNodeLabel);

		// Add new nodes
		const noteGroupEnter = noteGroup
			.enter()
			.append("g")
			.attr("class", "note-node")
			.call(this.setupDragBehavior())
			.on("click", (event, d) => this.nodeClicked(d));

		noteGroupEnter
			.append("circle")
			.attr("r", (d: Node) => d.radius)
			.attr("fill", (d: Node) => d.color)
			.attr("stroke", "#fff")
			.attr("stroke-width", 1.5);

		noteGroupEnter
			.append("text")
			.attr("x", 0)
			.attr("y", (d: Node) => d.radius + 15)
			.attr("text-anchor", "middle")
			.text(this.truncateNodeLabel)
			.attr("font-size", "10px")
			.attr("font-family", "sans-serif");

		noteGroup.exit().remove();
	}

	private truncateNodeLabel(d: Node): string {
		const title = d.fileName ?? "";
		return title.length > 20 ? title.substring(0, 20) + "..." : title;
	}

	private setupDragBehavior() {
		return d3
			.drag<SVGGElement, Node>()
			.on("start", (event, d) => this.dragStarted(event, d))
			.on("drag", (event, d) => this.dragged(event, d))
			.on("end", (event, d) => this.dragEnded(event, d));
	}

	private updateCardNodes() {
		this.container
			.selectAll<SVGGElement, Node>(".note-node")
			.each((noteNode: Node, i, groups) => {
				const parentGroup = d3.select(groups[i]);
				const cardsForNote = this.cardNodes.filter(
					(card) => card.parent === noteNode.id
				);
				const cardSelection = parentGroup
					.selectAll<SVGCircleElement, Node>(".card-node")
					.data(cardsForNote, (d: Node) => d.id);

				// Update existing cards
				cardSelection
					.attr("r", (d: Node) => d.radius)
					.attr("cx", (d: Node) => d.offsetX!)
					.attr("cy", (d: Node) => d.offsetY!)
					.attr("fill", (d: Node) => d.color);

				// Add new cards
				cardSelection
					.enter()
					.append("circle")
					.attr("class", "card-node")
					.attr("r", (d: Node) => d.radius)
					.attr("cx", (d: Node) => d.offsetX!)
					.attr("cy", (d: Node) => d.offsetY!)
					.attr("fill", (d: Node) => d.color)
					.attr("stroke", "#fff")
					.attr("stroke-width", 1);

				cardSelection.exit().remove();
			});
	}

	private updateSimulation() {
		this.simulation.nodes(this.noteNodes);
		(this.simulation.force("link") as d3.ForceLink<Node, Link>).links(
			this.links
		);
		this.simulation.alpha(0.3).restart();
	}

	renderGraph() {
		const width = this.containerEl.clientWidth;
		const height = this.containerEl.clientHeight;

		this.container.selectAll("*").remove();

		// Add links
		this.container
			.selectAll(".link")
			.data(this.links)
			.enter()
			.append("line")
			.attr("class", "link")
			.attr("stroke", "#999")
			.attr("stroke-opacity", 0.6)
			.attr("stroke-width", 1.5);

		// Create note nodes
		const noteGroup = this.container
			.selectAll(".note-node")
			.data(this.noteNodes, (d: Node) => d.id)
			.enter()
			.append("g")
			.attr("class", "note-node")
			.call(this.setupDragBehavior())
			.on("click", (event, d) => this.nodeClicked(d));

		// Add circles for notes
		noteGroup
			.append("circle")
			.attr("r", (d: Node) => d.radius)
			.attr("fill", (d: Node) => d.color)
			.attr("stroke", "#fff")
			.attr("stroke-width", 1.5);

		// Add labels for notes
		noteGroup
			.append("text")
			.attr("x", 0)
			.attr("y", (d: Node) => d.radius + 15)
			.attr("text-anchor", "middle")
			.text(this.truncateNodeLabel)
			.attr("font-size", "10px")
			.attr("font-family", "sans-serif");

		// Add card nodes within each note
		this.addCardNodes(noteGroup);

		// Setup force simulation
		this.setupSimulation(width, height);
	}

	private addCardNodes(
		noteGroup: d3.Selection<d3.BaseType, Node, SVGGElement, unknown>
	) {
		noteGroup.each((d: Node, i, groups) => {
			const parentGroup = d3.select(groups[i]);
			const cardsForNote = this.cardNodes.filter(
				(card) => card.parent === d.id
			);

			parentGroup
				.selectAll(".card-node")
				.data(cardsForNote, (d: Node) => d.id)
				.enter()
				.append("circle")
				.attr("class", "card-node")
				.attr("r", (d: Node) => d.radius)
				.attr("cx", (d: Node) => d.offsetX!)
				.attr("cy", (d: Node) => d.offsetY!)
				.attr("fill", (d: Node) => d.color)
				.attr("stroke", "#fff")
				.attr("stroke-width", 1);
		});
	}

	private setupSimulation(width: number, height: number) {
		this.simulation = d3
			.forceSimulation<Node>(this.noteNodes)
			.force(
				"link",
				d3
					.forceLink<Node, Link>(this.links)
					.id((d: Node) => d.id)
					.distance(this.edgeLength)
			)
			.force("charge", d3.forceManyBody().strength(this.chargeStrength))
			.force("center", d3.forceCenter(width / 2, height / 2))
			.force("x", d3.forceX(width / 2).strength(0.1))
			.force("y", d3.forceY(height / 2).strength(0.1))
			.force("collide", d3.forceCollide().radius(30))
			.on("tick", () => this.ticked());
	}

	ticked() {
		// Update link positions
		this.container
			.selectAll<SVGLineElement, Link>(".link")
			.attr("x1", (d) => (typeof d.source === "object" ? d.source.x! : 0))
			.attr("y1", (d) => (typeof d.source === "object" ? d.source.y! : 0))
			.attr("x2", (d) => (typeof d.target === "object" ? d.target.x! : 0))
			.attr("y2", (d) =>
				typeof d.target === "object" ? d.target.y! : 0
			);

		// Update node positions
		this.container
			.selectAll<SVGGElement, Node>(".note-node")
			.attr("transform", (d) => `translate(${d.x}, ${d.y})`);
	}

	async loadGraphData() {
		this.noteNodes = [];
		this.cardNodes = [];
		this.links = [];

		const flashcardData = await this.plugin.loadData();
		const files = this.app.vault.getMarkdownFiles();
		const noteMap = new Map<string, Node>();
		const basenameMap = new Map<string, Node>();

		// Create note nodes
		this.createNoteNodes(files, noteMap, basenameMap);

		// Create links between notes
		await this.createNoteLinks(files, noteMap, basenameMap);

		// Process flashcard data
		this.processFlashcardData(flashcardData, noteMap);

		// Update colours for flashcards based on rating
		this.updateFlashcardColors();

		// After loading data, compute timeline events
		this.setupTimelineEvents();
		this.updateTimelineLabel();
		// Start with initial event state.
		this.updateGraphForEvent(this.currentEventIndex);
	}

	private createNoteNodes(
		files: TFile[],
		noteMap: Map<string, Node>,
		basenameMap: Map<string, Node>
	) {
		for (const file of files) {
			const noteNode: Node = {
				id: file.path,
				fileName: file.basename,
				path: file.path,
				x: Math.random() * 800 - 400,
				y: Math.random() * 800 - 400,
				radius: 12,
				color: this.colorScale(file.extension),
				type: "note",
			};
			this.noteNodes.push(noteNode);
			noteMap.set(file.path, noteNode);
			basenameMap.set(file.basename, noteNode);
		}
	}

	private async createNoteLinks(
		files: TFile[],
		noteMap: Map<string, Node>,
		basenameMap: Map<string, Node>
	) {
		for (const file of files) {
			const content = await this.app.vault.read(file);
			const wikiLinkRegex = /\[\[(.*?)(\|.*?)?\]\]/g;
			let match;

			while ((match = wikiLinkRegex.exec(content)) !== null) {
				const targetName = match[1].split("#")[0].split("|")[0].trim();
				const sourceNode = noteMap.get(file.path);
				const targetNode = basenameMap.get(targetName);

				if (sourceNode && targetNode) {
					this.links.push({
						source: sourceNode.id,
						target: targetNode.id,
						value: 1,
					});
				}
			}
		}
	}

	private processFlashcardData(
		flashcardData: any,
		noteMap: Map<string, Node>
	) {
		if (!flashcardData?.notes) return;

		for (const notePath in flashcardData.notes) {
			const noteEntry = flashcardData.notes[notePath];
			const cards = noteEntry.cards;
			const cardIds = Object.keys(cards);
			const count = cardIds.length;

			if (count > 0 && noteMap.has(notePath)) {
				this.createCardNodesForNote(notePath, cards, cardIds, count);
			}
		}
	}

	private createCardNodesForNote(
		notePath: string,
		cards: any,
		cardIds: string[],
		count: number
	) {
		cardIds.forEach((cardId, index) => {
			const cardData = cards[cardId];
			// Use the most recent rating or default to 3.
			const rating =
				cardData.efHistory && cardData.efHistory.length > 0
					? cardData.efHistory[cardData.efHistory.length - 1].rating
					: 3;
			const ratingHistory = (cardData.efHistory || []).map(
				(entry: any) => ({
					timestamp: Date.parse(entry.timestamp),
					rating: entry.rating,
				})
			);
			const angle = (2 * Math.PI * index) / count;
			const offset = 30;

			const cardNode: Node = {
				id: `${notePath}_${cardId}`,
				x: 0,
				y: 0,
				radius: 5,
				color: getRatingColor(rating),
				type: "card",
				parent: notePath,
				offsetX: Math.cos(angle) * offset,
				offsetY: Math.sin(angle) * offset,
				rating: rating,
				ratingHistory: ratingHistory,
			};

			this.cardNodes.push(cardNode);
		});
	}

	private updateFlashcardColors() {
		if (this.cardNodes.length === 0) return;

		// Set each card's colour based on its current rating
		this.cardNodes.forEach((card) => {
			if (card.rating !== undefined) {
				card.color = getRatingColor(card.rating);
			}
		});
	}

	dragStarted(event: d3.D3DragEvent<SVGGElement, Node, unknown>, d: Node) {
		if (!event.active) this.simulation.alphaTarget(0.3).restart();
		d.fx = d.x;
		d.fy = d.y;
	}

	dragged(event: d3.D3DragEvent<SVGGElement, Node, unknown>, d: Node) {
		d.fx = event.x;
		d.fy = event.y;
	}

	dragEnded(event: d3.D3DragEvent<SVGGElement, Node, unknown>, d: Node) {
		if (!event.active) this.simulation.alphaTarget(0);
		d.fx = null;
		d.fy = null;
	}

	nodeClicked(d: Node) {
		const file = this.app.vault.getAbstractFileByPath(d.path!);
		if (file instanceof TFile) {
			this.app.workspace.getLeaf().openFile(file);
		}
	}

	// New Timeline & Playback Animation Functions

	/**
	 * Build a sorted array of unique event timestamps from all card rating histories.
	 */
	private setupTimelineEvents() {
		const eventsSet = new Set<number>();
		this.cardNodes.forEach((card) => {
			card.ratingHistory?.forEach((entry) =>
				eventsSet.add(entry.timestamp)
			);
		});
		this.timelineEvents = Array.from(eventsSet).sort((a, b) => a - b);
		// Update the timeline slider max value.
		const timelineSlider =
			this.containerEl.querySelector<HTMLInputElement>("#timelineSlider");
		if (timelineSlider) {
			timelineSlider.max = (this.timelineEvents.length - 1).toString();
		}
		// Reset current index if out of range.
		if (this.currentEventIndex >= this.timelineEvents.length) {
			this.currentEventIndex = this.timelineEvents.length - 1;
		}
	}

	/**
	 * Update the timeline label (e.g., "3 / 10").
	 */
	private updateTimelineLabel() {
		const timelineLabel =
			this.containerEl.querySelector<HTMLSpanElement>("#timelineLabel");
		if (timelineLabel) {
			timelineLabel.textContent = `${this.currentEventIndex + 1} / ${
				this.timelineEvents.length
			}`;
		}
		// Also update the slider's value.
		const timelineSlider =
			this.containerEl.querySelector<HTMLInputElement>("#timelineSlider");
		if (timelineSlider) {
			timelineSlider.value = this.currentEventIndex.toString();
		}
		// Optionally update the progress bar (if still in use)
		const progressBar =
			this.containerEl.querySelector<HTMLProgressElement>(
				"#efProgressBar"
			);
		const progressLabel =
			this.containerEl.querySelector<HTMLSpanElement>("#efProgressLabel");
		if (progressBar && progressLabel && this.timelineEvents.length > 0) {
			const progressPercent = Math.round(
				((this.currentEventIndex + 1) / this.timelineEvents.length) *
					100
			);
			progressBar.value = progressPercent;
			progressLabel.textContent = `${progressPercent}%`;
		}
	}

	/**
	 * For a given event index, update each card's rating and color based on its history.
	 */
	private updateGraphForEvent(eventIndex: number) {
		if (this.timelineEvents.length === 0) return;
		const currentTimestamp = this.timelineEvents[eventIndex];

		this.cardNodes.forEach((card) => {
			if (card.ratingHistory && card.ratingHistory.length > 0) {
				// Find the latest event in this card's history that is <= currentTimestamp.
				const relevantEvent = card.ratingHistory
					.filter((e) => e.timestamp <= currentTimestamp)
					.sort((a, b) => b.timestamp - a.timestamp)[0];
				if (relevantEvent) {
					card.rating = relevantEvent.rating;
					card.color = getRatingColor(relevantEvent.rating);
				}
			}
		});

		// Update the card node colours on the graph.
		this.container
			.selectAll<SVGCircleElement, Node>(".card-node")
			.attr("fill", (d) => {
				const card = this.cardNodes.find((c) => c.id === d.id);
				return card ? card.color : d.color;
			});
	}

	/**
	 * Start playing the timeline animation.
	 */
	private startAnimation() {
		if (this.timelineEvents.length === 0) return;
		this.isPlaying = true;
		this.animationTimer = d3.timer((elapsed) => {
			// Move to next event after each eventDuration.
			if (elapsed > this.eventDuration) {
				elapsed = 0; // reset elapsed (d3.timer does not support resetting, so we update manually)
				this.stepNext();
				// If we've reached the end, pause.
				if (this.currentEventIndex >= this.timelineEvents.length - 1) {
					this.pauseAnimation();
					const playPauseButton =
						this.containerEl.querySelector<HTMLButtonElement>(
							"#playPause"
						);
					if (playPauseButton) playPauseButton.textContent = "Play";
				}
			}
		});
	}

	/**
	 * Pause the timeline animation.
	 */
	private pauseAnimation() {
		this.isPlaying = false;
		if (this.animationTimer) {
			this.animationTimer.stop();
			this.animationTimer = null;
		}
	}

	/**
	 * Advance to the next event (if available).
	 */
	private stepNext() {
		if (this.currentEventIndex < this.timelineEvents.length - 1) {
			this.currentEventIndex++;
			this.updateTimelineLabel();
			this.updateGraphForEvent(this.currentEventIndex);
		}
	}

	/**
	 * Step to the previous event (if available).
	 */
	private stepPrev() {
		if (this.currentEventIndex > 0) {
			this.currentEventIndex--;
			this.updateTimelineLabel();
			this.updateGraphForEvent(this.currentEventIndex);
		}
	}

	async onClose() {
		this.containerEl.empty();
	}
}
