import React, { useEffect, useRef, useState, useMemo } from "react";
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
	shapes: propShapes = [],
	onShapesChange,
}) => {
	// State for image and shapes
	const [image, setImage] = useState<HTMLImageElement | null>(null);
	const [shapes, setShapes] = useState<OcclusionShape[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [isAddingRect, setIsAddingRect] = useState(false);
	const [updatedLocally, setUpdatedLocally] = useState(false);

	// State for zoom and pan
	const [scale, setScale] = useState(1);
	const [position, setPosition] = useState({ x: 0, y: 0 });
	const [isPanning, setIsPanning] = useState(false);
	const [isSpacePressed, setIsSpacePressed] = useState(false);
	const [lastPointerPosition, setLastPointerPosition] = useState<{
		x: number;
		y: number;
	} | null>(null);

	// Remove container size state
	// const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
	const containerRef = useRef<HTMLDivElement>(null);

	// Refs
	const stageRef = useRef<Konva.Stage>(null);
	const transformerRef = useRef<Konva.Transformer>(null);

	// Use shapes from props
	useEffect(() => {
		// Only update local shapes from props if they're different
		// Use JSON comparison to avoid unnecessary updates
		const currentShapesJson = JSON.stringify(shapes);
		const propsShapesJson = JSON.stringify(propShapes);

		if (currentShapesJson !== propsShapesJson) {
			setShapes(propShapes);
			setUpdatedLocally(false); // Reset the flag as we're getting shapes from props
		}
	}, [propShapes]);

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
				};
				img.src = url;
			} catch (error) {
				console.error("Error loading image:", error);
				new Notice("Error loading image");
			}
		};

		loadImage();
	}, [selectedFile]);

	// Update shapes in parent component when local shapes change
	useEffect(() => {
		// Only send updates to the parent if we made local changes (not from prop updates)
		if (onShapesChange && updatedLocally) {
			onShapesChange(shapes);
			setUpdatedLocally(false); // Reset the flag after notifying parent
		}
	}, [shapes, onShapesChange, updatedLocally]);

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

	// Handle stage resize - revert to original implementation
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
		e.evt.stopPropagation(); // Keep this to prevent scrolling

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

	// Handle space bar key events for panning
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.code === "Space") {
				// Prevent default space bar behavior (scrolling)
				e.preventDefault();

				if (!isSpacePressed) {
					setIsSpacePressed(true);
					if (stageRef.current) {
						stageRef.current.container().style.cursor = "grabbing";
					}
				}
			}
		};

		const handleKeyUp = (e: KeyboardEvent) => {
			if (e.code === "Space") {
				e.preventDefault(); // Prevent default space bar behavior
				setIsSpacePressed(false);
				if (stageRef.current) {
					stageRef.current.container().style.cursor = "default";
				}
				setIsPanning(false);
				setLastPointerPosition(null);
			}
		};

		// Keep the container focusable approach
		const container = containerRef.current;
		if (container) {
			container.addEventListener("keydown", handleKeyDown);
			container.addEventListener("keyup", handleKeyUp);
			// Make the container focusable
			container.tabIndex = 0;
		}

		return () => {
			if (container) {
				container.removeEventListener("keydown", handleKeyDown);
				container.removeEventListener("keyup", handleKeyUp);
			}
		};
	}, [isSpacePressed, containerRef.current]);

	// Handle mouse down for panning
	const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
		if (
			e.evt.button === 1 ||
			(e.evt.button === 0 && e.evt.shiftKey) ||
			(e.evt.button === 0 && isSpacePressed)
		) {
			// Middle mouse button, Shift+left click, or Space+left click for panning
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

	// Generate rectangles from shapes using useMemo to reduce re-renders
	const shapesArray = useMemo(() => {
		return shapes.map((shape, i) => (
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
					const index = parseInt(rect.id().split("-")[1]);

					if (index >= 0 && index < shapes.length) {
						// Create a new array with the updated shape to ensure React detects the change
						const updatedShapes = shapes.map((shape, i) => {
							if (i === index) {
								return {
									...shape,
									x: rect.x(),
									y: rect.y(),
								};
							}
							return shape;
						});

						// Only update if there's an actual change
						if (
							JSON.stringify(updatedShapes) !==
							JSON.stringify(shapes)
						) {
							setShapes(updatedShapes);
							setUpdatedLocally(true); // Set flag for local update
						}
					}
				}}
				onTransformEnd={(e) => {
					// Update shape dimensions after transformation
					const rect = e.target as Konva.Rect;
					const index = parseInt(rect.id().split("-")[1]);

					if (index >= 0 && index < shapes.length) {
						// Calculate new dimensions based on scale
						const newWidth = rect.width() * rect.scaleX();
						const newHeight = rect.height() * rect.scaleY();

						// Reset scale to avoid compound scaling
						rect.scaleX(1);
						rect.scaleY(1);
						rect.width(newWidth);
						rect.height(newHeight);

						// Create a new array with the updated shape
						const updatedShapes = shapes.map((shape, i) => {
							if (i === index) {
								return {
									...shape,
									x: rect.x(),
									y: rect.y(),
									width: newWidth,
									height: newHeight,
								};
							}
							return shape;
						});

						// Only update if there's an actual change
						if (
							JSON.stringify(updatedShapes) !==
							JSON.stringify(shapes)
						) {
							setShapes(updatedShapes);
							setUpdatedLocally(true); // Set flag for local update
						}
					}
				}}
			/>
		));
	}, [shapes, reviewMode]);

	// Add a public method for adding a rectangle
	const addRect = () => {
		setIsAddingRect(true);
	};

	// Handle stage click for adding a rectangle
	const handleStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
		// Keep the focus when clicked
		containerRef.current?.focus();

		if (!isAddingRect || reviewMode) {
			// If not in add mode, just do regular deselect
			checkDeselect(e);
			return;
		}

		// Get click position relative to the stage
		const stage = e.target.getStage();
		if (!stage) return;

		const position = stage.getPointerPosition();
		if (!position) return;

		// Convert position to image coordinates
		const x = (position.x - stage.x()) / scale;
		const y = (position.y - stage.y()) / scale;

		// Create new rectangle
		const newRect: OcclusionShape = {
			x,
			y,
			width: 100,
			height: 100,
			fill: "#000000",
			opacity: 0.5,
		};

		// Add to shapes - create a new array to ensure React detects the change
		const updatedShapes = [...shapes, newRect];

		// Only update if shapes actually changed
		if (JSON.stringify(updatedShapes) !== JSON.stringify(shapes)) {
			setShapes(updatedShapes);
			setUpdatedLocally(true); // Set flag for local update
			setIsAddingRect(false);
			new Notice("Rectangle added");
		} else {
			setIsAddingRect(false);
		}
	};

	return (
		<div
			ref={containerRef}
			className="relative flex-1 overflow-hidden border border-gray-300 dark:border-gray-600"
			style={{ width: "100%", height: "100%" }}
			tabIndex={0} // Keep the container focusable
			onFocus={() => {}} // Empty handler to ensure focus works
			// Prevent default space bar behavior at this level too
			onKeyDown={(e) => {
				if (e.code === "Space") {
					e.preventDefault();
					e.stopPropagation();
				}
			}}
		>
			<Stage
				ref={stageRef}
				width={window.innerWidth} // Revert to using window dimensions
				height={window.innerHeight - 100} // Revert to original height calculation
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				onWheel={handleWheel}
				onClick={handleStageClick}
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
			{/* Tooltip removed */}
		</div>
	);
};

export default OcclusionCanvas;
