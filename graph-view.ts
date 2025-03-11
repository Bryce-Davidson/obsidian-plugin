import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import * as d3 from "d3";
import MyPlugin from "main";

export const VIEW_TYPE_GRAPH = "graph-view";

// Extend Node to include EF history and an optional interpolator.
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
	ef?: number;
	efHistory?: { ef: number; timestamp: number }[];
	efInterpolator?: d3.ScaleLinear<number, number>;
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
	private efColorScale = d3.scaleLinear<string>().range(["red", "green"]);
	private edgeLength: number = 100;
	private chargeStrength: number = -100;

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
		containerEl.addClass("graph-view-container");

		this.initControls();
		this.initSvg();
		await this.loadGraphData();
		this.renderGraph();
		this.registerEvents();
	}

	private initControls() {
		const controlBox = this.containerEl.createDiv("graph-view-controls");
		controlBox.innerHTML = `
			<div>
				<label>Edge Length:
					<input type="range" id="edgeLengthInput" min="50" max="300" value="${this.edgeLength}" />
					<span id="edgeLengthValue">${this.edgeLength}</span>
				</label>
			</div>
			<div>
				<label>Charge Force:
					<input type="range" id="chargeForceInput" min="-300" max="0" value="${this.chargeStrength}" />
					<span id="chargeForceValue">${this.chargeStrength}</span>
				</label>
			</div>
			<div>
				<button id="animateEF">Animate EF</button>
			</div>
		`;

		this.setupControlListeners(controlBox);

		const animateButton =
			controlBox.querySelector<HTMLButtonElement>("#animateEF");
		if (animateButton) {
			animateButton.addEventListener("click", () =>
				this.animateEFProgression()
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
			.attr("class", "graph-view-svg");

		this.zoom = d3
			.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.1, 8])
			.on("zoom", (event) => {
				this.container.attr("transform", event.transform.toString());
			});

		this.svg.call(this.zoom);
		this.container = this.svg.append("g").attr("class", "graph-container");
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

		// Update color scale for flashcards
		this.updateFlashcardColors();
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
			const ef = cardData.ef;
			// Convert efHistory timestamps from string to number (milliseconds)
			const efHistory = (cardData.efHistory || []).map((entry: any) => ({
				timestamp: Date.parse(entry.timestamp),
				ef: entry.ef,
			}));
			const angle = (2 * Math.PI * index) / count;
			const offset = 30;

			const cardNode: Node = {
				id: `${notePath}_${cardId}`,
				x: 0,
				y: 0,
				radius: 5,
				color: "",
				type: "card",
				parent: notePath,
				offsetX: Math.cos(angle) * offset,
				offsetY: Math.sin(angle) * offset,
				ef: ef,
				efHistory: efHistory,
			};

			this.cardNodes.push(cardNode);
		});
	}

	private updateFlashcardColors() {
		if (this.cardNodes.length === 0) return;

		const minEF = d3.min(this.cardNodes, (d) => d.ef)!;
		const maxEF = d3.max(this.cardNodes, (d) => d.ef)!;

		if (minEF === maxEF) {
			this.efColorScale.domain([minEF - 1, maxEF + 1]);
		} else {
			this.efColorScale.domain([minEF, maxEF]);
		}

		this.efColorScale.interpolate(d3.interpolateHcl);

		this.cardNodes.forEach((card) => {
			if (card.ef !== undefined) {
				card.color = this.efColorScale(card.ef);
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

	// Animation of EF progression over time
	private animateEFProgression() {
		// 1. Gather all timestamps from all card histories
		let allTimestamps: number[] = [];
		this.cardNodes.forEach((card) => {
			if (card.efHistory && card.efHistory.length > 0) {
				card.efHistory.forEach((entry) => {
					allTimestamps.push(entry.timestamp);
				});
			}
		});

		if (allTimestamps.length === 0) return;

		// Determine the min and max timestamps for the animation timeline.
		const minTime = d3.min(allTimestamps)!;
		const maxTime = d3.max(allTimestamps)!;

		// 2. Create or update the interpolator for each card’s EF history.
		this.cardNodes.forEach((card) => {
			if (card.efHistory && card.efHistory.length >= 2) {
				// Sort the history by timestamp.
				card.efHistory.sort((a, b) => a.timestamp - b.timestamp);
				card.efInterpolator = d3
					.scaleLinear<number, number>()
					.domain(card.efHistory.map((e) => e.timestamp))
					.range(card.efHistory.map((e) => e.ef))
					.clamp(true);
			} else if (card.efHistory && card.efHistory.length === 1) {
				// If only one value exists, use a constant interpolator.
				const constantEF = card.efHistory[0].ef;
				card.efInterpolator = d3
					.scaleLinear<number, number>()
					.domain([minTime, maxTime])
					.range([constantEF, constantEF]);
			}
		});

		// 3. (Optional) Recalculate the global EF domain based on the animated values.
		const allEFs = this.cardNodes.flatMap((card) =>
			card.efHistory ? card.efHistory.map((e) => e.ef) : []
		);
		if (allEFs.length > 0) {
			const globalMinEF = d3.min(allEFs)!;
			const globalMaxEF = d3.max(allEFs)!;
			if (globalMinEF === globalMaxEF) {
				this.efColorScale.domain([globalMinEF - 1, globalMaxEF + 1]);
			} else {
				this.efColorScale.domain([globalMinEF, globalMaxEF]);
			}
		}

		// 4. Use d3.timer to update the animation.
		const duration = 10000; // total animation duration in milliseconds
		const timer = d3.timer((elapsed) => {
			// Map elapsed time to our EF history timeline.
			const t = minTime + ((maxTime - minTime) * elapsed) / duration;

			// Update each card’s EF and color based on the interpolator.
			this.cardNodes.forEach((card) => {
				if (card.efInterpolator) {
					const currentEF = card.efInterpolator(t);
					card.ef = currentEF;
					card.color = this.efColorScale(currentEF);
				}
			});

			// Redraw the card nodes with the updated color.
			this.container
				.selectAll<SVGCircleElement, Node>(".card-node")
				.attr("fill", (d) => {
					const card = this.cardNodes.find((c) => c.id === d.id);
					return card ? card.color : d.color;
				});

			// Stop the timer once elapsed time exceeds the duration.
			if (elapsed > duration) {
				timer.stop();
			}
		});
	}

	async onClose() {
		this.containerEl.empty();
	}
}
