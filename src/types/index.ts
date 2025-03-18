import Konva from "konva";
import { TFile } from "obsidian";

// Main shape type for occlusion
export interface OcclusionShape {
	x: number;
	y: number;
	width: number;
	height: number;
	fill: string;
	opacity: number;
}

// Store of occlusion data keyed by file path
export interface OcclusionData {
	attachments: { [filePath: string]: OcclusionShape[] };
}

// Props for the main editor component
export interface OcclusionEditorProps {
	plugin: any;
	onClose: () => void;
	selectedFilePath?: string;
}

// Props for the image canvas component
export interface ImageCanvasProps {
	plugin: any;
	selectedFile: string;
	reviewMode: boolean;
	onShapeSelect: (rect: Konva.Rect | null) => void;
	shapes?: OcclusionShape[];
	onShapesChange?: (shapes: OcclusionShape[]) => void;
}

// Props for the image controls component
export interface ImageControlsProps {
	selectedFile: string;
	imageFiles: TFile[];
	onFileSelect: (filePath: string) => void;
	reviewMode: boolean;
	toggleReviewMode: () => void;
}

// Props for the shape controls component
export interface ShapeControlsProps {
	selectedRect: Konva.Rect | null;
	reviewMode: boolean;
	onAddRect: () => void;
	onDeleteRect: () => void;
	onSave: () => void;
}
