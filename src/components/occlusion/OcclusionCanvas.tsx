import React, { useEffect, useRef, useState } from "react";
import {
	Stage,
	Layer,
	Image as KonvaImage,
	Rect,
	Transformer,
} from "react-konva";
import Konva from "konva";
import { TFile, Notice } from "obsidian";
import { OcclusionShape, ImageCanvasProps } from "../../types";

const OcclusionCanvas: React.FC<ImageCanvasProps> = ({
	plugin,
	selectedFile,
	reviewMode,
	onShapeSelect,
}) => {
	// State for image and shapes
	const [image, setImage] = useState<HTMLImageElement | null>(null);
	const [shapes, setShapes] = useState<OcclusionShape[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// State for zoom and pan
	const [scale, setScale] = useState(1);
	const [position, setPosition] = useState({ x: 0, y: 0 });
	const [isPanning, setIsPanning] = useState(false);
	const [lastPointerPosition, setLastPointerPosition] = useState<{
		x: number;
		y: number;
	} | null>(null);

	// Refs
	const stageRef = useRef<Konva.Stage>(null);
	const transformerRef = useRef<Konva.Transformer>(null);

	// Load image when selectedFile changes
	useEffect(() => {
		if (!selectedFile) return;

		const loadImage = async () => {
			const file = plugin.app.vault.getAbstractFileByPath(selectedFile);
			if (!file || !(file instanceof TFile)) {
				new Notice("File not found or not a valid image file");
				return;
			}

			try {
				const data = await plugin.app.vault.readBinary(file);
				const blob = new Blob([data]);
				const url = URL.createObjectURL(blob);

				const img = new Image();
				img.onload = () => {
					setImage(img);

					// Calculate initial scale to fit the image in the container
					if (stageRef.current) {
						const containerWidth = stageRef.current.width();
						const containerHeight = stageRef.current.height();

						const scaleX = containerWidth / img.naturalWidth;
						const scaleY = containerHeight / img.naturalHeight;
						const newScale = Math.min(scaleX, scaleY);

						// Center the image
						const centerX =
							(containerWidth - img.naturalWidth * newScale) / 2;
						const centerY =
							(containerHeight - img.naturalHeight * newScale) /
							2;

						setScale(newScale);
						setPosition({ x: centerX, y: centerY });
					}

					URL.revokeObjectURL(url);

					// Load shapes for this file
					const savedShapes =
						plugin.occlusion.attachments[selectedFile] || [];
					setShapes(savedShapes);
				};
				img.src = url;
			} catch (error) {
				console.error("Error loading image:", error);
				new Notice("Error loading image");
			}
		};

		loadImage();
	}, [selectedFile]);

	// Update transformer when selection changes
	useEffect(() => {
		if (selectedId && transformerRef.current && stageRef.current) {
			const node = stageRef.current.findOne(`#${selectedId}`);
			if (node) {
				transformerRef.current.nodes([node as Konva.Node]);
				transformerRef.current.getLayer()?.batchDraw();

				// Update parent component with selected shape
				onShapeSelect(node as Konva.Rect);
			}
		} else if (transformerRef.current) {
			transformerRef.current.nodes([]);
			transformerRef.current.getLayer()?.batchDraw();
			onShapeSelect(null);
		}
	}, [selectedId, onShapeSelect]);

	// Handle stage resize
	useEffect(() => {
		const handleResize = () => {
			if (stageRef.current && image) {
				const container = stageRef.current.container();
				const containerWidth = container.offsetWidth;
				const containerHeight = container.offsetHeight;

				stageRef.current.width(containerWidth);
				stageRef.current.height(containerHeight);

				// Adjust scale to fit after resize
				const scaleX = containerWidth / image.naturalWidth;
				const scaleY = containerHeight / image.naturalHeight;
				const newScale = Math.min(scaleX, scaleY);

				// Center the image
				const centerX =
					(containerWidth - image.naturalWidth * newScale) / 2;
				const centerY =
					(containerHeight - image.naturalHeight * newScale) / 2;

				setScale(newScale);
				setPosition({ x: centerX, y: centerY });
			}
		};

		// Set initial size
		handleResize();

		// Add resize event listener
		window.addEventListener("resize", handleResize);

		return () => {
			window.removeEventListener("resize", handleResize);
		};
	}, [image]);

	// Handle deselection
	const checkDeselect = (
		e: Konva.KonvaEventObject<MouseEvent | TouchEvent>
	) => {
		if (reviewMode) return;

		const clickedOnEmpty = e.target === e.target.getStage();
		if (clickedOnEmpty) {
			setSelectedId(null);
		}
	};

	// Handle wheel zoom
	const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
		e.evt.preventDefault();

		if (!stageRef.current) return;

		const oldScale = scale;
		const pointer = stageRef.current.getPointerPosition();

		if (!pointer) return;

		const mousePointTo = {
			x: (pointer.x - position.x) / oldScale,
			y: (pointer.y - position.y) / oldScale,
		};

		// Determine the direction and zoom factor
		const direction = e.evt.deltaY < 0 ? 1 : -1;
		const zoomFactor = e.evt.ctrlKey ? 0.1 : 0.05;
		const newScale = Math.max(
			0.1,
			Math.min(oldScale * (1 + direction * zoomFactor), 10)
		);

		setScale(newScale);

		const newPos = {
			x: pointer.x - mousePointTo.x * newScale,
			y: pointer.y - mousePointTo.y * newScale,
		};

		setPosition(newPos);
	};

	// Handle mouse down for panning
	const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
		if (e.evt.button === 1 || (e.evt.button === 0 && e.evt.shiftKey)) {
			// Middle mouse button or Shift+left click for panning
			e.evt.preventDefault();
			e.evt.stopPropagation();

			setIsPanning(true);

			const pointer = stageRef.current?.getPointerPosition();
			if (pointer) {
				setLastPointerPosition(pointer);
			}

			if (stageRef.current) {
				stageRef.current.container().style.cursor = "grabbing";
			}
		}
	};

	// Handle mouse move for panning
	const handleMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
		if (!isPanning || !lastPointerPosition) return;

		e.evt.preventDefault();

		const pointer = stageRef.current?.getPointerPosition();
		if (!pointer) return;

		const dx = pointer.x - lastPointerPosition.x;
		const dy = pointer.y - lastPointerPosition.y;

		setPosition({
			x: position.x + dx,
			y: position.y + dy,
		});

		setLastPointerPosition(pointer);
	};

	// Handle mouse up to end panning
	const handleMouseUp = () => {
		if (isPanning) {
			setIsPanning(false);
			setLastPointerPosition(null);

			if (stageRef.current) {
				stageRef.current.container().style.cursor = "default";
			}
		}
	};

	// Generate rectangles from shapes
	const shapesArray = shapes.map((shape, i) => (
		<Rect
			key={i}
			id={`rect-${i}`}
			x={shape.x}
			y={shape.y}
			width={shape.width}
			height={shape.height}
			fill={shape.fill}
			opacity={shape.opacity}
			draggable={!reviewMode}
			onClick={(e) => {
				e.cancelBubble = true;

				if (reviewMode) {
					// Toggle visibility in review mode
					const rect = e.target as Konva.Rect;
					rect.visible(!rect.visible());
					rect.getLayer()?.batchDraw();
				} else {
					setSelectedId(`rect-${i}`);
				}
			}}
			onTap={(e) => {
				e.cancelBubble = true;

				if (reviewMode) {
					// Toggle visibility in review mode
					const rect = e.target as Konva.Rect;
					rect.visible(!rect.visible());
					rect.getLayer()?.batchDraw();
				} else {
					setSelectedId(`rect-${i}`);
				}
			}}
			onDragEnd={(e) => {
				// Update shape position after dragging
				const rect = e.target as Konva.Rect;
				const index = shapes.findIndex(
					(s) =>
						s.x === shape.x &&
						s.y === shape.y &&
						s.width === shape.width &&
						s.height === shape.height
				);

				if (index !== -1) {
					const updatedShapes = [...shapes];
					updatedShapes[index] = {
						...shapes[index],
						x: rect.x(),
						y: rect.y(),
					};
					setShapes(updatedShapes);
				}
			}}
			onTransformEnd={(e) => {
				// Update shape dimensions after transformation
				const rect = e.target as Konva.Rect;
				const index = shapes.findIndex(
					(s) =>
						s.x === shape.x &&
						s.y === shape.y &&
						s.width === shape.width &&
						s.height === shape.height
				);

				if (index !== -1) {
					// Calculate new dimensions based on scale
					const newWidth = rect.width() * rect.scaleX();
					const newHeight = rect.height() * rect.scaleY();

					// Reset scale to avoid compound scaling
					rect.scaleX(1);
					rect.scaleY(1);
					rect.width(newWidth);
					rect.height(newHeight);

					const updatedShapes = [...shapes];
					updatedShapes[index] = {
						...shapes[index],
						x: rect.x(),
						y: rect.y(),
						width: newWidth,
						height: newHeight,
					};
					setShapes(updatedShapes);
				}
			}}
		/>
	));

	return (
		<div className="relative flex-1 overflow-hidden border border-gray-300 dark:border-gray-600">
			<Stage
				ref={stageRef}
				width={window.innerWidth}
				height={window.innerHeight - 100} // Subtract header height
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				onWheel={handleWheel}
				onClick={checkDeselect}
				onTouchStart={checkDeselect}
				scaleX={scale}
				scaleY={scale}
				x={position.x}
				y={position.y}
			>
				<Layer>
					{image && (
						<KonvaImage
							image={image}
							width={image.naturalWidth}
							height={image.naturalHeight}
						/>
					)}
				</Layer>
				<Layer>
					{shapesArray}
					<Transformer
						ref={transformerRef}
						keepRatio={false}
						enabledAnchors={[
							"top-left",
							"top-center",
							"top-right",
							"middle-left",
							"middle-right",
							"bottom-left",
							"bottom-center",
							"bottom-right",
						]}
						rotateEnabled={false}
						borderStroke="#0096FF"
						borderStrokeWidth={2}
						anchorStroke="#0096FF"
						anchorFill="#FFFFFF"
						anchorSize={10}
						visible={!reviewMode}
					/>
				</Layer>
			</Stage>

			{/* Gesture info */}
			<div className="absolute z-10 p-2 text-xs text-white bg-black rounded pointer-events-none bottom-2 right-2 bg-opacity-70">
				<div className="flex items-center mb-1">
					<svg
						className="w-3 h-3 mr-1"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
					>
						<path
							d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					<span>Scroll to zoom</span>
				</div>
				<div className="flex items-center">
					<svg
						className="w-3 h-3 mr-1"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
					>
						<path
							d="M19 12H5M12 19V5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					<span>Shift+drag or middle-click to pan</span>
				</div>
			</div>
		</div>
	);
};

export default OcclusionCanvas;
