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

	// Timeline and animation state properties
	private timelineEvents: number[] = [];
	private currentEventIndex: number = 0;
	private animationTimer: d3.Timer | null = null;
	private isPlaying: boolean = false;
	private eventDuration: number = 100; // default duration per event in ms

	// NEW: Grouping interval in ms. 0 means no grouping.
	private groupingInterval: number = 0;

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
		// Create a more compact, modern control panel using Tailwind CSS components.
		const controlBox = this.containerEl.createDiv();
		controlBox.className =
			"fixed z-50 flex flex-col gap-2 p-3 text-sm rounded-md shadow-md top-4 left-4 bg-white/90 backdrop-blur-sm";

		// NEW: Added grouping interval control in the timeline controls.
		controlBox.innerHTML = `
<div class="bg-gray-900 text-gray-300 p-4 rounded-md border border-gray-700 max-w-md mx-auto space-y-4">
  <!-- Sliders Section -->
  <div class="space-y-3">
    <div class="flex flex-col">
      <label for="edgeLengthInput" class="text-sm font-medium">Edge Length</label>
      <div class="flex items-center mt-1">
        <input type="range" id="edgeLengthInput" min="50" max="300" value="${this.edgeLength}" class="flex-1 h-2 rounded bg-gray-800 focus:outline-none">
        <span id="edgeLengthValue" class="ml-3 text-sm text-gray-400">${this.edgeLength}</span>
      </div>
    </div>
    <div class="flex flex-col">
      <label for="chargeForceInput" class="text-sm font-medium">Charge Force</label>
      <div class="flex items-center mt-1">
        <input type="range" id="chargeForceInput" min="-300" max="0" value="${this.chargeStrength}" class="flex-1 h-2 rounded bg-gray-800 focus:outline-none">
        <span id="chargeForceValue" class="ml-3 text-sm text-gray-400">${this.chargeStrength}</span>
      </div>
    </div>
  </div>

  <!-- Progress Section -->
  <div class="flex items-center space-x-2">
    <label for="efProgressBar" class="text-sm font-medium">Progress</label>
    <progress id="efProgressBar" value="0" max="100" class="flex-1 h-2 rounded bg-gray-800"></progress>
    <span id="efProgressLabel" class="text-sm text-gray-400">0%</span>
  </div>

  <!-- Timeline Controls -->
  <div class="border-t border-gray-700 pt-4 space-y-4">
    <div class="flex flex-col">
      <label for="timelineSlider" class="text-sm font-medium">Timeline</label>
      <div class="flex items-center mt-1">
        <input type="range" id="timelineSlider" min="0" max="0" value="0" class="flex-1 h-2 rounded bg-gray-800 focus:outline-none">
        <span id="timelineLabel" class="ml-3 text-sm text-gray-400">0 / 0</span>
      </div>
    </div>
    <div class="flex justify-center space-x-3">
      <button id="prevEvent" class="px-3 py-2 rounded bg-blue-600 hover:bg-blue-700 focus:outline-none transition duration-150">Prev</button>
      <button id="playPause" class="px-3 py-2 rounded bg-blue-600 hover:bg-blue-700 focus:outline-none transition duration-150">Play</button>
      <button id="nextEvent" class="px-3 py-2 rounded bg-blue-600 hover:bg-blue-700 focus:outline-none transition duration-150">Next</button>
    </div>
    <div class="flex items-center space-x-3">
      <div class="flex items-center">
        <label for="eventDurationInput" class="text-sm font-medium mr-2">Event Duration (ms)</label>
        <input type="number" id="eventDurationInput" min="500" max="10000" value="2000" class="w-24 border border-gray-700 rounded bg-gray-800 text-sm text-gray-300 text-center focus:outline-none">
      </div>
      <!-- NEW: Grouping interval input -->
      <div class="flex items-center">
        <label for="groupingIntervalInput" class="text-sm font-medium mr-2">Grouping Interval (ms)</label>
        <input type="number" id="groupingIntervalInput" min="0" max="10000000" value="0" class="w-24 border border-gray-700 rounded bg-gray-800 text-sm text-gray-300 text-center focus:outline-none">
      </div>
    </div>
  </div>
</div>
		`;

		this.setupControlListeners(controlBox);

		// Timeline and playback control listeners
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
		const groupingIntervalInput =
			controlBox.querySelector<HTMLInputElement>(
				"#groupingIntervalInput"
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
				if (playPauseButton.textContent === "Reset") {
					this.currentEventIndex = 0;
					this.updateTimelineLabel();
					this.updateGraphForEvent(this.currentEventIndex);
					playPauseButton.textContent = "Play";
					return;
				}
				if (this.isPlaying) {
					this.pauseAnimation();
					playPauseButton.textContent = "Play";
				} else {
					if (this.animationTimer) {
						this.animationTimer.stop();
						this.animationTimer = null;
					}
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

		// NEW: Update grouping interval on change.
		if (groupingIntervalInput) {
			groupingIntervalInput.addEventListener("input", () => {
				this.groupingInterval = parseInt(groupingIntervalInput.value);
				this.setupTimelineEvents();
				this.updateTimelineLabel();
				this.updateGraphForEvent(this.currentEventIndex);
			});
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

		noteGroup
			.select("circle")
			.attr("r", (d: Node) => d.radius)
			.attr("fill", (d: Node) => d.color);

		noteGroup
			.select("text")
			.attr("y", (d: Node) => d.radius + 15)
			.text(this.truncateNodeLabel);

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

				cardSelection
					.attr("r", (d: Node) => d.radius)
					.attr("cx", (d: Node) => d.offsetX!)
					.attr("cy", (d: Node) => d.offsetY!)
					.attr("fill", (d: Node) => d.color);

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

		this.container
			.selectAll(".link")
			.data(this.links)
			.enter()
			.append("line")
			.attr("class", "link")
			.attr("stroke", "#999")
			.attr("stroke-opacity", 0.6)
			.attr("stroke-width", 1.5);

		const noteGroup = this.container
			.selectAll(".note-node")
			.data(this.noteNodes, (d: Node) => d.id)
			.enter()
			.append("g")
			.attr("class", "note-node")
			.call(this.setupDragBehavior())
			.on("click", (event, d) => this.nodeClicked(d));

		noteGroup
			.append("circle")
			.attr("r", (d: Node) => d.radius)
			.attr("fill", (d: Node) => d.color)
			.attr("stroke", "#fff")
			.attr("stroke-width", 1.5);

		noteGroup
			.append("text")
			.attr("x", 0)
			.attr("y", (d: Node) => d.radius + 15)
			.attr("text-anchor", "middle")
			.text(this.truncateNodeLabel)
			.attr("font-size", "10px")
			.attr("font-family", "sans-serif");

		this.addCardNodes(noteGroup);
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
		this.container
			.selectAll<SVGLineElement, Link>(".link")
			.attr("x1", (d) => (typeof d.source === "object" ? d.source.x! : 0))
			.attr("y1", (d) => (typeof d.source === "object" ? d.source.y! : 0))
			.attr("x2", (d) => (typeof d.target === "object" ? d.target.x! : 0))
			.attr("y2", (d) =>
				typeof d.target === "object" ? d.target.y! : 0
			);

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

		this.createNoteNodes(files, noteMap, basenameMap);
		await this.createNoteLinks(files, noteMap, basenameMap);
		this.processFlashcardData(flashcardData, noteMap);
		this.updateFlashcardColors();
		this.setupTimelineEvents();
		this.updateTimelineLabel();
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

	// Timeline & Playback Animation Functions

	// NEW: Modified setupTimelineEvents to support groupingInterval.
	private setupTimelineEvents() {
		const eventsSet = new Set<number>();
		this.cardNodes.forEach((card) => {
			card.ratingHistory?.forEach((entry) =>
				eventsSet.add(entry.timestamp)
			);
		});
		const allEvents = Array.from(eventsSet).sort((a, b) => a - b);

		if (this.groupingInterval > 0) {
			const groupedEvents: number[] = [];
			let groupStart: number | null = null;
			let groupMax: number | null = null;

			allEvents.forEach((t) => {
				if (groupStart === null) {
					groupStart = t;
					groupMax = t;
				} else if (t - groupStart < this.groupingInterval) {
					// Within the same group, update representative timestamp.
					groupMax = Math.max(groupMax!, t);
				} else {
					// New group starts.
					groupedEvents.push(groupMax!);
					groupStart = t;
					groupMax = t;
				}
			});
			// Push the final group.
			if (groupMax !== null) {
				groupedEvents.push(groupMax);
			}
			this.timelineEvents = groupedEvents;
		} else {
			this.timelineEvents = allEvents;
		}

		const timelineSlider =
			this.containerEl.querySelector<HTMLInputElement>("#timelineSlider");
		if (timelineSlider) {
			timelineSlider.max = (this.timelineEvents.length - 1).toString();
		}
		if (this.currentEventIndex >= this.timelineEvents.length) {
			this.currentEventIndex = this.timelineEvents.length - 1;
		}
	}

	private updateTimelineLabel() {
		const timelineLabel =
			this.containerEl.querySelector<HTMLSpanElement>("#timelineLabel");
		if (timelineLabel) {
			timelineLabel.textContent = `${this.currentEventIndex + 1} / ${
				this.timelineEvents.length
			}`;
		}
		const timelineSlider =
			this.containerEl.querySelector<HTMLInputElement>("#timelineSlider");
		if (timelineSlider) {
			timelineSlider.value = this.currentEventIndex.toString();
		}
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

	private updateGraphForEvent(eventIndex: number) {
		if (this.timelineEvents.length === 0) return;
		const currentTimestamp = this.timelineEvents[eventIndex];

		this.cardNodes.forEach((card) => {
			if (card.ratingHistory && card.ratingHistory.length > 0) {
				const relevantEvent = card.ratingHistory
					.filter((e) => e.timestamp <= currentTimestamp)
					.sort((a, b) => b.timestamp - a.timestamp)[0];
				if (relevantEvent) {
					card.rating = relevantEvent.rating;
					card.color = getRatingColor(relevantEvent.rating);
				}
			}
		});

		this.container
			.selectAll<SVGCircleElement, Node>(".card-node")
			.attr("fill", (d) => {
				const card = this.cardNodes.find((c) => c.id === d.id);
				return card ? card.color : d.color;
			});
	}

	private startAnimation() {
		if (this.timelineEvents.length === 0) return;

		// Stop any existing timer
		if (this.animationTimer) {
			this.animationTimer.stop();
			this.animationTimer = null;
		}

		this.isPlaying = true;
		// Use a local variable to track when the last update occurred.
		let lastUpdate = -this.eventDuration; // So the first update happens immediately

		this.animationTimer = d3.timer((elapsed) => {
			if (elapsed - lastUpdate >= this.eventDuration) {
				lastUpdate = elapsed;
				this.stepNext();
				// When we reach the last event, pause and change button text to "Reset"
				if (this.currentEventIndex >= this.timelineEvents.length - 1) {
					this.pauseAnimation();
					const playPauseButton =
						this.containerEl.querySelector<HTMLButtonElement>(
							"#playPause"
						);
					if (playPauseButton) playPauseButton.textContent = "Reset";
				}
			}
		});
	}

	private pauseAnimation() {
		this.isPlaying = false;
		if (this.animationTimer) {
			this.animationTimer.stop();
			this.animationTimer = null;
		}
	}

	private stepNext() {
		if (this.currentEventIndex < this.timelineEvents.length - 1) {
			this.currentEventIndex++;
			this.updateTimelineLabel();
			this.updateGraphForEvent(this.currentEventIndex);
		}
	}

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
