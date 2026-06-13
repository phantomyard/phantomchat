import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext, Action, ActionSpec} from '../../../src/tests/fuzz/types';
import {editNameAction, editBioAction, setNip05Action, uploadAvatarAction} from '../../../src/tests/fuzz/actions/profile';

const EditProfileFieldParams = z.object({
  user: z.enum(['userA', 'userB']),
  field: z.enum(['displayName', 'bio', 'nip05']),
  value: z.string().max(500)
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

const fieldToAction: Record<'displayName'|'bio'|'nip05', ActionSpec> = {
  displayName: editNameAction,
  bio: editBioAction,
  nip05: setNip05Action
};

const fieldToArgKey: Record<'displayName'|'bio'|'nip05', string> = {
  displayName: 'newName',
  bio: 'newBio',
  nip05: 'nip05'
};

export const edit_profile_field: IntentDef<z.infer<typeof EditProfileFieldParams>> = {
  name: 'edit_profile_field',
  area: 'profile',
  paramsSchema: EditProfileFieldParams,
  description: 'Open settings, edit one of {displayName, bio, nip05}, save. Dispatches to the corresponding fuzz action (editNameAction/editBioAction/setNip05Action) using the correct arg key.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const spec = fieldToAction[params.field];
    const argKey = fieldToArgKey[params.field];
    const action: Action = {name: spec.name, args: {user: params.user, [argKey]: params.value}};
    const trace: AtomicAction[] = [
      {type: 'click', page: pageOf(params.user), selector: '.sidebar-header .btn-menu-toggle'},
      {type: 'click', page: pageOf(params.user), selector: 'menu Settings'},
      {type: 'click', page: pageOf(params.user), selector: 'profile-editor'},
      {type: 'fill', page: pageOf(params.user), selector: `[data-field="${params.field}"]`, value: params.value},
      {type: 'click', page: pageOf(params.user), selector: 'button.btn-save-profile'}
    ];
    try {
      await spec.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

const UploadAvatarParams = z.object({
  user: z.enum(['userA', 'userB']),
  size: z.number().int().min(16).max(128)
});

const ConfigureLightningParams = z.object({
  user: z.enum(['userA', 'userB']),
  address: z.string().min(3).max(80)
});

const EditRelaysParams = z.object({
  user: z.enum(['userA', 'userB']),
  add: z.array(z.string().url()).max(10),
  remove: z.array(z.string().url()).max(10)
});

export const upload_avatar: IntentDef<z.infer<typeof UploadAvatarParams>> = {
  name: 'upload_avatar',
  area: 'profile',
  paramsSchema: UploadAvatarParams,
  description: 'Upload a generated avatar image of the given size to the user\'s profile.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const action: Action = {name: 'uploadAvatar', args: params};
    const trace: AtomicAction[] = [
      {type: 'click', page: pageOf(params.user), selector: '.avatar-edit-btn'},
      {type: 'evaluate', page: pageOf(params.user), script: 'upload generated image'}
    ];
    try {
      await uploadAvatarAction.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const configure_lightning_address: IntentDef<z.infer<typeof ConfigureLightningParams>> = {
  name: 'configure_lightning_address',
  area: 'profile',
  paramsSchema: ConfigureLightningParams,
  description: 'Open profile settings, set the Lightning address (lud16) to the given value, save.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await u.page.locator('.sidebar-header .btn-menu-toggle').first().click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'menu-toggle'});
      await u.page.getByText('Settings', {exact: false}).first().click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'menu Settings'});
      const inputCandidates = [
        u.page.locator('[name="lud16"]').first(),
        u.page.locator('[name="lightning_address"]').first(),
        u.page.getByRole('textbox', {name: /lightning|lud16/i}).first()
      ];
      let filled = false;
      for(const c of inputCandidates) {
        const visible = await c.isVisible().catch(() => false);
        if(visible) {
          await c.fill(params.address);
          trace.push({type: 'fill', page: pageOf(params.user), selector: 'lightning input', value: params.address});
          filled = true;
          break;
        }
      }
      if(!filled) {
        return {ok: false, atomic_trace: trace, observations: [], error: 'lightning address input not found'};
      }
      const saveBtn = u.page.getByRole('button', {name: /save/i}).first();
      await saveBtn.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'save'});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const edit_relays_nip65: IntentDef<z.infer<typeof EditRelaysParams>> = {
  name: 'edit_relays_nip65',
  area: 'profile',
  paramsSchema: EditRelaysParams,
  description: 'Open relay settings, add/remove relays in the user\'s NIP-65 relay list, save.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await u.page.locator('.sidebar-header .btn-menu-toggle').first().click({timeout: 3000});
      await u.page.getByText('Settings', {exact: false}).first().click({timeout: 3000});
      const relaysItem = u.page.getByText(/relay/i).first();
      await relaysItem.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'relays settings'});
      for(const url of params.add) {
        const input = u.page.getByRole('textbox', {name: /add.*relay|relay.*url/i}).first();
        if(await input.isVisible().catch(() => false)) {
          await input.fill(url);
          await u.page.keyboard.press('Enter');
          trace.push({type: 'fill', page: pageOf(params.user), selector: 'relay input', value: url});
        }
      }
      for(const url of params.remove) {
        const removeBtn = u.page.locator(`[data-relay-url="${url}"] .btn-remove, [data-relay="${url}"] button[name="remove"]`).first();
        if(await removeBtn.isVisible().catch(() => false)) {
          await removeBtn.click({timeout: 1000});
          trace.push({type: 'click', page: pageOf(params.user), selector: `remove ${url}`});
        }
      }
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const profileIntents: Record<string, IntentDef<any>> = {
  edit_profile_field: edit_profile_field as IntentDef<any>,
  upload_avatar: upload_avatar as IntentDef<any>,
  configure_lightning_address: configure_lightning_address as IntentDef<any>,
  edit_relays_nip65: edit_relays_nip65 as IntentDef<any>
};
