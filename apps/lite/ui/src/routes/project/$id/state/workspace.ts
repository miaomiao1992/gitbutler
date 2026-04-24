import { OperationType } from "#ui/Operation.ts";
import { Match } from "effect";
import {
	branchItem,
	changesSectionItem,
	commitItem,
	type BranchItem,
	type CommitItem,
	type Item,
} from "../workspace/Item.ts";
import {
	defaultWorkspaceMode,
	dragAndDropOperationMode,
	getOperationMode,
	isValidWorkspaceModeForSelectedItem,
	moveOperationMode,
	operationWorkspaceMode,
	renameBranchWorkspaceMode,
	rewordCommitWorkspaceMode,
	rubOperationMode,
	type WorkspaceMode,
} from "../workspace/WorkspaceMode.ts";

export type WorkspaceSelectionState = {
	item: Item;
};

const createInitialWorkspaceSelectionState = (): WorkspaceSelectionState => ({
	item: changesSectionItem,
});

export type WorkspaceState = {
	highlightedCommitIds: Array<string>;
	mode: WorkspaceMode;
	selection: WorkspaceSelectionState;
};

export const createInitialState = (): WorkspaceState => ({
	highlightedCommitIds: [],
	mode: defaultWorkspaceMode,
	selection: createInitialWorkspaceSelectionState(),
});

export const initialState: WorkspaceState = createInitialState();

export const enterMoveMode = (state: WorkspaceState, source: Item) => {
	state.mode = operationWorkspaceMode(moveOperationMode({ source }));
};

export const enterRubMode = (state: WorkspaceState, source: Item) => {
	state.mode = operationWorkspaceMode(rubOperationMode({ source }));
};

export const enterDragAndDropMode = (state: WorkspaceState, source: Item) => {
	state.mode = operationWorkspaceMode(dragAndDropOperationMode({ source, operationType: null }));
};

export const updateDragAndDropMode = (
	state: WorkspaceState,
	operationType: OperationType | null,
) => {
	Match.value(state.mode).pipe(
		Match.tags({
			Operation: ({ value }) => {
				Match.value(value).pipe(
					Match.tags({
						DragAndDrop: (mode) => {
							state.mode = operationWorkspaceMode(
								dragAndDropOperationMode({ source: mode.source, operationType }),
							);
						},
					}),
					Match.orElse(() => {}),
				);
			},
		}),
		Match.orElse(() => {}),
	);
};

export const exitMode = (state: WorkspaceState) => {
	state.mode = defaultWorkspaceMode;
};

export const selectItem = (state: WorkspaceState, item: Item) => {
	state.selection.item = item;
	if (!isValidWorkspaceModeForSelectedItem({ mode: state.mode, selectedItem: item }))
		state.mode = defaultWorkspaceMode;
};

export const setHighlightedCommitIds = (state: WorkspaceState, commitIds: Array<string> | null) => {
	state.highlightedCommitIds = commitIds ?? [];
};

export const startRenameBranch = (state: WorkspaceState, item: BranchItem) => {
	selectItem(state, branchItem(item));
	state.mode = renameBranchWorkspaceMode({
		stackId: item.stackId,
		branchRef: item.branchRef,
	});
};

export const startRewordCommit = (state: WorkspaceState, item: CommitItem) => {
	selectItem(state, commitItem(item));
	state.mode = rewordCommitWorkspaceMode({
		stackId: item.stackId,
		commitId: item.commitId,
	});
};

const selectSelection = (state: WorkspaceState): WorkspaceSelectionState => state.selection;

export const selectSelectedItem = (state: WorkspaceState): Item => selectSelection(state).item;

export const selectMode = (state: WorkspaceState): WorkspaceMode => state.mode;

export const selectOperationMode = (state: WorkspaceState) => getOperationMode(state.mode);

export const selectHighlightedCommitIds = (state: WorkspaceState): Array<string> =>
	state.highlightedCommitIds;
