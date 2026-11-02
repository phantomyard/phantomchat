import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  menu: undefined as any,
  settings: {} as {defaultChatFolderId?: number},
  set: vi.fn(), dispatch: vi.fn(), toast: vi.fn()
}));
vi.mock('@helpers/dom/createContextMenu', () => ({default: (options: any) => {
  mocks.menu = options;
  return {destroy: vi.fn()};
}}));
vi.mock('@stores/appSettings', () => ({appSettings: mocks.settings, setAppSettings: mocks.set}));
vi.mock('@lib/rootScope', () => ({default: {dispatchEventSingle: mocks.dispatch}}));
vi.mock('@components/toast', () => ({toastNew: mocks.toast}));
import createFolderContextMenu from '@helpers/dom/createFolderContextMenu';

beforeEach(() => {
  vi.clearAllMocks();
  delete mocks.settings.defaultChatFolderId;
  createFolderContextMenu({managers: {} as any, className: 'folder', listenTo: document.body});
});
function open(id: number) {
  mocks.menu.onOpen({}, {dataset: {filterId: String(id)}});
  return mocks.menu.buttons;
}
describe('default folder context menu', () => {
  it('treats Chats as the default when no preference is stored', () => {
    const [set, remove] = open(0);
    expect(set.verify()).toBe(false);
    expect(remove.verify()).toBe(false);
  });
  it('sets Sessions and immediately selects it without waiting for persistence', () => {
    mocks.set.mockReturnValue(new Promise(() => {}));
    const [set] = open(4);
    expect(set.verify()).toBe(true);
    set.onClick();
    expect(mocks.set).toHaveBeenCalledWith('defaultChatFolderId', 4);
    expect(mocks.dispatch).toHaveBeenCalledWith('changing_folder_from_sidebar', {id: 4});
  });
  it('removing Sessions default immediately returns to Chats and explains the fallback', () => {
    mocks.settings.defaultChatFolderId = 4;
    const [set, remove] = open(4);
    expect(set.verify()).toBe(false);
    expect(remove.verify()).toBe(true);
    remove.onClick();
    expect(mocks.set).toHaveBeenCalledWith('defaultChatFolderId', undefined);
    expect(mocks.dispatch).toHaveBeenCalledWith('changing_folder_from_sidebar', {id: 0});
    expect(mocks.toast).toHaveBeenCalledWith({langPackKey: 'ChatList.Filter.RemoveDefaultToast'});
  });
  it('allows explicitly restoring Chats and excludes Archived', () => {
    mocks.settings.defaultChatFolderId = 4;
    const [set] = open(0);
    expect(set.verify()).toBe(true);
    set.onClick();
    expect(mocks.dispatch).toHaveBeenCalledWith('changing_folder_from_sidebar', {id: 0});
    expect(open(1).slice(0, 2).every((button: any) => !button.verify())).toBe(true);
  });
});
