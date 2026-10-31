import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  getGroup: vi.fn(), update: vi.fn(), remove: vi.fn(), leave: vi.fn(), close: vi.fn(),
  sidebar: vi.fn(), toast: vi.fn(), confirm: vi.fn()
}));
vi.mock('@components/slider', () => ({SliderSuperTab: class {
  container = document.createElement('div');
  content = document.createElement('div');
  closeBtn = document.createElement('button');
  scrollable = this.content;
  middlewareHelper = {get: () => () => true};
  listenerSetter = {add: (target: EventTarget) => (event: string, listener: EventListener) => target.addEventListener(event, listener)};
  setTitle() {}
  close = mocks.close;
}}));
vi.mock('@components/settingSection', () => ({default: class {
  container = document.createElement('section');
  content = this.container;
}}));
vi.mock('@components/row', () => ({default: class {
  container = document.createElement('div');
  constructor(options: any) {
    this.container.textContent = options.title || options.titleLangKey || '';
    if(options.buttonRight) this.container.append(options.buttonRight);
  }
}}));
vi.mock('@components/inputField', () => ({default: class {
  container = document.createElement('div');
  input = document.createElement('input');
  constructor(options: any) {
    this.input.setAttribute('aria-label', options.label);
    this.container.append(this.input);
  }
  setOriginalValue(value: string) { this.input.value = value; }
  get value() { return this.input.value; }
}}));
vi.mock('@components/buttonCorner', () => ({default: () => {
  const button = document.createElement('button');
  button.className = 'save';
  return button;
}}));
vi.mock('@components/button', () => ({
  default: (_classes: string, options: any) => {
    const button = document.createElement('button');
    button.textContent = options.text || options.icon;
    return button;
  }, replaceButtonIcon: vi.fn()
}));
vi.mock('@components/avatarEdit', () => ({default: class {container = document.createElement('div');}}));
vi.mock('@components/avatarNew', () => ({avatarNew: () => ({node: document.createElement('div')})}));
vi.mock('@components/sidebarLeft/tabs/addMembers', () => ({default: class {}}));
vi.mock('@helpers/dom/clickEvent', () => ({attachClickEvent: (target: HTMLElement, callback: EventListener) => target.addEventListener('click', callback)}));
vi.mock('@components/confirmationPopup', () => ({default: mocks.confirm}));
vi.mock('@lib/phantomchat/group-api', () => ({getGroupAPI: () => ({updateGroupInfo: mocks.update, removeMember: mocks.remove, leaveGroup: mocks.leave})}));
vi.mock('@lib/phantomchat/group-store', () => ({getGroupStore: () => ({getByPeerId: mocks.getGroup})}));
vi.mock('@lib/phantomchat/virtual-peers-db', () => ({getAllMappings: async(): Promise<[]> => []}));
vi.mock('@lib/phantomchat/blossom-client', () => ({BlossomClient: class {}}));
vi.mock('@lib/rootScope', () => ({default: {managers: {}, dispatchEvent: vi.fn()}}));
vi.mock('@lib/langPack', () => ({i18n: (key: string) => ({textContent: key})}));
vi.mock('@components/toast', () => ({toastNew: mocks.toast}));
vi.mock('@components/sidebarRight', () => ({default: {toggleSidebar: mocks.sidebar}}));

import Editor from '@components/sidebarRight/tabs/phantomchatGroupEdit';

let group: any;
async function mount(admin = true) {
  (Number.prototype as any).toPeerId = function() { return Number(this); };
  (window as any).__phantomchatOwnPubkey = admin ? 'admin' : 'member';
  const tab = new Editor({} as any);
  tab.groupPeerId = -123;
  await tab.init();
  document.body.append(tab.content);
  return tab;
}
function rename(value: string) {
  const input = document.querySelector('input')!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  return input;
}
function enter(input: HTMLElement, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true, ...options});
  input.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
  group = {groupId: 'group', name: 'Original', description: 'Keep this description', adminPubkey: 'admin', members: ['admin', 'member']};
  mocks.getGroup.mockResolvedValue(group);
  mocks.update.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(undefined);
});

describe('mounted group edit pane', () => {
  it('removes description and hides unavailable Leave Group for admins', async() => {
    await mount();
    expect(document.querySelectorAll('input')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('ChatList.Context.LeaveGroup');
    expect(document.body.textContent).toContain('PhantomChat.GroupEdit.DeleteGroup');
  });

  it('keeps Leave Group available for members', async() => {
    await mount(false);
    const leave = [...document.querySelectorAll('button')].find(b => b.textContent === 'ChatList.Context.LeaveGroup')!;
    expect(leave.disabled).toBe(false);
    leave.click();
    await vi.waitFor(() => expect(mocks.leave).toHaveBeenCalledWith('group'));
    expect(document.querySelector('input')).toBeNull();
  });

  it.each(['enter', 'click'])('saves a rename with %s and preserves existing description', async(method) => {
    await mount();
    const input = rename(' Renamed ');
    if(method === 'enter') expect(enter(input).defaultPrevented).toBe(true);
    else (document.querySelector('.save') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith('group', {name: 'Renamed'});
    expect(group.description).toBe('Keep this description');
    expect(mocks.sidebar).toHaveBeenCalledWith(false);
  });

  it('does not submit unchanged, blank, composing or repeated Enter', async() => {
    await mount();
    enter(document.querySelector('input')!);
    enter(rename('   '));
    const input = rename('Renamed');
    enter(input, {isComposing: true});
    enter(input, {keyCode: 229});
    enter(input, {repeat: true});
    await Promise.resolve();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('shares the in-flight guard between Enter and Save', async() => {
    let resolve!: () => void;
    mocks.update.mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
    await mount();
    const input = rename('Renamed');
    enter(input);
    enter(input);
    (document.querySelector('.save') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    resolve();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  });

  it('retains failed edits and permits an Enter retry', async() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.update.mockRejectedValueOnce(new Error('offline'));
    await mount();
    const input = rename('Renamed');
    enter(input);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.close).not.toHaveBeenCalled();
    enter(input);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.update).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('Enter commits staged member removal even when the name is unchanged', async() => {
    await mount();
    const remove = [...document.querySelectorAll('button')].find(b => b.textContent === 'close')!;
    remove.click();
    await vi.waitFor(() => expect(document.querySelector('.save')!.classList.contains('is-visible')).toBe(true));
    enter(document.querySelector('input')!);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledWith('group', 'member');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
