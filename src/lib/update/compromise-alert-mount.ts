import type {CompromiseReason} from '@lib/update/types';

export async function mountCompromiseAlert(reason: CompromiseReason): Promise<void> {
  const mod = await import('@components/updateCompromise');
  mod.mountCompromiseAlert(reason);
}
