import {Component, createSignal, JSX} from 'solid-js';

import Icons from '@/icons';

import Scrollable from '@components/scrollable2';
import {IconTsx} from '@components/iconTsx';
import {copyTextToClipboard} from '@helpers/clipboard';

import styles from '@components/iconLibrary/iconLibrary.module.scss';


const icons = Object.keys(Icons) as Icon[];

const IconLibrary: Component<{}> = () => {
  const [selected, setSelected] = createSignal('');
  const [copied, setCopied] = createSignal(false);

  let timeout = 0;

  const onMouseEnter = (icon: Icon) => {
    setSelected(icon);
    setCopied(false);
    self.clearTimeout(timeout);
  };

  const onClick = (icon: Icon) => {
    // Shared helper (issue #215, review on #216): execCommand fallback
    // covers clipboard-write being denied; a raw writeText silently no-ops.
    void copyTextToClipboard(icon).then(() => {
      setCopied(true);

      self.clearTimeout(timeout);
      timeout = self.setTimeout(() => {
        setCopied(false);
      }, 2000);
    });
  };

  return (
    <div class={/* @once */ styles.Popup}>
      <div class={/* @once */ styles.Name}>
        {selected() || 'none'}
        {copied() && ' - Copied!'}
      </div>

      <Scrollable class={/* @once */ styles.Scrollable}>
        <div class={/* @once */ styles.Grid}>
          {/* @once */ icons.map(icon => <IconItem icon={/* @once */ icon} onMouseEnter={/* @once */ [onMouseEnter, icon]} onClick={/* @once */ [onClick, icon]} />)}
        </div>
      </Scrollable>
    </div>
  );
};

const IconItem: Component<{
  icon: Icon;
  onMouseEnter: JSX.EventHandlerUnion<HTMLSpanElement, MouseEvent>;
  onClick: JSX.EventHandlerUnion<HTMLSpanElement, MouseEvent>;
}> = (props) => {
  return <IconTsx class={/* @once */ styles.Icon} icon={/* @once */ props.icon} onMouseEnter={/* @once */ props.onMouseEnter} onClick={/* @once */ props.onClick} />;
};

export default IconLibrary;
