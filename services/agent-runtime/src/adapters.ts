import type {
  ComputerActionInput,
  ComputerActionType,
  ComputerAdapterId,
} from '@jupiter/contracts';

export type ComputerAdapter = {
  adapterId: ComputerAdapterId;
  name: string;
  supportedActions: readonly ComputerActionType[];
  matches: (action: ComputerActionInput) => boolean;
};

const ALL_ACTIONS: readonly ComputerActionType[] = [
  'OPEN_APP',
  'CLOSE_APP',
  'FOCUS_WINDOW',
  'MINIMIZE_WINDOW',
  'MAXIMIZE_WINDOW',
  'RESTORE_WINDOW',
  'MOVE_RESIZE_WINDOW',
  'ENUMERATE_WINDOWS',
  'GET_ACTIVE_WINDOW',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'PRESS_KEYS',
  'SCROLL_ELEMENT',
  'SELECT_ELEMENT',
  'DRAG_DROP',
  'COPY',
  'PASTE',
  'READ_UI_TREE',
  'SCREENSHOT',
  'WAIT_FOR_WINDOW',
  'SAVE_FILE',
];

export const GENERIC_WINDOWS_ADAPTER: ComputerAdapter = {
  adapterId: 'generic-windows',
  name: 'Generic Windows Adapter',
  supportedActions: ALL_ACTIONS.filter((action) => action !== 'SAVE_FILE'),
  matches: () => true,
};

export const NOTEPAD_ADAPTER: ComputerAdapter = {
  adapterId: 'notepad',
  name: 'Notepad Adapter',
  supportedActions: ALL_ACTIONS,
  matches: (action) =>
    action.adapterHint === 'notepad' ||
    action.target.id.toLowerCase().includes('notepad') ||
    ('executable' in action.parameters &&
      action.parameters.executable.toLowerCase().endsWith('notepad.exe')),
};

export const FILE_EXPLORER_ADAPTER: ComputerAdapter = {
  adapterId: 'file-explorer',
  name: 'File Explorer Adapter',
  supportedActions: ALL_ACTIONS.filter(
    (action) => !['TYPE_TEXT', 'PASTE', 'SAVE_FILE'].includes(action),
  ),
  matches: (action) =>
    action.adapterHint === 'file-explorer' ||
    action.target.id.toLowerCase().includes('explorer') ||
    ('executable' in action.parameters &&
      action.parameters.executable.toLowerCase().endsWith('explorer.exe')),
};

export const COMPUTER_ADAPTERS: readonly ComputerAdapter[] = [
  NOTEPAD_ADAPTER,
  FILE_EXPLORER_ADAPTER,
  GENERIC_WINDOWS_ADAPTER,
];

export function resolveComputerAdapter(action: ComputerActionInput): ComputerAdapter {
  const hinted = action.adapterHint
    ? COMPUTER_ADAPTERS.find((adapter) => adapter.adapterId === action.adapterHint)
    : undefined;
  const adapter = hinted ?? COMPUTER_ADAPTERS.find((candidate) => candidate.matches(action));
  if (!adapter?.supportedActions.includes(action.action)) {
    throw new Error(`No adapter supports ${action.action} for the exact target.`);
  }
  return adapter;
}
