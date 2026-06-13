import {createSignal, onCleanup} from 'solid-js';
import {TextWithEntities} from '@layer';
import wrapEmojiText from '@lib/richTextProcessor/wrapEmojiText';
import defineSolidElement, {PassedProps} from '@lib/solidjs/defineSolidElement';
import {InputFieldEmoji} from '@components/inputFieldEmoji';
import {InputFieldTsx} from '@components/inputFieldTsx';
import FolderIconPicker, {MAX_FOLDER_NAME_LENGTH} from './folderIconPicker';

if(import.meta.hot) import.meta.hot.accept();

type Props = {
  value?: TextWithEntities.textWithEntities;
  onInput: (value: string) => void;
};

type Controls = {
  inputField: InputFieldEmoji;
};

// Pushes a plain-text title into the contenteditable input of an InputFieldEmoji,
// rewrapping emoji glyphs and triggering an input event so downstream listeners
// (editCheckForChange, onRawInput) see the change.
function writeTitleToInputField(input: InputFieldEmoji | undefined, next: string) {
  if(!input?.input) return;
  const wrapped = wrapEmojiText(next);
  input.input.replaceChildren();
  input.input.append(wrapped);
  input.input.dispatchEvent(new Event('input', {bubbles: true}));
}

const EditFolderInput = defineSolidElement({
  name: 'edit-folder-input',
  component: (props: PassedProps<Props>, _, controls: Controls) => {
    const [getTitle, setTitle] = createSignal<string>(props.value?.text ?? '');

    onCleanup(() => {
      controls.inputField?.cleanup();
    });

    // Keep the Solid signal in sync when the user types directly into the input.
    const handleRawInput = (value: string) => {
      setTitle(value);
      props.onInput(value);
    };

    return (
      <div style="display:flex;align-items:center;gap:8px">
        <FolderIconPicker
          getTitle={getTitle}
          setTitle={(next) => {
            setTitle(next);
            writeTitleToInputField(controls.inputField, next);
          }}
        />
        <InputFieldTsx
          InputFieldClass={InputFieldEmoji}
          instanceRef={(value) => void (controls.inputField = value)}
          label='FilterNameHint'
          maxLength={MAX_FOLDER_NAME_LENGTH}
          value={props.value ? wrapEmojiText(props.value.text, true, props.value.entities) : ''}
          onRawInput={handleRawInput}
        />
      </div>
    );
  }
});

export default EditFolderInput;
