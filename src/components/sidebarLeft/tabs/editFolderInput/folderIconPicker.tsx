import {createMemo, onCleanup, Show} from 'solid-js';
import rootScope from '@lib/rootScope';
import cloneDOMRect from '@helpers/dom/cloneDOMRect';
import {EmoticonsDropdown} from '@components/emoticonsDropdown';
import EmojiTab from '@components/emoticonsDropdown/tabs/emoji';
import {extractLeadingEmoji, setLeadingEmoji} from './titleIconOps';
import styles from './folderIconPicker.module.scss';

export const MAX_FOLDER_NAME_LENGTH = 12;

type Props = {
  getTitle: () => string;
  setTitle: (value: string) => void;
};

export default function FolderIconPicker(props: Props) {
  // The preview tracks the live leading emoji of the title signal. No local
  // state: the parent-owned title signal is the single source of truth.
  const getCurrent = createMemo(() => extractLeadingEmoji(props.getTitle()));

  let buttonRef: HTMLDivElement;
  let dropdown: EmoticonsDropdown | undefined;

  const openDropdown = () => {
    if(dropdown) return;

    const emojiTab = new EmojiTab({
      managers: rootScope.managers,
      additionalStickerViewerClass: styles.Dropdown,
      noPacks: !rootScope.premium,
      noSearchGroups: !rootScope.premium,
      onClick: (emoji) => {
        if(emoji.docId) return; // custom emoji: not supported as folder icon
        const title = props.getTitle();
        const next = setLeadingEmoji(title, emoji.emoji, MAX_FOLDER_NAME_LENGTH);
        props.setTitle(next);
        dropdown?.hideAndDestroy();
      }
    });

    dropdown = new EmoticonsDropdown({
      tabsToRender: [emojiTab],
      customParentElement: document.body,
      getOpenPosition: () => {
        const rect = buttonRef.getBoundingClientRect();
        const cloned = cloneDOMRect(rect);
        cloned.left = rect.left + rect.width / 2;
        cloned.top = rect.top + rect.height / 2;
        return cloned;
      }
    });

    dropdown.getElement()?.classList.add(styles.Dropdown);
    dropdown.setTextColor('primary-text-color');
    dropdown.addEventListener('closed', () => {
      dropdown?.hideAndDestroy();
      dropdown = undefined;
    });
    dropdown.onButtonClick();
  };

  onCleanup(() => {
    dropdown?.hideAndDestroy();
  });

  return (
    <div
      ref={(el) => (buttonRef = el)}
      class={styles.FolderIconPicker}
      onClick={openDropdown}
      title="Choose folder icon"
      role="button"
      tabIndex={0}
    >
      <Show when={getCurrent()} fallback={<span>🙂</span>}>
        <span>{getCurrent()}</span>
      </Show>
    </div>
  );
}
