import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {describe, expect, it, vi} from 'vitest';

// Execute the actual handler without importing the chat's browser/worker graph.
// This covers the wiring as well as the predicate: deleting the group block or
// returning early on a peer switch must break these tests.
function compileHandler(file: string, find: (node: ts.Node) => ts.Node | undefined, dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let handler: ts.Node;
  function visit(node: ts.Node) {
    handler ||= find(node);
    if(!handler) ts.forEachChild(node, visit);
  }
  visit(source);
  if(!handler) throw new Error(`Handler missing in ${file}`);
  const callable = handler as ts.ArrowFunction | ts.MethodDeclaration;
  const asyncPrefix = callable.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
  const expression = `${asyncPrefix}function(${callable.parameters.map(parameter => parameter.getText(source)).join(',')}) ${callable.body.getText(source)}`;
  const js = ts.transpileModule(`const handler = ${expression};`, {
    compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS}
  }).outputText;
  return new Function(...Object.keys(dependencies), `${js}\nreturn handler;`)(...Object.values(dependencies));
}

function menuHarness(options: {admin?: string, own?: string, failure?: 'import' | 'store', switchPeer?: boolean, missing?: boolean} = {}) {
  const replaceWith = vi.fn();
  const onOpen = vi.fn();
  const bar = {
    peerId: -2000000000000001,
    chat: {monoforumThreadId: 0},
    menuButtons: [{element: {lastChild: {replaceWith}}}],
    managers: {appPeersManager: {getDeleteButtonText: vi.fn().mockResolvedValue('ChatList.Context.LeaveGroup')}},
    autoDeleteBtnMenuOptions: {onOpen}
  };
  const getByPeerId = vi.fn(async() => {
    if(options.failure === 'store') throw new Error('IndexedDB unavailable');
    if(options.switchPeer) bar.peerId--;
    return options.missing ? undefined : {adminPubkey: options.admin ?? 'admin'};
  });
  const handler = compileHandler('src/components/chat/topbar.ts', node => {
    if(ts.isCallExpression(node) && node.expression.getText() === 'ButtonMenuToggle') {
      const object = node.arguments[0];
      if(ts.isObjectLiteralExpression(object)) {
        const property = object.properties.find(property => property.name?.getText() === 'onOpen');
        if(property && ts.isPropertyAssignment(property) && property.initializer.getText().includes('deleteButtonText')) return property.initializer;
      }
    }
  }, {
    isGroupPeer: (peer: number) => peer < -2000000000000000,
    window: {__phantomchatOwnPubkey: options.own ?? 'admin'},
    i18n: (key: string) => key,
    require: () => {
      if(options.failure === 'import') throw new Error('Stale chunk');
      return {getGroupStore: () => ({getByPeerId})};
    }
  });
  return {bar, run: () => handler.call(bar), replaceWith, onOpen, getByPeerId};
}

describe('chat menu delete label', () => {
  it('shows Delete for the group admin', async() => {
    const h = menuHarness();
    await h.run();
    expect(h.replaceWith).toHaveBeenCalledWith('Delete');
    expect(h.getByPeerId).toHaveBeenCalledWith(h.bar.peerId);
    expect(h.onOpen).toHaveBeenCalledOnce();
  });

  it.each([{own: 'member'}, {own: ''}, {missing: true}])('keeps Leave Group without admin authority: %j', async(options) => {
    const h = menuHarness(options);
    await h.run();
    expect(h.replaceWith).toHaveBeenCalledWith('ChatList.Context.LeaveGroup');
  });

  it.each(['import', 'store'] as const)('opens with Leave Group after %s failure', async(failure) => {
    const h = menuHarness({failure});
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.replaceWith).toHaveBeenCalledWith('ChatList.Context.LeaveGroup');
    expect(h.onOpen).toHaveBeenCalledOnce();
  });

  it('skips a stale label write but still runs the submenu hook after switching chats', async() => {
    const h = menuHarness({switchPeer: true});
    await h.run();
    expect(h.replaceWith).not.toHaveBeenCalled();
    expect(h.onOpen).toHaveBeenCalledOnce();
  });

  it('preserves the manager label for other peers', async() => {
    const h = menuHarness();
    h.bar.peerId = 123;
    h.bar.managers.appPeersManager.getDeleteButtonText.mockResolvedValue('DeleteChat');
    await h.run();
    expect(h.replaceWith).toHaveBeenCalledWith('DeleteChat');
    expect(h.getByPeerId).not.toHaveBeenCalled();
  });
});

describe('unsupported scoped chat search', () => {
  const initSearch = compileHandler('src/components/chat/chat.ts', node => {
    if(ts.isMethodDeclaration(node) && node.name.getText() === 'initSearch') return node;
  }, {});

  it.each([{}, {query: 'selected text'}, {filterPeerId: 123}, {query: '#tag'}, {reaction: {_: 'reactionEmoji', emoticon: '👍'}}])('does not open the panel from entry point %j', options => {
    const searchSignal = vi.fn();
    initSearch.call({peerId: -2000000000000001, searchSignal}, options);
    initSearch.call({peerId: 1000000000000001, searchSignal}, options);
    expect(searchSignal).not.toHaveBeenCalled();
  });
});
