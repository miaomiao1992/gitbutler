import {
	commitDiscardMutationOptions,
	commitInsertBlankMutationOptions,
	commitRewordMutationOptions,
	unapplyStackMutationOptions,
	updateBranchNameMutationOptions,
} from "#ui/api/mutations.ts";
import {
	absorptionPlanQueryOptions,
	branchDetailsQueryOptions,
	branchDiffQueryOptions,
	changesInWorktreeQueryOptions,
	commitDetailsWithLineStatsQueryOptions,
	headInfoQueryOptions,
	listProjectsQueryOptions,
	treeChangeDiffsQueryOptions,
} from "#ui/api/queries.ts";
import { classes } from "#ui/classes.ts";
import {
	branchFileParent,
	changesFileParent,
	commitFileParent,
	type FileParent,
} from "#ui/domain/FileParent.ts";
import { getBranchNameByCommitId, getCommonBaseCommitId } from "#ui/domain/RefInfo.ts";
import { useActiveElement } from "#ui/focus.ts";
import { DependencyIcon, ExpandCollapseIcon, MenuTriggerIcon, PushIcon } from "#ui/icons.tsx";
import {
	showNativeContextMenu,
	showNativeMenuFromTrigger,
	type NativeMenuItem,
} from "#ui/native-menu.ts";
import {
	assert,
	CommitLabel,
	commitTitle,
	decodeRefName,
	encodeRefName,
	formatHunkHeader,
	shortCommitId,
} from "#ui/routes/project/$id/shared.tsx";
import {
	isPanelVisible,
	orderedPanels,
	Panel as PanelType,
} from "#ui/routes/project/$id/state/layout.ts";
import {
	projectActions,
	selectProjectExpandedCommitId,
	selectProjectHighlightedCommitIds,
	selectProjectLayoutState,
	selectProjectOperationModeState,
	selectProjectPickerDialogState,
	selectProjectSelectedItem,
	selectProjectWorkspaceModeState,
} from "#ui/routes/project/$id/state/projectSlice.ts";
import { AbsorptionDialog } from "#ui/routes/project/$id/workspace/Absorption.tsx";
import { OperationSourceC } from "#ui/routes/project/$id/workspace/OperationSourceC.tsx";
import { OperationSourceLabel } from "#ui/routes/project/$id/workspace/OperationSourceLabel.tsx";
import { OperationTarget } from "#ui/routes/project/$id/workspace/OperationTarget.tsx";
import { ShortcutsBarPortal, TopBarActionsPortal } from "#ui/routes/LayoutPortals.tsx";
import { ShortcutButton } from "#ui/ShortcutButton.tsx";
import { useAppDispatch, useAppSelector } from "#ui/state/hooks.ts";
import { isInputElement } from "#ui/TanStackHotkeys.ts";
import uiStyles from "#ui/ui.module.css";
import { mergeProps, Tooltip, useRender } from "@base-ui/react";
import { Toolbar } from "@base-ui/react/toolbar";
import { useMergedRefs } from "@base-ui/utils/useMergedRefs";
import {
	AbsorptionTarget,
	Commit,
	DiffHunk,
	HunkDependencies,
	HunkHeader,
	Segment,
	Stack,
	TreeChange,
	UnifiedPatch,
} from "@gitbutler/but-sdk";
import { PatchDiff } from "@pierre/diffs/react";
import {
	formatForDisplay,
	getHotkeyManager,
	useHotkey,
	useHotkeyRegistrations,
	useHotkeySequence,
	useHotkeys,
	type HotkeyRegistrationView,
} from "@tanstack/react-hotkeys";
import {
	useMutation,
	useQueryClient,
	useSuspenseQueries,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Array, Match, pipe } from "effect";
import { isNonEmptyArray, NonEmptyArray } from "effect/Array";
import {
	ComponentProps,
	FC,
	Fragment,
	ReactNode,
	Ref,
	Suspense,
	useEffect,
	useLayoutEffect,
	useOptimistic,
	useRef,
	useState,
	useTransition,
} from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import {
	baseCommitItem,
	branchItem,
	changesSectionItem,
	commitItem,
	fileItem,
	hunkItem,
	itemEquals,
	itemIdentityKey,
	stackItem,
	type BranchItem,
	type CommitItem,
	type Item,
} from "./Item.ts";
import { PickerDialog, type PickerDialogGroup } from "./PickerDialog.tsx";
import styles from "./WorkspacePage.module.css";
import { includeItemForWorkspaceMode, isValidWorkspaceMode } from "./WorkspaceMode.ts";
import {
	buildNavigationIndex,
	filterNavigationIndex,
	getAdjacent,
	getNextSection,
	getPreviousSection,
	navigationIndexIncludes,
	useWorkspaceOutline,
	type NavigationIndex,
} from "./WorkspaceModel.ts";

const getFocusedProjectPanel = (activeElement: Element | null) =>
	(activeElement?.closest("[data-panel]")?.id as PanelType | undefined) ?? null;

const useFocusedProjectPanel = (projectId: string): PanelType | null => {
	const activeElement = useActiveElement();
	const focusedPanel = getFocusedProjectPanel(activeElement);
	const pickerDialog = useAppSelector((state) => selectProjectPickerDialogState(state, projectId));
	return pickerDialog._tag === "CommandPalette" ? pickerDialog.focusedPanel : focusedPanel;
};

const useProjectPanelFocusManager = () => {
	const panelElementsRef = useRef(new Map<PanelType, HTMLDivElement>());
	const panelElementRef =
		(panel: PanelType) =>
		(element: HTMLDivElement | null): void => {
			if (element) panelElementsRef.current.set(panel, element);
			else panelElementsRef.current.delete(panel);
		};
	const focusPanel = (panel: PanelType) => {
		panelElementsRef.current.get(panel)?.focus({ focusVisible: false });
	};
	const focusAdjacentPanel = (offset: -1 | 1) => {
		const currentPanel = getFocusedProjectPanel(document.activeElement);
		if (currentPanel === null) return;
		const nextPanel = orderedPanels[orderedPanels.indexOf(currentPanel) + offset];
		if (nextPanel === undefined) return;
		focusPanel(nextPanel);
	};

	return {
		focusAdjacentPanel,
		focusPanel,
		panelElementRef,
	};
};

const LogPanel: FC<{
	elementRef: Ref<HTMLDivElement | null>;
	focusPanel: (panel: PanelType) => void;
	navigationIndex: NavigationIndex;
	onAbsorbChanges: (target: AbsorptionTarget) => void;
}> = ({ elementRef, focusPanel, navigationIndex, onAbsorbChanges }) => {
	const dispatch = useAppDispatch();
	const { id: projectId } = useParams({ from: "/project/$id/workspace" });
	const { data: headInfo } = useSuspenseQuery(headInfoQueryOptions(projectId));
	const selectedItem = useAppSelector((state) => selectProjectSelectedItem(state, projectId));
	const focusedPanel = useFocusedProjectPanel(projectId);
	const operationMode = useAppSelector((state) =>
		selectProjectOperationModeState(state, projectId),
	);
	const commit = () =>
		dispatch(
			projectActions.enterMoveMode({
				projectId,
				source: changesSectionItem,
			}),
		);

	useLogSelectionHotkeys({
		enabled: focusedPanel === "log",
		navigationIndex,
		projectId,
	});

	return (
		<Panel
			id={"log" satisfies PanelType}
			minSize={400}
			elementRef={elementRef}
			tabIndex={0}
			role="tree"
			aria-activedescendant={treeItemId(projectId, selectedItem)}
			className={classes(styles.panel, styles.logPanel)}
		>
			<div className={styles.sections}>
				<Changes
					projectId={projectId}
					onAbsorbChanges={onAbsorbChanges}
					onCommit={commit}
					navigationIndex={navigationIndex}
				/>

				{headInfo.stacks.map((stack) => (
					<StackC
						key={stack.id}
						projectId={projectId}
						stack={stack}
						navigationIndex={navigationIndex}
						focusPanel={focusPanel}
					/>
				))}

				<BaseCommit
					projectId={projectId}
					commitId={getCommonBaseCommitId(headInfo)}
					navigationIndex={navigationIndex}
				/>
			</div>

			{Match.value(operationMode).pipe(
				Match.when(null, () => null),
				Match.tag("DragAndDrop", () => null),
				Match.orElse(({ source }) => (
					<div className={styles.operationModePreview}>
						<OperationSourceLabel headInfo={headInfo} source={source} />
					</div>
				)),
			)}
		</Panel>
	);
};

const DetailsPanel: FC<{
	elementRef: Ref<HTMLDivElement | null>;
	focusPanel: (panel: PanelType) => void;
}> = ({ elementRef, focusPanel }) => {
	const dispatch = useAppDispatch();
	const { id: projectId } = useParams({ from: "/project/$id/workspace" });
	const selectedItem = useAppSelector((state) => selectProjectSelectedItem(state, projectId));
	const focusedPanel = useFocusedProjectPanel(projectId);

	useHotkey(
		"Escape",
		() => {
			dispatch(projectActions.hidePanel({ projectId, panel: "details" }));
			focusPanel("log");
		},
		{
			conflictBehavior: "allow",
			enabled: focusedPanel === "details",
			meta: { group: "Details", name: "Close" },
		},
	);

	return (
		<Panel
			id={"details" satisfies PanelType}
			minSize={300}
			defaultSize="70%"
			elementRef={elementRef}
			tabIndex={0}
			className={styles.panel}
		>
			<Suspense fallback={<div>Loading details…</div>}>
				<Details projectId={projectId} selectedItem={selectedItem} />
			</Suspense>
		</Panel>
	);
};

type HotkeyGroup =
	| "Branch"
	| "Changes file"
	| "Changes"
	| "Commit file"
	| "Commit"
	| "Details"
	| "Global"
	| "Log selection"
	| "Operation mode"
	| "Panels"
	| "Rename branch"
	| "Reword commit"
	| "Stack";

declare module "@tanstack/react-hotkeys" {
	interface HotkeyMeta {
		/**
		 * The component where the hotkey is registered.
		 */
		group: HotkeyGroup;
		/**
		 * @default true
		 *
		 * Whether or not to display the command and/or hotkey in the command palette.
		 */
		commandPalette?: boolean | "hideHotkey";
		/**
		 * @default true
		 *
		 * Whether or not to display the command and associated hotkey in the shortcuts bar.
		 */
		shortcutsBar?: boolean;
	}
}

type HunkDependencyDiff = HunkDependencies["diffs"][number];

const useIsItemSelected = ({ projectId, item }: { projectId: string; item: Item }): boolean =>
	useAppSelector((state) => {
		const selectedItem = selectProjectSelectedItem(state, projectId);

		return itemEquals(selectedItem, item);
	});

const treeItemId = (projectId: string, item: Item): string =>
	`project-${encodeURIComponent(projectId)}-treeitem-${encodeURIComponent(itemIdentityKey(item))}`;

const useLogSelectionHotkeys = ({
	enabled,
	navigationIndex,
	projectId,
}: {
	enabled: boolean;
	navigationIndex: NavigationIndex;
	projectId: string;
}) => {
	const dispatch = useAppDispatch();
	const selectedItem = useAppSelector((state) => selectProjectSelectedItem(state, projectId));

	const moveSelection = (offset: -1 | 1) => {
		const newItem = getAdjacent({ navigationIndex, selectedItem, offset });
		if (!newItem) return;
		dispatch(projectActions.selectItem({ projectId, item: newItem }));
	};

	const selectNextSection = () => {
		const newItem = getNextSection({ navigationIndex, selectedItem });
		if (!newItem) return;
		dispatch(projectActions.selectItem({ projectId, item: newItem }));
	};

	const selectPreviousSection = () => {
		const newItem = getPreviousSection({ navigationIndex, selectedItem });
		if (!newItem) return;
		dispatch(projectActions.selectItem({ projectId, item: newItem }));
	};

	const selectChanges = () => {
		dispatch(projectActions.selectItem({ projectId, item: changesSectionItem }));
	};

	const selectFirstItem = () => {
		const newItem = navigationIndex.items[0];
		if (!newItem) return;
		dispatch(projectActions.selectItem({ projectId, item: newItem }));
	};

	const selectLastItem = () => {
		const newItem = navigationIndex.items.at(-1);
		if (!newItem) return;
		dispatch(projectActions.selectItem({ projectId, item: newItem }));
	};

	useHotkeys(
		[
			{
				hotkey: "ArrowUp",
				callback: () => moveSelection(-1),
				options: { meta: { group: "Log selection", name: "Up", commandPalette: false } },
			},
			{
				hotkey: "K",
				callback: () => moveSelection(-1),
				// Hidden until we can combine in shortcuts bar.
				options: { meta: { group: "Log selection", shortcutsBar: false } },
			},
			{
				hotkey: "ArrowDown",
				callback: () => moveSelection(1),
				options: { meta: { group: "Log selection", name: "Down", commandPalette: false } },
			},
			{
				hotkey: "J",
				callback: () => moveSelection(1),
				// Hidden until we can combine in shortcuts bar.
				options: { meta: { group: "Log selection", shortcutsBar: false } },
			},
			{
				hotkey: "Shift+ArrowUp",
				callback: selectPreviousSection,
				options: {
					meta: {
						group: "Log selection",
						name: "Previous section",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
			{
				hotkey: "Shift+K",
				callback: selectPreviousSection,
				options: {
					meta: {
						group: "Log selection",
						name: "Previous section",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
			{
				hotkey: "Shift+ArrowDown",
				callback: selectNextSection,
				options: {
					meta: {
						group: "Log selection",
						name: "Next section",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
			{
				hotkey: "Shift+J",
				callback: selectNextSection,
				options: {
					meta: {
						group: "Log selection",
						name: "Next section",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
			{
				hotkey: "Z",
				callback: selectChanges,
				options: { meta: { group: "Log selection", name: "Changes" } },
			},
			{
				hotkey: "Home",
				callback: selectFirstItem,
				options: {
					meta: {
						group: "Log selection",
						name: "First item",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
			{
				hotkey: "Meta+ArrowUp",
				callback: selectFirstItem,
				options: {
					meta: {
						group: "Log selection",
						name: "First item",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
			{
				hotkey: "End",
				callback: selectLastItem,
				options: {
					meta: {
						group: "Log selection",
						name: "Last item",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
			{
				hotkey: "Meta+ArrowDown",
				callback: selectLastItem,
				options: {
					meta: {
						group: "Log selection",
						name: "Last item",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
			{
				hotkey: "Shift+G",
				callback: selectLastItem,
				options: {
					meta: {
						group: "Log selection",
						name: "Last item",
						commandPalette: false,
						shortcutsBar: false,
					},
				},
			},
		],
		{ enabled },
	);

	useHotkeySequence(["G", "G"], selectFirstItem, {
		enabled,
		meta: {
			group: "Log selection",
			name: "First item",
			commandPalette: false,
			shortcutsBar: false,
		},
	});

	useHotkey(
		"T",
		() => {
			dispatch(projectActions.openBranchPicker({ projectId }));
		},
		{ meta: { group: "Log selection", name: "Branch" } },
	);

	const workspaceMode = useAppSelector((state) =>
		selectProjectWorkspaceModeState(state, projectId),
	);

	useHotkeys(
		[
			{
				hotkey: "M",
				callback: () => {
					dispatch(projectActions.enterMoveMode({ projectId, source: selectedItem }));
				},
				options: { meta: { group: "Log selection", name: "Move" } },
			},
			{
				hotkey: "Mod+X",
				callback: () => {
					dispatch(projectActions.enterMoveMode({ projectId, source: selectedItem }));
				},
				options: { meta: { group: "Log selection", name: "Cut" } },
			},
			{
				hotkey: "R",
				callback: () => {
					dispatch(projectActions.enterRubMode({ projectId, source: selectedItem }));
				},
				options: { meta: { group: "Log selection", name: "Rub" } },
			},
			{
				hotkey: "C",
				callback: () => {
					dispatch(projectActions.enterMoveMode({ projectId, source: changesSectionItem }));
				},
				options: { meta: { group: "Log selection", name: "Commit" } },
			},
		],
		{ enabled: enabled && workspaceMode._tag === "Default" },
	);
};

const lineEndingForDiff = (diff: string): string => (diff.includes("\r\n") ? "\r\n" : "\n");

const patchHeaderForChange = (change: TreeChange, lineEnding: string): string =>
	Match.value(change.status).pipe(
		Match.when(
			{ type: "Addition" },
			() => `--- /dev/null${lineEnding}+++ ${change.path}${lineEnding}`,
		),
		Match.when(
			{ type: "Deletion" },
			() => `--- ${change.path}${lineEnding}+++ /dev/null${lineEnding}`,
		),
		Match.when(
			{ type: "Modification" },
			() => `--- ${change.path}${lineEnding}+++ ${change.path}${lineEnding}`,
		),
		Match.when(
			{ type: "Rename" },
			({ subject }) => `--- ${subject.previousPath}${lineEnding}+++ ${change.path}${lineEnding}`,
		),
		Match.exhaustive,
	);

const HunkDiff: FC<{
	change: TreeChange;
	diff: string;
}> = ({ change, diff }) => (
	<PatchDiff
		patch={`${patchHeaderForChange(change, lineEndingForDiff(diff))}${diff}`}
		options={{
			diffStyle: "unified",
			themeType: "system",
			disableFileHeader: true,
		}}
	/>
);

const hunkKey = (hunk: HunkHeader): string =>
	`${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}`;

const fileRowLabel = (change: TreeChange) => {
	const status = Match.value(change.status).pipe(
		Match.when({ type: "Addition" }, () => "A"),
		Match.when({ type: "Deletion" }, () => "D"),
		Match.when({ type: "Modification" }, () => "M"),
		Match.when({ type: "Rename" }, () => "R"),
		Match.exhaustive,
	);

	return `${status} ${change.path}`;
};

const CommitFiles: FC<{
	projectId: string;
	commitId: string;
	renderFile: (change: TreeChange) => ReactNode;
}> = ({ projectId, commitId, renderFile }) => {
	const { data } = useSuspenseQuery(
		commitDetailsWithLineStatsQueryOptions({ projectId, commitId }),
	);

	const conflictedPaths = data.conflictEntries
		? globalThis.Array.from(
				new Set([
					...data.conflictEntries.ancestorEntries,
					...data.conflictEntries.ourEntries,
					...data.conflictEntries.theirEntries,
				]),
			).sort((a: string, b: string) => a.localeCompare(b))
		: [];

	if (conflictedPaths.length === 0 && data.changes.length === 0)
		return <div className={styles.itemRowEmpty}>No file changes.</div>;

	return (
		<>
			{conflictedPaths.length > 0 && (
				<div>
					<div>Conflicts:</div>
					<ul>
						{conflictedPaths.map((path: string) => (
							<li key={path}>{path}</li>
						))}
					</ul>
				</div>
			)}

			{data.changes.length > 0 && (
				<div role="group">
					{data.changes.map((file) => (
						<Fragment key={file.path}>{renderFile(file)}</Fragment>
					))}
				</div>
			)}
		</>
	);
};

const ItemRowPresentational: FC<
	{
		isSelected?: boolean;
	} & ComponentProps<"div">
> = ({ className, isSelected, ref: refProp, ...props }) => {
	const rowRef = useRef<HTMLDivElement | null>(null);
	const mergedRef = useMergedRefs(rowRef, refProp);

	useLayoutEffect(() => {
		if (!isSelected) return;
		rowRef.current?.scrollIntoView({
			block: "nearest",
			inline: "nearest",
		});
	}, [isSelected]);

	return (
		<div
			{...props}
			ref={mergedRef}
			className={classes(className, styles.itemRow, isSelected && styles.itemRowSelected)}
		/>
	);
};

const ItemRow: FC<
	{
		projectId: string;
		item: Item;
		navigationIndex: NavigationIndex;
	} & Omit<ComponentProps<typeof ItemRowPresentational>, "inert" | "isSelected">
> = ({ projectId, item, navigationIndex, onClick, ...props }) => {
	const dispatch = useAppDispatch();
	const isSelected = useIsItemSelected({ projectId, item });

	return (
		<ItemRowPresentational
			{...props}
			inert={!navigationIndexIncludes(navigationIndex, item)}
			isSelected={isSelected}
			onClick={(event) => {
				onClick?.(event);
				if (!event.defaultPrevented) dispatch(projectActions.selectItem({ projectId, item }));
			}}
		/>
	);
};

const ItemRowToolbar: FC<Omit<ComponentProps<typeof Toolbar.Root>, "className">> = ({
	onClick,
	...props
}) => (
	<Toolbar.Root
		{...props}
		className={styles.itemRowToolbar}
		onClick={(event) => {
			onClick?.(event);
			event.stopPropagation();
		}}
	/>
);

const TreeItem: FC<
	{
		projectId: string;
		item: Item;
		label: string;
		expanded?: boolean;
	} & useRender.ComponentProps<"div">
> = ({ projectId, item, label, expanded, render, ...props }) => {
	const isSelected = useIsItemSelected({ projectId, item });

	return useRender({
		render,
		defaultTagName: "div",
		props: mergeProps<"div">(props, {
			id: treeItemId(projectId, item),
			role: "treeitem",
			"aria-label": label,
			"aria-selected": isSelected,
			"aria-expanded": expanded,
		}),
	});
};

const OperationItem: FC<
	{
		projectId: string;
		item: Item;
	} & useRender.ComponentProps<"div">
> = ({ projectId, item, render, ...props }) => {
	const isSelected = useIsItemSelected({ projectId, item });

	return useRender({
		render: (
			<OperationSourceC
				projectId={projectId}
				source={item}
				render={
					<OperationTarget
						projectId={projectId}
						item={item}
						isSelected={isSelected}
						render={render}
					/>
				}
			/>
		),
		defaultTagName: "div",
		props,
	});
};

const DependencyIndicatorButton: FC<
	{
		projectId: string;
		commitIds: NonEmptyArray<string>;
	} & useRender.ComponentProps<"button">
> = ({ projectId, commitIds, ...restProps }) => {
	// We use a controlled tooltip as a workaround for https://github.com/mui/base-ui/issues/4499.
	const [isTooltipOpen, setIsTooltipOpen] = useState(false);
	const dispatch = useAppDispatch();
	const { data: headInfo } = useSuspenseQuery(headInfoQueryOptions(projectId));
	// TODO: expensive
	const branchNameByCommitId = getBranchNameByCommitId(headInfo);
	const branchNames = pipe(
		commitIds,
		Array.flatMapNullable((commitId) => branchNameByCommitId.get(commitId)),
		Array.dedupe,
	);
	const tooltip =
		branchNames.length > 0 ? `Depends on ${branchNames.join(", ")}` : "Unknown dependencies";
	const highlightCommitIds = () => {
		setIsTooltipOpen(true);
		dispatch(
			projectActions.setHighlightedCommitIds({
				projectId,
				commitIds,
			}),
		);
	};
	const clearHighlightedCommitIds = () => {
		setIsTooltipOpen(false);
		dispatch(projectActions.setHighlightedCommitIds({ projectId, commitIds: null }));
	};

	return (
		<Tooltip.Root
			open={isTooltipOpen}
			// [ref:tooltip-disable-hoverable-popup]
			disableHoverablePopup
		>
			<Tooltip.Trigger
				{...restProps}
				type="button"
				onMouseEnter={highlightCommitIds}
				onMouseLeave={clearHighlightedCommitIds}
				onFocus={highlightCommitIds}
				onBlur={clearHighlightedCommitIds}
				aria-label={tooltip}
			/>
			<Tooltip.Portal>
				<Tooltip.Positioner sideOffset={8}>
					<Tooltip.Popup className={classes(uiStyles.popup, uiStyles.tooltip)}>
						{tooltip}
					</Tooltip.Popup>
				</Tooltip.Positioner>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
};

const hunkContainsHunk = (a: HunkHeader, b: HunkHeader): boolean =>
	a.oldStart <= b.oldStart &&
	a.oldStart + a.oldLines - 1 >= b.oldStart + b.oldLines - 1 &&
	a.newStart <= b.newStart &&
	a.newStart + a.newLines - 1 >= b.newStart + b.newLines - 1;

const getHunkDependencyDiffsByPath = (
	hunkDependencyDiffs: Array<HunkDependencyDiff>,
): Map<string, Array<HunkDependencyDiff>> => {
	const byPath = new Map<string, Array<HunkDependencyDiff>>();

	for (const hunkDependencyDiff of hunkDependencyDiffs) {
		const [path] = hunkDependencyDiff;
		const pathDependencyDiffs = byPath.get(path);
		if (pathDependencyDiffs) pathDependencyDiffs.push(hunkDependencyDiff);
		else byPath.set(path, [hunkDependencyDiff]);
	}

	return byPath;
};

const getDependencyCommitIds = ({
	hunk,
	hunkDependencyDiffs,
}: {
	hunk?: DiffHunk;
	hunkDependencyDiffs: Array<HunkDependencyDiff>;
}): NonEmptyArray<string> | undefined => {
	const commitIds = new Set<string>();

	for (const [, dependencyHunk, locks] of hunkDependencyDiffs) {
		if (hunk && !hunkContainsHunk(hunk, dependencyHunk)) continue;
		for (const dependency of locks) commitIds.add(dependency.commitId);
	}

	const dependencyCommitIds = globalThis.Array.from(commitIds);
	return isNonEmptyArray(dependencyCommitIds) ? dependencyCommitIds : undefined;
};

const Hunk: FC<{
	isResultOfBinaryToTextConversion: boolean;
	projectId: string;
	fileParent: FileParent;
	change: TreeChange;
	hunk: DiffHunk;
	hunkDependencyDiffs?: Array<HunkDependencyDiff>;
}> = ({
	isResultOfBinaryToTextConversion,
	projectId,
	fileParent,
	change,
	hunk,
	hunkDependencyDiffs,
}) => {
	const dependencyCommitIds =
		fileParent._tag === "Changes" && hunkDependencyDiffs
			? getDependencyCommitIds({ hunk, hunkDependencyDiffs })
			: undefined;

	const item = hunkItem({
		parent: fileParent,
		path: change.path,
		hunkHeader: hunk,
		isResultOfBinaryToTextConversion,
	});

	return (
		<div>
			<OperationSourceC projectId={projectId} source={item}>
				<div className={styles.hunkHeaderRow}>
					{dependencyCommitIds && (
						<DependencyIndicatorButton projectId={projectId} commitIds={dependencyCommitIds}>
							<DependencyIcon />
						</DependencyIndicatorButton>
					)}
					<div className={styles.hunkHeader}>{formatHunkHeader(hunk)}</div>
				</div>
			</OperationSourceC>
			<HunkDiff change={change} diff={hunk.diff} />
		</div>
	);
};

const FileDiff: FC<{
	projectId: string;
	change: TreeChange;
	fileParent: FileParent;
	hunkDependencyDiffs?: Array<HunkDependencyDiff>;
	diff: UnifiedPatch | null;
}> = ({ projectId, change, fileParent, hunkDependencyDiffs, diff }) =>
	Match.value(diff).pipe(
		Match.when(null, () => <div>No diff available for this file.</div>),
		Match.when({ type: "Binary" }, () => <div>Binary file (diff not available).</div>),
		Match.when({ type: "TooLarge" }, ({ subject }) => (
			<div>Diff too large ({subject.sizeInBytes} bytes).</div>
		)),
		Match.when({ type: "Patch" }, (patch) => {
			const { hunks } = patch.subject;
			if (hunks.length === 0) return <div>No hunks.</div>;

			return (
				<ul>
					{hunks.map((hunk) => (
						<li key={hunkKey(hunk)}>
							<Hunk
								isResultOfBinaryToTextConversion={patch.subject.isResultOfBinaryToTextConversion}
								projectId={projectId}
								fileParent={fileParent}
								change={change}
								hunk={hunk}
								hunkDependencyDiffs={hunkDependencyDiffs}
							/>
						</li>
					))}
				</ul>
			);
		}),
		Match.exhaustive,
	);

const ChangesFileDiffList: FC<{
	changes: Array<TreeChange>;
	projectId: string;
	fileParent: FileParent;
	hunkDependencyDiffsByPath?: Map<string, Array<HunkDependencyDiff>>;
}> = ({ changes, projectId, fileParent, hunkDependencyDiffsByPath }) => {
	const treeChangeDiffs = useSuspenseQueries({
		queries: changes.map((change) => treeChangeDiffsQueryOptions({ projectId, change })),
	}).map((result) => result.data);
	const changesWithDiffs = pipe(changes, Array.zip(treeChangeDiffs));

	return changesWithDiffs.length === 0 ? (
		<div>No file changes.</div>
	) : (
		<ul>
			{changesWithDiffs.map(([change, diff]) => {
				const source = fileItem({ parent: fileParent, path: change.path });

				return (
					<li key={change.path}>
						<OperationSourceC projectId={projectId} source={source}>
							<h4>{change.path}</h4>
						</OperationSourceC>
						<FileDiff
							projectId={projectId}
							change={change}
							fileParent={fileParent}
							hunkDependencyDiffs={hunkDependencyDiffsByPath?.get(change.path)}
							diff={diff}
						/>
					</li>
				);
			})}
		</ul>
	);
};

const ChangesDetails: FC<{
	projectId: string;
	selectedPath?: string;
}> = ({ projectId, selectedPath }) => {
	const { data: worktreeChanges } = useSuspenseQuery(changesInWorktreeQueryOptions(projectId));
	const hunkDependencyDiffsByPath = getHunkDependencyDiffsByPath(
		worktreeChanges.dependencies?.diffs ?? [],
	);
	const selectedChange =
		selectedPath !== undefined
			? worktreeChanges.changes.find((candidate) => candidate.path === selectedPath)
			: undefined;
	const changes = selectedChange ? [selectedChange] : worktreeChanges.changes;

	return (
		<div>
			<ChangesFileDiffList
				changes={changes}
				fileParent={changesFileParent}
				hunkDependencyDiffsByPath={hunkDependencyDiffsByPath}
				projectId={projectId}
			/>
		</div>
	);
};

const CommitDetails: FC<{
	projectId: string;
	commitId: string;
	selectedPath?: string | null;
	stackId: string;
}> = ({ projectId, commitId, selectedPath, stackId }) => {
	const { data: commitDetails } = useSuspenseQuery(
		commitDetailsWithLineStatsQueryOptions({ projectId, commitId }),
	);
	const selectedChange =
		selectedPath !== undefined
			? commitDetails.changes.find((candidate) => candidate.path === selectedPath)
			: undefined;
	const changes = selectedChange ? [selectedChange] : commitDetails.changes;
	const fileParent = commitFileParent({ stackId, commitId });

	return (
		<div>
			{selectedPath === undefined && (
				<>
					<h3>
						<CommitLabel commit={commitDetails.commit} />
					</h3>
					{commitDetails.commit.message.includes("\n") && (
						<p className={styles.commitMessageBody}>
							{commitDetails.commit.message
								.slice(commitDetails.commit.message.indexOf("\n") + 1)
								.trim()}
						</p>
					)}
				</>
			)}
			<ChangesFileDiffList changes={changes} fileParent={fileParent} projectId={projectId} />
		</div>
	);
};

const BranchDetails: FC<{
	projectId: string;
	branchRef: Array<number>;
	selectedPath?: string;
	stackId: string;
}> = ({ projectId, branchRef, selectedPath, stackId }) => {
	const decodedBranchRef = decodeRefName(branchRef);
	const [{ data: branchDetails }, { data: branchDiff }] = useSuspenseQueries({
		queries: [
			branchDetailsQueryOptions({
				projectId,
				// https://linear.app/gitbutler/issue/GB-1226/unify-branch-identifiers
				branchName: decodedBranchRef.replace(/^refs\/heads\//, ""),
				remote: null,
			}),
			branchDiffQueryOptions({ projectId, branch: decodedBranchRef }),
		],
	});

	const selectedChange =
		selectedPath !== undefined
			? branchDiff.changes.find((candidate) => candidate.path === selectedPath)
			: undefined;
	const changes = selectedChange ? [selectedChange] : branchDiff.changes;

	return (
		<div>
			<h3>{branchDetails.name}</h3>
			{branchDetails.prNumber != null && <p>PR #{branchDetails.prNumber}</p>}
			<ChangesFileDiffList
				changes={changes}
				projectId={projectId}
				fileParent={branchFileParent({ stackId, branchRef })}
			/>
		</div>
	);
};

const Details: FC<{
	projectId: string;
	selectedItem: Item;
}> = ({ projectId, selectedItem }) =>
	Match.value(selectedItem).pipe(
		Match.tagsExhaustive({
			Stack: () => null,
			Branch: ({ branchRef, stackId }) => (
				<BranchDetails projectId={projectId} branchRef={branchRef} stackId={stackId} />
			),
			ChangesSection: () => <ChangesDetails projectId={projectId} />,
			File: ({ parent, path }) =>
				Match.value(parent).pipe(
					Match.tagsExhaustive({
						Changes: () => <ChangesDetails projectId={projectId} selectedPath={path} />,
						Branch: ({ branchRef, stackId }) => (
							<BranchDetails
								projectId={projectId}
								branchRef={branchRef}
								selectedPath={path}
								stackId={stackId}
							/>
						),
						Commit: ({ commitId, stackId }) => (
							<CommitDetails
								projectId={projectId}
								commitId={commitId}
								stackId={stackId}
								selectedPath={path}
							/>
						),
					}),
				),
			Commit: ({ commitId, stackId }) => (
				<CommitDetails projectId={projectId} commitId={commitId} stackId={stackId} />
			),
			BaseCommit: () => null,
			Hunk: () => null,
		}),
	);

const EditorHelp: FC<{
	hotkeys: Array<{ hotkey: string; name: string }>;
}> = ({ hotkeys }) => (
	<div className={styles.editorHelp}>
		{hotkeys.map((hotkey, index) => (
			<Fragment key={hotkey.hotkey}>
				{index > 0 && " • "}
				<span className={styles.editorShortcut}>{formatForDisplay(hotkey.hotkey)}</span> to{" "}
				{hotkey.name}
			</Fragment>
		))}
	</div>
);

type CommandPaletteItem = HotkeyRegistrationView & {
	options: { meta: { group: HotkeyGroup; name: string } };
};

const groupCommandPaletteItems = (
	commands: Array<CommandPaletteItem>,
): Array<PickerDialogGroup<CommandPaletteItem>> => {
	const groups = new Map<string, Array<CommandPaletteItem>>();

	for (const command of commands) {
		const groupName = command.options.meta.group;
		const group = groups.get(groupName);
		if (group) group.push(command);
		else groups.set(groupName, [command]);
	}

	return globalThis.Array.from(groups.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([value, items]) => ({
			value,
			items: globalThis.Array.from(items).sort((a, b) =>
				a.options.meta.name.localeCompare(b.options.meta.name),
			),
		}));
};

const CommandPalette: FC<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
	const { hotkeys } = useHotkeyRegistrations();
	const items = pipe(
		hotkeys
			.filter(
				(hotkey): hotkey is CommandPaletteItem =>
					hotkey.options.enabled !== false &&
					hotkey.options.meta?.name !== undefined &&
					hotkey.options.meta.commandPalette !== false,
			)
			.sort((a, b) => a.options.meta.name.localeCompare(b.options.meta.name)),
		groupCommandPaletteItems,
	);

	const runCommand = (hotkey: CommandPaletteItem) => {
		onOpenChange(false);
		getHotkeyManager().triggerRegistration(hotkey.id);
	};

	return (
		<PickerDialog
			ariaLabel="Command palette"
			closeLabel="Close command palette"
			emptyLabel="No commands found."
			getItemKey={(x) => x.id}
			getItemLabel={(x) => x.options.meta.name}
			getItemType={(x) =>
				x.options.meta.commandPalette !== "hideHotkey" ? formatForDisplay(x.hotkey) : undefined
			}
			items={items}
			open={open}
			onOpenChange={onOpenChange}
			onSelectItem={runCommand}
			placeholder="Search commands…"
		/>
	);
};

const InlineRewordCommit: FC<{
	message: string;
	onSubmit: (value: string) => void;
	onExit: () => void;
	projectId: string;
}> = ({ message, onSubmit, onExit, projectId }) => {
	const formRef = useRef<HTMLFormElement | null>(null);
	const focusedPanel = useFocusedProjectPanel(projectId);
	const submitAction = (formData: FormData) => {
		onExit();
		onSubmit(formData.get("message") as string);
	};

	useHotkey("Enter", () => formRef.current?.requestSubmit(), {
		enabled: focusedPanel === "log",
		ignoreInputs: false,
		meta: { group: "Reword commit", name: "Save", commandPalette: false },
	});

	useHotkey("Escape", onExit, {
		conflictBehavior: "allow",
		enabled: focusedPanel === "log",
		ignoreInputs: false,
		meta: { group: "Reword commit", name: "Cancel", commandPalette: false },
	});

	return (
		<form ref={formRef} className={styles.editorForm} action={submitAction}>
			<textarea
				ref={(el) => {
					if (!el) return;
					el.focus();
					const cursorPosition = el.value.length;
					el.setSelectionRange(cursorPosition, cursorPosition);
				}}
				aria-label="Commit message"
				name="message"
				defaultValue={message.trim()}
				className={classes(styles.editorInput, styles.rewordCommitInput)}
			/>
			<EditorHelp
				hotkeys={[
					{ hotkey: "Enter", name: "Save" },
					{ hotkey: "Escape", name: "Cancel" },
				]}
			/>
		</form>
	);
};

const CommitRow: FC<
	{
		commit: Commit;
		isExpanded: boolean;
		projectId: string;
		stackId: string;
		navigationIndex: NavigationIndex;
		focusPanel: (panel: PanelType) => void;
	} & ComponentProps<"div">
> = ({ commit, isExpanded, projectId, stackId, navigationIndex, focusPanel, ...restProps }) => {
	const isHighlighted = useAppSelector((state) =>
		selectProjectHighlightedCommitIds(state, projectId).includes(commit.id),
	);
	const workspaceMode = useAppSelector((state) =>
		selectProjectWorkspaceModeState(state, projectId),
	);

	const dispatch = useAppDispatch();
	const commitItemV: CommitItem = {
		stackId,
		commitId: commit.id,
	};
	const item = commitItem(commitItemV);
	const isSelected = useIsItemSelected({ projectId, item });
	const isRewording =
		isSelected &&
		workspaceMode._tag === "RewordCommit" &&
		itemEquals(
			item,
			commitItem({
				stackId: workspaceMode.stackId,
				commitId: workspaceMode.commitId,
			}),
		);
	const [optimisticMessage, setOptimisticMessage] = useOptimistic(
		commit.message,
		(_currentMessage, nextMessage: string) => nextMessage,
	);
	const [isCommitMessagePending, startCommitMessageTransition] = useTransition();
	// We use a controlled tooltip as a workaround for https://github.com/mui/base-ui/issues/4499.
	const [isExpandCollapseTooltipOpen, setIsExpandCollapseTooltipOpen] = useState(false);

	const commitWithOptimisticMessage: Commit = {
		...commit,
		message: optimisticMessage,
	};

	const commitInsertBlank = useMutation(commitInsertBlankMutationOptions);
	const commitDiscard = useMutation(commitDiscardMutationOptions);
	const commitReword = useMutation(commitRewordMutationOptions);

	const insertBlankCommitAbove = () => {
		commitInsertBlank.mutate({
			projectId,
			relativeTo: { type: "commit", subject: commit.id },
			side: "above",
			dryRun: false,
		});
	};

	const insertBlankCommitBelow = () => {
		commitInsertBlank.mutate({
			projectId,
			relativeTo: { type: "commit", subject: commit.id },
			side: "below",
			dryRun: false,
		});
	};

	const deleteCommit = () => {
		commitDiscard.mutate({
			projectId,
			subjectCommitId: commit.id,
			dryRun: false,
		});
	};

	const cutCommit = () => {
		dispatch(projectActions.enterMoveMode({ projectId, source: item }));
	};

	const startEditing = () => {
		dispatch(projectActions.startRewordCommit({ projectId, item: commitItemV }));
	};
	const focusedPanel = useFocusedProjectPanel(projectId);

	const endEditing = () => {
		dispatch(projectActions.exitMode({ projectId }));
		dispatch(projectActions.selectItem({ projectId, item }));
		focusPanel("log");
	};

	const saveNewMessage = (newMessage: string) => {
		const initialMessage = commit.message.trim();
		const trimmed = newMessage.trim();
		if (trimmed === initialMessage) return;
		startCommitMessageTransition(async () => {
			setOptimisticMessage(trimmed);
			try {
				await commitReword.mutateAsync({
					projectId,
					commitId: commit.id,
					message: trimmed,
					dryRun: false,
				});
			} catch {
				// Use the global mutation error handler (shows toast) instead of React
				// error boundaries.
				return;
			}
		});
	};

	const menuItems: Array<NativeMenuItem> = [
		{
			_tag: "Item",
			label: "Cut commit",
			onSelect: cutCommit,
		},
		{
			_tag: "Item",
			label: "Reword commit",
			enabled: !isCommitMessagePending,
			onSelect: startEditing,
		},
		{
			_tag: "Item",
			label: "Add empty commit",
			submenu: [
				{
					_tag: "Item",
					label: "Above",
					onSelect: insertBlankCommitAbove,
				},
				{
					_tag: "Item",
					label: "Below",
					onSelect: insertBlankCommitBelow,
				},
			],
		},
		{
			_tag: "Item",
			label: "Delete commit",
			enabled: !commitDiscard.isPending,
			onSelect: deleteCommit,
		},
	];

	useHotkey("Enter", startEditing, {
		conflictBehavior: "allow",
		enabled:
			!isCommitMessagePending &&
			isSelected &&
			focusedPanel === "log" &&
			workspaceMode._tag === "Default",
		meta: { group: "Commit", name: "Reword" },
	});

	useHotkey(
		"ArrowRight",
		() => {
			dispatch(projectActions.openCommitFiles({ projectId, item: commitItemV }));
		},
		{
			conflictBehavior: "allow",
			enabled:
				isSelected && focusedPanel === "log" && workspaceMode._tag === "Default" && !isExpanded,
			meta: { group: "Commit", name: "Expand files" },
		},
	);

	useHotkey(
		"ArrowLeft",
		() => {
			dispatch(projectActions.closeCommitFiles({ projectId }));
		},
		{
			conflictBehavior: "allow",
			enabled:
				isSelected && focusedPanel === "log" && workspaceMode._tag === "Default" && isExpanded,
			meta: { group: "Commit", name: "Collapse files" },
		},
	);

	useHotkey({ key: "" }, insertBlankCommitAbove, {
		conflictBehavior: "allow",
		enabled: isSelected && focusedPanel === "log" && workspaceMode._tag === "Default",
		meta: {
			group: "Commit",
			name: "Add empty commit above",
			commandPalette: "hideHotkey",
			shortcutsBar: false,
		},
	});

	useHotkey({ key: "" }, insertBlankCommitBelow, {
		conflictBehavior: "allow",
		enabled: isSelected && focusedPanel === "log" && workspaceMode._tag === "Default",
		meta: {
			group: "Commit",
			name: "Add empty commit below",
			commandPalette: "hideHotkey",
			shortcutsBar: false,
		},
	});

	useHotkey({ key: "" }, deleteCommit, {
		conflictBehavior: "allow",
		enabled:
			!commitDiscard.isPending &&
			isSelected &&
			focusedPanel === "log" &&
			workspaceMode._tag === "Default",
		meta: {
			group: "Commit",
			name: "Delete commit",
			commandPalette: "hideHotkey",
			shortcutsBar: false,
		},
	});

	return (
		<ItemRow
			{...restProps}
			projectId={projectId}
			item={item}
			navigationIndex={navigationIndex}
			className={classes(restProps.className, isHighlighted && styles.itemRowHighlighted)}
		>
			{isRewording ? (
				<InlineRewordCommit
					message={optimisticMessage}
					onSubmit={saveNewMessage}
					onExit={endEditing}
					projectId={projectId}
				/>
			) : (
				<>
					<div
						className={styles.itemRowLabel}
						onContextMenu={
							workspaceMode._tag === "Default"
								? (event) => {
										void showNativeContextMenu(event, menuItems);
									}
								: undefined
						}
					>
						<CommitLabel commit={commitWithOptimisticMessage} />
					</div>
					{workspaceMode._tag === "Default" && (
						<ItemRowToolbar aria-label="Commit actions">
							<Tooltip.Root
								open={isExpandCollapseTooltipOpen}
								// Prevent tooltip from lingering while moving between nearby controls.
								// [tag:tooltip-disable-hoverable-popup]
								disableHoverablePopup
							>
								<Tooltip.Trigger
									render={<Toolbar.Button type="button" className={styles.itemRowToolbarButton} />}
									onClick={() =>
										dispatch(projectActions.toggleCommitFiles({ projectId, item: commitItemV }))
									}
									onMouseEnter={() => setIsExpandCollapseTooltipOpen(true)}
									onMouseLeave={() => setIsExpandCollapseTooltipOpen(false)}
									onFocus={() => setIsExpandCollapseTooltipOpen(true)}
									onBlur={() => setIsExpandCollapseTooltipOpen(false)}
									aria-label={"Toggle commit files"}
								>
									<ExpandCollapseIcon isExpanded={isExpanded} />
								</Tooltip.Trigger>
								<Tooltip.Portal>
									<Tooltip.Positioner sideOffset={8}>
										<Tooltip.Popup className={classes(uiStyles.popup, uiStyles.tooltip)}>
											Toggle commit files
										</Tooltip.Popup>
									</Tooltip.Positioner>
								</Tooltip.Portal>
							</Tooltip.Root>
							<Toolbar.Button
								type="button"
								className={styles.itemRowToolbarButton}
								aria-label="Commit menu"
								onClick={(event) => {
									void showNativeMenuFromTrigger(event.currentTarget, menuItems);
								}}
							>
								<MenuTriggerIcon />
							</Toolbar.Button>
						</ItemRowToolbar>
					)}
				</>
			)}
		</ItemRow>
	);
};

const CommitFileRow: FC<{
	change: TreeChange;
	parentCommitItem: CommitItem;
	navigationIndex: NavigationIndex;
	projectId: string;
}> = ({ change, parentCommitItem, navigationIndex, projectId }) => {
	const dispatch = useAppDispatch();
	const item = fileItem({
		parent: commitFileParent(parentCommitItem),
		path: change.path,
	});
	const isSelected = useIsItemSelected({ projectId, item });
	const focusedPanel = useFocusedProjectPanel(projectId);

	useHotkey(
		"F",
		() => {
			dispatch(projectActions.toggleCommitFiles({ projectId, item: parentCommitItem }));
		},
		{
			conflictBehavior: "allow",
			enabled: isSelected && focusedPanel === "log",
			meta: { group: "Commit file", name: "Files" },
		},
	);

	useHotkey(
		"Escape",
		() => {
			dispatch(projectActions.closeCommitFiles({ projectId }));
		},
		{
			conflictBehavior: "allow",
			enabled: isSelected && focusedPanel === "log",
			meta: { group: "Commit file", name: "Close" },
		},
	);

	return (
		<TreeItem
			projectId={projectId}
			item={item}
			label={fileRowLabel(change)}
			render={
				<OperationItem
					projectId={projectId}
					item={item}
					render={
						<ItemRow
							projectId={projectId}
							item={item}
							navigationIndex={navigationIndex}
							className={styles.fileRow}
						/>
					}
				/>
			}
		>
			<div className={styles.itemRowLabel}>{fileRowLabel(change)}</div>
		</TreeItem>
	);
};

const CommitC: FC<{
	commit: Commit;
	projectId: string;
	stackId: string;
	navigationIndex: NavigationIndex;
	focusPanel: (panel: PanelType) => void;
}> = ({ commit, projectId, stackId, navigationIndex, focusPanel }) => {
	const isExpanded = useAppSelector(
		(state) => selectProjectExpandedCommitId(state, projectId) === commit.id,
	);
	const commitItemV: CommitItem = { stackId, commitId: commit.id };
	const item = commitItem(commitItemV);

	return (
		<TreeItem
			projectId={projectId}
			item={item}
			label={commitTitle(commit.message)}
			expanded={isExpanded}
			render={<OperationItem projectId={projectId} item={item} />}
		>
			<CommitRow
				commit={commit}
				isExpanded={isExpanded}
				projectId={projectId}
				stackId={stackId}
				navigationIndex={navigationIndex}
				focusPanel={focusPanel}
			/>
			{isExpanded && (
				<Suspense fallback={<div className={styles.itemRowEmpty}>Loading commit files…</div>}>
					<CommitFiles
						projectId={projectId}
						commitId={commit.id}
						renderFile={(change) => (
							<CommitFileRow
								change={change}
								parentCommitItem={commitItemV}
								navigationIndex={navigationIndex}
								projectId={projectId}
							/>
						)}
					/>
				</Suspense>
			)}
		</TreeItem>
	);
};

const ChangesFileRow: FC<{
	change: TreeChange;
	dependencyCommitIds: NonEmptyArray<string> | undefined;
	navigationIndex: NavigationIndex;
	onAbsorbChanges: (target: AbsorptionTarget) => void;
	projectId: string;
}> = ({ change, dependencyCommitIds, navigationIndex, onAbsorbChanges, projectId }) => {
	const item = fileItem({ parent: changesFileParent, path: change.path });
	const isSelected = useIsItemSelected({ projectId, item });
	const focusedPanel = useFocusedProjectPanel(projectId);
	const workspaceMode = useAppSelector((state) =>
		selectProjectWorkspaceModeState(state, projectId),
	);

	useHotkey(
		"A",
		() => {
			onAbsorbChanges({
				type: "treeChanges",
				subject: {
					changes: [change],
					assignedStackId: null,
				},
			});
		},
		{
			conflictBehavior: "allow",
			enabled: isSelected && focusedPanel === "log" && workspaceMode._tag === "Default",
			meta: { group: "Changes file", name: "Absorb" },
		},
	);

	const menuItems: Array<NativeMenuItem> = [
		{
			_tag: "Item",
			label: "Absorb",
			onSelect: () => {
				onAbsorbChanges({
					type: "treeChanges",
					subject: {
						changes: [change],
						assignedStackId: null,
					},
				});
			},
		},
	];

	return (
		<TreeItem
			projectId={projectId}
			item={item}
			label={fileRowLabel(change)}
			render={
				<OperationItem
					projectId={projectId}
					item={item}
					render={<ItemRow projectId={projectId} item={item} navigationIndex={navigationIndex} />}
				/>
			}
		>
			<div
				className={styles.itemRowLabel}
				onContextMenu={(event) => {
					void showNativeContextMenu(event, menuItems);
				}}
			>
				{fileRowLabel(change)}
			</div>
			{workspaceMode._tag === "Default" && (
				<ItemRowToolbar aria-label="File actions">
					{dependencyCommitIds && (
						<DependencyIndicatorButton
							projectId={projectId}
							commitIds={dependencyCommitIds}
							render={<Toolbar.Button type="button" className={styles.itemRowToolbarButton} />}
						>
							<DependencyIcon />
						</DependencyIndicatorButton>
					)}
					<Toolbar.Button
						type="button"
						className={styles.itemRowToolbarButton}
						aria-label="File menu"
						onClick={(event) => {
							void showNativeMenuFromTrigger(event.currentTarget, menuItems);
						}}
					>
						<MenuTriggerIcon />
					</Toolbar.Button>
				</ItemRowToolbar>
			)}
		</TreeItem>
	);
};

const ChangesSectionRow: FC<{
	changes: Array<TreeChange>;
	navigationIndex: NavigationIndex;
	onAbsorbChanges: (target: AbsorptionTarget) => void;
	onCommit: () => void;
	projectId: string;
}> = ({ changes, navigationIndex, onAbsorbChanges, onCommit, projectId }) => {
	const item = changesSectionItem;
	const isSelected = useIsItemSelected({ projectId, item });
	const focusedPanel = useFocusedProjectPanel(projectId);
	const workspaceMode = useAppSelector((state) =>
		selectProjectWorkspaceModeState(state, projectId),
	);

	useHotkey(
		"A",
		() => {
			onAbsorbChanges({ type: "all" });
		},
		{
			conflictBehavior: "allow",
			enabled:
				changes.length > 0 &&
				isSelected &&
				focusedPanel === "log" &&
				workspaceMode._tag === "Default",
			meta: { group: "Changes", name: "Absorb" },
		},
	);

	const menuItems: Array<NativeMenuItem> = [
		{
			_tag: "Item",
			label: "Absorb",
			enabled: changes.length > 0,
			onSelect: () => {
				onAbsorbChanges({ type: "all" });
			},
		},
	];

	return (
		<ItemRow projectId={projectId} item={item} navigationIndex={navigationIndex}>
			<div
				className={classes(styles.itemRowLabel, styles.sectionLabel)}
				onContextMenu={(event) => {
					void showNativeContextMenu(event, menuItems);
				}}
			>
				Changes ({changes.length})
			</div>
			{workspaceMode._tag === "Default" && (
				<ItemRowToolbar aria-label="Changes actions">
					<Toolbar.Button type="button" className={styles.itemRowToolbarButton} onClick={onCommit}>
						Commit
					</Toolbar.Button>
					<Toolbar.Button
						type="button"
						className={styles.itemRowToolbarButton}
						aria-label="Changes menu"
						onClick={(event) => {
							void showNativeMenuFromTrigger(event.currentTarget, menuItems);
						}}
					>
						<MenuTriggerIcon />
					</Toolbar.Button>
				</ItemRowToolbar>
			)}
		</ItemRow>
	);
};

const BaseCommit: FC<{
	projectId: string;
	commitId?: string;
	navigationIndex: NavigationIndex;
}> = ({ projectId, commitId, navigationIndex }) => {
	const item = baseCommitItem;

	return (
		<div className={styles.section}>
			<TreeItem
				projectId={projectId}
				item={item}
				label="Base commit"
				render={
					<OperationItem
						projectId={projectId}
						item={item}
						render={<ItemRow projectId={projectId} item={item} navigationIndex={navigationIndex} />}
					/>
				}
			>
				<div className={classes(styles.itemRowLabel, styles.sectionLabel)}>
					{commitId !== undefined
						? `${shortCommitId(commitId)} (common base commit)`
						: "(base commit)"}
				</div>
			</TreeItem>
		</div>
	);
};

const Changes: FC<{
	projectId: string;
	onAbsorbChanges: (target: AbsorptionTarget) => void;
	onCommit: () => void;
	navigationIndex: NavigationIndex;
}> = ({ projectId, onAbsorbChanges, onCommit, navigationIndex }) => {
	const { data: worktreeChanges } = useSuspenseQuery(changesInWorktreeQueryOptions(projectId));

	const hunkDependencyDiffsByPath = getHunkDependencyDiffsByPath(
		worktreeChanges.dependencies?.diffs ?? [],
	);

	const item = changesSectionItem;

	return (
		<TreeItem
			projectId={projectId}
			item={item}
			label={`Changes (${worktreeChanges.changes.length})`}
			expanded
			className={styles.section}
			render={<OperationItem projectId={projectId} item={item} />}
		>
			<ChangesSectionRow
				changes={worktreeChanges.changes}
				navigationIndex={navigationIndex}
				onAbsorbChanges={onAbsorbChanges}
				onCommit={onCommit}
				projectId={projectId}
			/>
			{worktreeChanges.changes.length === 0 ? (
				<div className={styles.itemRowEmpty}>No changes.</div>
			) : (
				<div role="group">
					{worktreeChanges.changes.map((change) => {
						const hunkDependencyDiffs = hunkDependencyDiffsByPath.get(change.path);
						const dependencyCommitIds = hunkDependencyDiffs
							? getDependencyCommitIds({ hunkDependencyDiffs })
							: undefined;

						return (
							<ChangesFileRow
								key={change.path}
								change={change}
								dependencyCommitIds={dependencyCommitIds}
								navigationIndex={navigationIndex}
								onAbsorbChanges={onAbsorbChanges}
								projectId={projectId}
							/>
						);
					})}
				</div>
			)}
		</TreeItem>
	);
};

const InlineRenameBranch: FC<{
	branchName: string;
	onSubmit: (value: string) => void;
	onExit: () => void;
	projectId: string;
}> = ({ branchName, onSubmit, onExit, projectId }) => {
	const formRef = useRef<HTMLFormElement | null>(null);
	const focusedPanel = useFocusedProjectPanel(projectId);
	const submitAction = (formData: FormData) => {
		onExit();
		onSubmit(formData.get("branchName") as string);
	};

	useHotkey("Enter", () => formRef.current?.requestSubmit(), {
		enabled: focusedPanel === "log",
		ignoreInputs: false,
		meta: { group: "Rename branch", name: "Save", commandPalette: false },
	});

	useHotkey("Escape", onExit, {
		conflictBehavior: "allow",
		enabled: focusedPanel === "log",
		ignoreInputs: false,
		meta: { group: "Rename branch", name: "Cancel", commandPalette: false },
	});

	return (
		<form ref={formRef} className={styles.editorForm} action={submitAction}>
			<input
				aria-label="Branch name"
				ref={(el) => {
					if (!el) return;
					el.focus();
					el.select();
				}}
				name="branchName"
				defaultValue={branchName}
				className={classes(styles.editorInput, styles.renameBranchInput)}
			/>
			<EditorHelp
				hotkeys={[
					{ hotkey: "Enter", name: "Save" },
					{ hotkey: "Escape", name: "Cancel" },
				]}
			/>
		</form>
	);
};

const BranchRow: FC<
	{
		projectId: string;
		branchName: string;
		branchRef: Array<number>;
		stackId: string;
		navigationIndex: NavigationIndex;
		focusPanel: (panel: PanelType) => void;
	} & ComponentProps<"div">
> = ({ projectId, branchName, branchRef, stackId, navigationIndex, focusPanel, ...restProps }) => {
	const workspaceMode = useAppSelector((state) =>
		selectProjectWorkspaceModeState(state, projectId),
	);
	const dispatch = useAppDispatch();
	const branchItemV: BranchItem = {
		stackId,
		branchRef,
	};
	const item = branchItem(branchItemV);
	const isRenaming =
		workspaceMode._tag === "RenameBranch" &&
		itemEquals(
			item,
			branchItem({
				stackId: workspaceMode.stackId,
				branchRef: workspaceMode.branchRef,
			}),
		);
	const [optimisticBranchName, setOptimisticBranchName] = useOptimistic(
		branchName,
		(_currentBranchName, nextBranchName: string) => nextBranchName,
	);
	const [isRenamePending, startRenameTransition] = useTransition();

	const updateBranchName = useMutation(updateBranchNameMutationOptions);

	const startEditing = () => {
		dispatch(projectActions.startRenameBranch({ projectId, item: branchItemV }));
	};
	const isSelected = useIsItemSelected({ projectId, item });
	const focusedPanel = useFocusedProjectPanel(projectId);

	const endEditing = () => {
		dispatch(projectActions.exitMode({ projectId }));
		dispatch(projectActions.selectItem({ projectId, item }));
		focusPanel("log");
	};

	const saveBranchName = (newBranchName: string) => {
		const trimmed = newBranchName.trim();
		if (trimmed === "" || trimmed === branchName) return;
		startRenameTransition(async () => {
			setOptimisticBranchName(trimmed);
			try {
				await updateBranchName.mutateAsync({
					projectId,
					stackId,
					branchName,
					newName: trimmed,
				});
			} catch {
				// Use the global mutation error handler (shows toast) instead of React
				// error boundaries.
				return;
			}
			const newItem = branchItem({
				stackId,
				// TODO: ideally the API would return the new ref?
				branchRef: encodeRefName(`refs/heads/${trimmed}`),
			});
			dispatch(projectActions.selectItem({ projectId, item: newItem }));
			dispatch(projectActions.exitMode({ projectId }));
		});
	};

	const menuItems: Array<NativeMenuItem> = [
		{
			_tag: "Item",
			label: "Rename branch",
			enabled: !isRenamePending,
			onSelect: startEditing,
		},
	];

	useHotkey("Enter", startEditing, {
		conflictBehavior: "allow",
		enabled: isSelected && focusedPanel === "log" && workspaceMode._tag === "Default",
		meta: { group: "Branch", name: "Rename" },
	});

	return (
		<ItemRow {...restProps} projectId={projectId} item={item} navigationIndex={navigationIndex}>
			{isRenaming ? (
				<InlineRenameBranch
					branchName={optimisticBranchName}
					onSubmit={saveBranchName}
					onExit={endEditing}
					projectId={projectId}
				/>
			) : (
				<>
					<div
						className={classes(styles.itemRowLabel, styles.sectionLabel)}
						onContextMenu={
							workspaceMode._tag === "Default"
								? (event) => {
										void showNativeContextMenu(event, menuItems);
									}
								: undefined
						}
					>
						{optimisticBranchName}
					</div>
					{workspaceMode._tag === "Default" && (
						<ItemRowToolbar aria-label="Branch actions">
							<Toolbar.Button
								type="button"
								className={styles.itemRowToolbarButton}
								aria-label="Push branch"
								disabled
							>
								<PushIcon />
							</Toolbar.Button>
							<Toolbar.Button
								type="button"
								className={styles.itemRowToolbarButton}
								aria-label="Branch menu"
								onClick={(event) => {
									void showNativeMenuFromTrigger(event.currentTarget, menuItems);
								}}
							>
								<MenuTriggerIcon />
							</Toolbar.Button>
						</ItemRowToolbar>
					)}
				</>
			)}
		</ItemRow>
	);
};

const StackRow: FC<
	{
		navigationIndex: NavigationIndex;
		projectId: string;
		stackId: string;
	} & ComponentProps<"div">
> = ({ navigationIndex, projectId, stackId, ...restProps }) => {
	const item = stackItem({ stackId });
	const isSelected = useIsItemSelected({ projectId, item });
	const focusedPanel = useFocusedProjectPanel(projectId);
	const workspaceMode = useAppSelector((state) =>
		selectProjectWorkspaceModeState(state, projectId),
	);

	const unapplyStack = useMutation(unapplyStackMutationOptions);
	const unapply = () => {
		unapplyStack.mutate({ projectId, stackId });
	};

	const menuItems: Array<NativeMenuItem> = [
		{ _tag: "Item", label: "Move up", enabled: false },
		{ _tag: "Item", label: "Move down", enabled: false },
		{ _tag: "Separator" },
		{
			_tag: "Item",
			label: "Unapply stack",
			enabled: !unapplyStack.isPending,
			onSelect: unapply,
		},
	];

	useHotkey({ key: "" }, unapply, {
		conflictBehavior: "allow",
		enabled:
			isSelected &&
			focusedPanel === "log" &&
			workspaceMode._tag === "Default" &&
			!unapplyStack.isPending,
		meta: {
			group: "Stack",
			name: "Unapply stack",
			commandPalette: "hideHotkey",
			shortcutsBar: false,
		},
	});

	return (
		<ItemRow {...restProps} projectId={projectId} item={item} navigationIndex={navigationIndex}>
			<div
				className={classes(styles.itemRowLabel, styles.sectionLabel)}
				onContextMenu={
					workspaceMode._tag === "Default"
						? (event) => {
								void showNativeContextMenu(event, menuItems);
							}
						: undefined
				}
			>
				Stack
			</div>
			{workspaceMode._tag === "Default" && (
				<ItemRowToolbar aria-label="Stack actions">
					<Toolbar.Button
						type="button"
						className={styles.itemRowToolbarButton}
						aria-label="Stack menu"
						onClick={(event) => {
							void showNativeMenuFromTrigger(event.currentTarget, menuItems);
						}}
					>
						<MenuTriggerIcon />
					</Toolbar.Button>
				</ItemRowToolbar>
			)}
		</ItemRow>
	);
};

const BranchSegment: FC<{
	navigationIndex: NavigationIndex;
	projectId: string;
	segment: Segment;
	stackId: string;
	focusPanel: (panel: PanelType) => void;
}> = ({ navigationIndex, projectId, segment, stackId, focusPanel }) => {
	const refName = assert(segment.refName);
	const item = branchItem({ stackId, branchRef: refName.fullNameBytes });

	return (
		<TreeItem
			projectId={projectId}
			item={item}
			label={refName.displayName}
			expanded
			className={classes(styles.section, styles.segment)}
		>
			<OperationItem
				projectId={projectId}
				item={item}
				render={
					<BranchRow
						projectId={projectId}
						branchName={refName.displayName}
						branchRef={refName.fullNameBytes}
						stackId={stackId}
						navigationIndex={navigationIndex}
						focusPanel={focusPanel}
					/>
				}
			/>

			{segment.commits.length === 0 ? (
				<div className={styles.itemRowEmpty}>No commits.</div>
			) : (
				<div role="group">
					{segment.commits.map((commit) => (
						<CommitC
							key={commit.id}
							commit={commit}
							projectId={projectId}
							stackId={stackId}
							navigationIndex={navigationIndex}
							focusPanel={focusPanel}
						/>
					))}
				</div>
			)}
		</TreeItem>
	);
};

const BranchlessSegment: FC<{
	navigationIndex: NavigationIndex;
	projectId: string;
	segment: Segment;
	stackId: string;
	focusPanel: (panel: PanelType) => void;
}> = ({ navigationIndex, projectId, segment, stackId, focusPanel }) => (
	<div className={classes(styles.section, styles.segment)}>
		{segment.commits.map((commit) => (
			<CommitC
				key={commit.id}
				commit={commit}
				projectId={projectId}
				stackId={stackId}
				navigationIndex={navigationIndex}
				focusPanel={focusPanel}
			/>
		))}
	</div>
);

const StackC: FC<{
	projectId: string;
	stack: Stack;
	navigationIndex: NavigationIndex;
	focusPanel: (panel: PanelType) => void;
}> = ({ projectId, stack, navigationIndex, focusPanel }) => {
	// From Caleb:
	// > There shouldn't be a way within GitButler to end up with a stack without a
	//   StackId. Users can disrupt our matching against our metadata by playing
	//   with references, but we currently also try to patch it up at certain points
	//   so it probably isn't too common.
	// For now we'll treat this as non-nullable until we identify cases where it
	// could genuinely be null (assuming backend correctness).
	// oxlint-disable-next-line typescript/no-non-null-assertion -- [tag:stack-id-required]
	const stackId = stack.id!;
	const item = stackItem({ stackId });

	return (
		<TreeItem
			projectId={projectId}
			item={item}
			label="Stack"
			expanded
			className={classes(styles.stack, styles.section)}
			render={<OperationItem projectId={projectId} item={item} />}
		>
			<StackRow
				projectId={projectId}
				stackId={stackId}
				navigationIndex={navigationIndex}
				className={styles.stackRow}
			/>

			<div role="group" className={styles.segments}>
				{stack.segments.map((segment) => {
					const branchRef = segment.refName?.fullNameBytes;

					if (!branchRef && segment.commits.length === 0) return null;

					const segmentKey = branchRef
						? JSON.stringify(branchRef)
						: // A segment should always either have a branch reference or at
							// least one commit, so this assertion should be safe.
							assert(segment.commits[0]).id;

					return branchRef ? (
						<BranchSegment
							key={segmentKey}
							navigationIndex={navigationIndex}
							projectId={projectId}
							segment={segment}
							stackId={stackId}
							focusPanel={focusPanel}
						/>
					) : (
						<BranchlessSegment
							key={segmentKey}
							navigationIndex={navigationIndex}
							projectId={projectId}
							segment={segment}
							stackId={stackId}
							focusPanel={focusPanel}
						/>
					);
				})}
			</div>
		</TreeItem>
	);
};

type BranchPickerOption = {
	id: string;
	label: string;
	branch: BranchItem;
};

const segmentToBranchPickerOption = ({
	segment,
	stackId,
}: {
	segment: Segment;
	stackId: string;
}): BranchPickerOption | null => {
	const refName = segment.refName;
	if (!refName) return null;

	return {
		id: JSON.stringify([stackId, refName.fullNameBytes]),
		label: refName.displayName,
		branch: { stackId, branchRef: refName.fullNameBytes },
	};
};

const stackToBranchPickerOptions = (stack: Stack): Array<BranchPickerOption> => {
	// oxlint-disable-next-line typescript/no-non-null-assertion -- [ref:stack-id-required]
	const stackId = stack.id!;
	return stack.segments.flatMap((segment): Array<BranchPickerOption> => {
		const option = segmentToBranchPickerOption({ segment, stackId });
		return option ? [option] : [];
	});
};

const BranchPicker: FC<{
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelectBranch: (branch: BranchItem) => void;
	stacks: Array<Stack>;
}> = ({ open, onOpenChange, onSelectBranch, stacks }) => {
	const selectBranch = (option: BranchPickerOption) => {
		onOpenChange(false);
		onSelectBranch(option.branch);
	};

	return (
		<PickerDialog
			ariaLabel="Select branch"
			closeLabel="Close branch picker"
			emptyLabel="No results found."
			getItemKey={(x) => x.id}
			getItemLabel={(x) => x.label}
			getItemType={() => "Branch"}
			itemToStringValue={(x) => x.label}
			items={[
				{
					value: "Branches",
					items: stacks.flatMap(stackToBranchPickerOptions),
				},
			]}
			open={open}
			onOpenChange={onOpenChange}
			onSelectItem={selectBranch}
			placeholder="Search for branches…"
		/>
	);
};

const TopBarActions: FC = () => {
	const dispatch = useAppDispatch();
	const { id: projectId } = useParams({ from: "/project/$id/workspace" });
	const layoutState = useAppSelector((state) => selectProjectLayoutState(state, projectId));
	const focusedPanel = useFocusedProjectPanel(projectId);
	const toggleDetails = () => {
		if (focusedPanel === "details" && isPanelVisible(layoutState, "details")) {
			const detailsPanelIndex = layoutState.visiblePanels.indexOf("details");
			const nextPanel = layoutState.visiblePanels[detailsPanelIndex - 1];
			if (nextPanel !== undefined)
				document.getElementById(nextPanel)?.focus({ focusVisible: false });
		}

		dispatch(projectActions.togglePanel({ projectId, panel: "details" }));
	};

	const toggleDetailsHotkey = "D";

	useHotkey(toggleDetailsHotkey, toggleDetails, {
		meta: { group: "Details", name: isPanelVisible(layoutState, "details") ? "Close" : "Open" },
	});

	return (
		<ShortcutButton
			hotkey={toggleDetailsHotkey}
			aria-pressed={isPanelVisible(layoutState, "details")}
			onClick={toggleDetails}
		>
			Details
		</ShortcutButton>
	);
};

const isInputIgnoredHotkey = ({
	activeElement,
	hotkey,
}: {
	activeElement: Element | null;
	hotkey: HotkeyRegistrationView;
}): boolean =>
	hotkey.options.ignoreInputs !== false &&
	isInputElement(activeElement) &&
	activeElement !== hotkey.target;

const ShortcutsBar: FC = () => {
	const { id: projectId } = useParams({ from: "/project/$id/workspace" });
	const focusedPanel = useFocusedProjectPanel(projectId);
	const activeElement = useActiveElement();
	const { hotkeys } = useHotkeyRegistrations();
	const visibleHotkeys = hotkeys.filter(
		(hotkey) =>
			hotkey.options.enabled !== false &&
			!isInputIgnoredHotkey({ activeElement, hotkey }) &&
			hotkey.options.meta?.name !== undefined &&
			hotkey.options.meta.shortcutsBar !== false,
	);

	if (visibleHotkeys.length === 0) return null;

	return (
		<div className={styles.shortcutsBarContainer}>
			<span className={styles.shortcutsBarScope}>{focusedPanel ?? "Shortcuts"}</span>
			{visibleHotkeys.map((hotkey) => (
				<div key={hotkey.id} className={styles.shortcutsBarItem}>
					<span className={styles.shortcutsBarKeys}>{formatForDisplay(hotkey.hotkey)}</span>
					<span>{hotkey.options.meta?.name}</span>
				</div>
			))}
		</div>
	);
};

export const WorkspacePage: FC = () => {
	const dispatch = useAppDispatch();

	const { id: projectId } = useParams({ from: "/project/$id/workspace" });

	const expandedCommitId = useAppSelector((state) =>
		selectProjectExpandedCommitId(state, projectId),
	);
	const pickerDialog = useAppSelector((state) => selectProjectPickerDialogState(state, projectId));
	const layoutState = useAppSelector((state) => selectProjectLayoutState(state, projectId));
	const workspaceMode = useAppSelector((state) =>
		selectProjectWorkspaceModeState(state, projectId),
	);
	const { focusAdjacentPanel, focusPanel, panelElementRef } = useProjectPanelFocusManager();
	const focusedPanel = useFocusedProjectPanel(projectId);

	const workspaceOutline = useWorkspaceOutline({ projectId, expandedCommitId });

	const navigationIndexUnfiltered = buildNavigationIndex(workspaceOutline);

	// React allows state updates on render, but not for external stores.
	// https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
	useEffect(() => {
		if (
			!isValidWorkspaceMode({
				mode: workspaceMode,
				navigationIndex: navigationIndexUnfiltered,
			})
		)
			dispatch(projectActions.exitMode({ projectId }));
	}, [workspaceMode, navigationIndexUnfiltered, projectId, dispatch]);

	const selectedItem = useAppSelector((state) => selectProjectSelectedItem(state, projectId));

	// React allows state updates on render, but not for external stores.
	// https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
	useEffect(() => {
		if (!navigationIndexIncludes(navigationIndexUnfiltered, selectedItem))
			dispatch(
				projectActions.selectItem({
					projectId,
					item: changesSectionItem,
				}),
			);
	}, [navigationIndexUnfiltered, selectedItem, projectId, dispatch]);

	const operationMode = useAppSelector((state) =>
		selectProjectOperationModeState(state, projectId),
	);

	const navigationIndex =
		workspaceMode._tag !== "Default"
			? filterNavigationIndex(
					navigationIndexUnfiltered,
					(item) =>
						// When entering operation mode, the selected item must still be
						// selectable otherwise the details panel will suddenly appear to
						// change and the user may lose sight of their source item (e.g.
						// hunk).
						itemEquals(selectedItem, item) ||
						// After selection moves, allow returning selection to the source item.
						(operationMode?.source && itemEquals(operationMode.source, item)) ||
						includeItemForWorkspaceMode({ mode: workspaceMode, item }),
				)
			: navigationIndexUnfiltered;

	const [absorptionTarget, setAbsorptionTarget] = useState<AbsorptionTarget | null>(null);

	const queryClient = useQueryClient();
	const openAbsorptionDialog = (target: AbsorptionTarget) => {
		// Before opening the dialog, warm cache to avoid showing loading states in
		// the dialog itself. This also ensures we don't show a stale absorption
		// plan whilst the dialog revalidates.
		void queryClient.prefetchQuery(absorptionPlanQueryOptions({ projectId, target })).then(() => {
			setAbsorptionTarget(target);
		});
	};

	useHotkey(
		"Mod+K",
		() => {
			if (pickerDialog._tag === "CommandPalette")
				dispatch(projectActions.closePickerDialog({ projectId }));
			else dispatch(projectActions.openCommandPalette({ projectId, focusedPanel }));
		},
		{
			conflictBehavior: "allow",
			meta: { group: "Global", name: "Command palette", commandPalette: false },
		},
	);

	useHotkey(
		"H",
		() => {
			focusAdjacentPanel(-1);
		},
		{
			enabled: focusedPanel !== null,
			meta: { group: "Panels", name: "Focus previous panel", commandPalette: false },
		},
	);

	useHotkey(
		"L",
		() => {
			focusAdjacentPanel(1);
		},
		{
			enabled: focusedPanel !== null,
			meta: { group: "Panels", name: "Focus next panel", commandPalette: false },
		},
	);

	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: `project:${projectId}:layout`,
		panelIds: layoutState.visiblePanels,
	});
	const logPanelElementRef = useMergedRefs(panelElementRef("log"), (el) =>
		el?.focus({ focusVisible: false }),
	);

	// TODO: handle project not found error. or only run when project is not null? waterfall.
	const { data: headInfo } = useSuspenseQuery(headInfoQueryOptions(projectId));

	const { data: projects } = useSuspenseQuery(listProjectsQueryOptions);
	const project = projects.find((project) => project.id === projectId);
	// TODO: dedupe
	if (!project) return <p>Project not found.</p>;

	const selectBranch = (branch: BranchItem) => {
		dispatch(
			projectActions.selectItem({
				projectId,
				item: branchItem(branch),
			}),
		);
		focusPanel("log");
	};

	const setBranchPickerOpen = (open: boolean) => {
		if (open) dispatch(projectActions.openBranchPicker({ projectId }));
		else dispatch(projectActions.closePickerDialog({ projectId }));
	};

	const setCommandPaletteOpen = (open: boolean) => {
		if (open) dispatch(projectActions.openCommandPalette({ projectId, focusedPanel }));
		else dispatch(projectActions.closePickerDialog({ projectId }));
	};

	return (
		<>
			<TopBarActionsPortal>
				<TopBarActions />
			</TopBarActionsPortal>

			<ShortcutsBarPortal>
				<ShortcutsBar />
			</ShortcutsBarPortal>

			<Group className={styles.page} defaultLayout={defaultLayout} onLayoutChange={onLayoutChanged}>
				<LogPanel
					elementRef={logPanelElementRef}
					focusPanel={focusPanel}
					navigationIndex={navigationIndex}
					onAbsorbChanges={openAbsorptionDialog}
				/>
				{isPanelVisible(layoutState, "details") && (
					<>
						<Separator className={styles.panelResizeHandle} />
						<DetailsPanel elementRef={panelElementRef("details")} focusPanel={focusPanel} />
					</>
				)}
			</Group>

			{absorptionTarget && (
				<AbsorptionDialog
					projectId={projectId}
					target={absorptionTarget}
					onOpenChange={(open) => {
						if (!open) setAbsorptionTarget(null);
					}}
				/>
			)}

			{Match.value(pickerDialog).pipe(
				Match.tagsExhaustive({
					None: () => null,
					BranchPicker: () => (
						<BranchPicker
							open
							onOpenChange={setBranchPickerOpen}
							onSelectBranch={selectBranch}
							stacks={headInfo.stacks}
						/>
					),
					CommandPalette: () => <CommandPalette open onOpenChange={setCommandPaletteOpen} />,
				}),
			)}
		</>
	);
};
