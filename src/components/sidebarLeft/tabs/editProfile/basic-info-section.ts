/*
 * Nostra.chat — Profile "Basic Info" section
 *
 * Extracted from AppEditProfileTab so adding or removing individual input
 * fields (name, bio, website, lud16, and future additions) does not
 * require editing the orchestrator tab.
 */

import InputField from '@components/inputField';

export interface BasicInfoValues {
  displayName: string;
  bio: string;
  website: string;
  lud16: string;
}

export interface BasicInfoSection {
  /** The input fields, in render order — pass to EditPeer for change tracking. */
  inputFields: InputField[];
  /** Container to append under the avatar editor. */
  inputWrapper: HTMLElement;
  /** Set all fields' "original" values (for unchanged-state detection). */
  setInitialValues(values: Partial<BasicInfoValues>): void;
  /** Read the current values from the inputs. */
  getValues(): BasicInfoValues;
  /** Map of input name-attributes to their InputField — for focus() routing. */
  fieldsByName: Record<string, InputField>;
}

export function createBasicInfoSection(opts: {bioMaxLength: number}): BasicInfoSection {
  const displayNameInputField = new InputField({
    label: 'Name' as any,
    name: 'display-name',
    maxLength: 70,
    plainText: true
  });
  const bioInputField = new InputField({
    label: 'EditProfile.BioLabel',
    name: 'bio',
    maxLength: opts.bioMaxLength
  });
  const websiteInputField = new InputField({
    label: 'Website' as any,
    name: 'website',
    maxLength: 256,
    plainText: true
  });
  const lud16InputField = new InputField({
    label: 'Lightning Address' as any,
    name: 'lud16',
    maxLength: 256,
    plainText: true
  });

  const inputWrapper = document.createElement('div');
  inputWrapper.classList.add('input-wrapper');
  inputWrapper.append(
    displayNameInputField.container,
    bioInputField.container,
    websiteInputField.container,
    lud16InputField.container
  );

  const inputFields = [
    displayNameInputField,
    bioInputField,
    websiteInputField,
    lud16InputField
  ];

  return {
    inputFields,
    inputWrapper,
    setInitialValues(values) {
      if(values.displayName !== undefined) displayNameInputField.setOriginalValue(values.displayName, true);
      if(values.bio !== undefined) bioInputField.setOriginalValue(values.bio, true);
      if(values.website !== undefined) websiteInputField.setOriginalValue(values.website, true);
      if(values.lud16 !== undefined) lud16InputField.setOriginalValue(values.lud16, true);
    },
    getValues() {
      return {
        displayName: displayNameInputField.value.trim(),
        bio: bioInputField.value,
        website: websiteInputField.value.trim(),
        lud16: lud16InputField.value.trim()
      };
    },
    fieldsByName: {
      'display-name': displayNameInputField,
      'bio': bioInputField,
      'website': websiteInputField,
      'lud16': lud16InputField
    }
  };
}
