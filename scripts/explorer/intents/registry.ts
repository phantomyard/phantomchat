import type {IntentDef} from './types';
import {messagingIntents} from './messaging';
import {navigationIntents} from './navigation';
import {profileIntents} from './profile';
import {messagingEdgeIntents} from './messaging-edge';
import {networkIntents} from './network';
import {settingsIntents} from './settings';
import {mediaIntents} from './media';

export const registry: Record<string, IntentDef<any>> = {
  ...messagingIntents,
  ...navigationIntents,
  ...profileIntents,
  ...messagingEdgeIntents,
  ...networkIntents,
  ...settingsIntents,
  ...mediaIntents
};
