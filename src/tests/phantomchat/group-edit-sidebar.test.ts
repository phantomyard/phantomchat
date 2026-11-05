import {describe, it, expect} from 'vitest';
import fs from 'fs';
import {handleSelectedChatClick, shouldOpenEditorOnSelectedChat} from '@lib/phantomchat/group-edit-click';
import {getGroupEditSavePlan} from '@components/sidebarRight/tabs/phantomchatGroupEditState';
import {SESSION_PEER_BASE, GROUP_PEER_BASE} from '@lib/phantomchat/group-types';

const read = (path: string) => fs.readFileSync(path, 'utf-8');
const groupPeerId = -Number(GROUP_PEER_BASE) - 7;
const sessionPeerId = -Number(SESSION_PEER_BASE) - 7;
const p2pPeerId = 1000000000000001; // synthetic P2P range

describe('chat list click on the already-open chat', () => {
  const base = {peerId: groupPeerId, isActive: true, isLessThanFloatingLeftSidebar: false};

  it('opens the editor for an active group chat', () => {
    expect(shouldOpenEditorOnSelectedChat(base)).toBe(true);
  });

  it('opens the editor for an active session (sessions share the group peer class)', () => {
    expect(shouldOpenEditorOnSelectedChat({...base, peerId: sessionPeerId})).toBe(true);
  });

  it('falls through to opening the chat when the list and the chat cannot sit side by side', () => {
    // Below the floating-left-sidebar breakpoint the chat replaces the list, so
    // the selected row is the only way back to the bubbles.
    expect(shouldOpenEditorOnSelectedChat({...base, isLessThanFloatingLeftSidebar: true})).toBe(false);
    expect(shouldOpenEditorOnSelectedChat({
      ...base,
      peerId: sessionPeerId,
      isLessThanFloatingLeftSidebar: true
    })).toBe(false);
  });

  it('leaves a row that is not the open chat alone', () => {
    expect(shouldOpenEditorOnSelectedChat({...base, isActive: false})).toBe(false);
  });

  it('keeps message jumps, threads, forum parents and modified clicks untouched', () => {
    expect(shouldOpenEditorOnSelectedChat({...base, lastMsgId: 42})).toBe(false);
    expect(shouldOpenEditorOnSelectedChat({...base, threadId: 42})).toBe(false);
    expect(shouldOpenEditorOnSelectedChat({...base, monoforumParentPeerId: 42})).toBe(false);
    expect(shouldOpenEditorOnSelectedChat({...base, shiftKey: true})).toBe(false);
    expect(shouldOpenEditorOnSelectedChat({...base, ctrlKey: true})).toBe(false);
    expect(shouldOpenEditorOnSelectedChat({...base, metaKey: true})).toBe(false);
  });

  it('routes ctrl- and cmd-clicks through the listener to the new-tab path, plain clicks to the editor', () => {
    const route = {peerId: groupPeerId, isActive: true, isLessThanFloatingLeftSidebar: false};
    const clicked = {mode: 'none'};
    const opened: number[] = [];

    const row = document.createElement('div');
    row.className = 'active';
    document.body.append(row);

    // The handler the manager installs for this rule, driven by real events.
    const listener = (e: MouseEvent) => {
      if(handleSelectedChatClick(e, route, (peerId) => opened.push(peerId))) return;
      if(e.ctrlKey || e.metaKey) {
        clicked.mode = 'new-tab';
        return;
      }

      clicked.mode = 'other';
    };

    row.addEventListener('mousedown', listener);

    for(const mods of [{ctrlKey: true}, {metaKey: true}]) {
      clicked.mode = 'none';
      const event = new MouseEvent('mousedown', {bubbles: true, cancelable: true, ...mods});
      row.dispatchEvent(event);
      expect(clicked.mode).toBe('new-tab');
      expect(event.defaultPrevented).toBe(false);
    }

    expect(opened).toEqual([]);

    clicked.mode = 'none';
    const plain = new MouseEvent('mousedown', {bubbles: true, cancelable: true});
    row.dispatchEvent(plain);
    expect(opened).toEqual([groupPeerId]);
    expect(clicked.mode).toBe('none');
    expect(plain.defaultPrevented).toBe(true);

    row.remove();
  });

  it('does not hijack P2P rows on narrow layouts or MTProto peers', () => {
    expect(shouldOpenEditorOnSelectedChat({...base, peerId: p2pPeerId})).toBe(true);
    expect(shouldOpenEditorOnSelectedChat({...base, peerId: p2pPeerId, isLessThanFloatingLeftSidebar: true})).toBe(false);
    expect(shouldOpenEditorOnSelectedChat({...base, peerId: 987654321})).toBe(false);
  });

  it('is wired into the chat list click handler through the shared editor entry point', () => {
    const source = read('src/lib/appDialogsManager.ts');
    expect(source).toContain('handleSelectedChatClick(');
    expect(source).toContain("elem.classList.contains('active')");
    expect(source).toContain("import('@components/peerActionsMenu').then((m) => m.openPeerEditor(editorPeerId))");
    // The narrow layout has to reach `openChat()` below instead.
    expect(source).toContain('isLessThanFloatingLeftSidebar: mediaSizes.isLessThanFloatingLeftSidebar');
    expect(source.indexOf('openChat();')).toBeGreaterThan(source.indexOf('handleSelectedChatClick('));
    // ctrl/meta must still reach the existing open-in-new-tab branch below.
    expect(source.indexOf('if(e.ctrlKey || e.metaKey)')).toBeGreaterThan(source.indexOf('handleSelectedChatClick('));
  });
});

describe('group/session editor save plan', () => {
  const members = ['admin', 'bob'];

  it('saves a pasted name even when no keystroke preceded the press', () => {
    const plan = getGroupEditSavePlan('Old', 'Pasted Name', members, members);
    expect(plan).toMatchObject({name: 'Pasted Name', nameChanged: true, hasChanges: true});
  });

  it('treats an unchanged name and roster as a plain close, not a dead click', () => {
    expect(getGroupEditSavePlan('Same', 'Same', members, members).hasChanges).toBe(false);
    expect(getGroupEditSavePlan('Same', '  Same  ', members, members).hasChanges).toBe(false);
  });

  it('never saves an empty or whitespace-only name over the chat title', () => {
    const plan = getGroupEditSavePlan('Same', '   ', members, members);
    expect(plan.name).toBe('');
    expect(plan.nameChanged).toBe(false);
    expect(plan.hasChanges).toBe(false);
  });

  it('still persists roster changes while ignoring a cleared name', () => {
    const plan = getGroupEditSavePlan('Same', '', members, ['admin', 'bob', 'carol']);
    expect(plan.nameChanged).toBe(false);
    expect(plan.added).toEqual(['carol']);
    expect(plan.hasChanges).toBe(true);
  });

  it('reports removals alongside a rename', () => {
    const plan = getGroupEditSavePlan('Old', 'New', members, ['admin']);
    expect(plan.nameChanged).toBe(true);
    expect(plan.removed).toEqual(['bob']);
    expect(plan.hasChanges).toBe(true);
  });
});

describe('group/session editor labels', () => {
  const tabSource = read('src/components/sidebarRight/tabs/phantomchatGroupEdit.ts');
  const strings = read('src/scripts/out/langPack.strings');

  it('labels the name field "Name" and the member picker row "Add Members"', () => {
    expect(tabSource).toContain("'PhantomChat.GroupEdit.Name'");
    expect(tabSource).toContain("'PhantomChat.GroupEdit.AddMembers'");
    expect(tabSource).not.toContain('CreateGroup.NameHolder');
    expect(tabSource).not.toContain('PhantomChat.GroupEdit.GroupMembers');
    expect(strings).toContain('"PhantomChat.GroupEdit.Name" = "Name";');
    expect(strings).toContain('"PhantomChat.GroupEdit.AddMembers" = "Add Members";');
  });

  it('keeps the check button always visible instead of gating it on a dirty field', () => {
    // `.btn-corner` rests one button-height below the pane and only
    // `.is-visible` brings it back, so the editor sets the class once at
    // creation rather than toggling it from a dirty check.
    expect(tabSource).not.toContain("saveBtn.classList.toggle('is-visible'");
    expect(tabSource).toContain("saveBtn.classList.add('is-visible')");
    expect(tabSource).toContain('this.content.append(saveBtn)');
  });
});
