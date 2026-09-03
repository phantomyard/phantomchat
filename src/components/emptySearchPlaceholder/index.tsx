import {Show} from 'solid-js';
import {i18n} from '@lib/langPack';
import defineSolidElement, {PassedProps} from '@lib/solidjs/defineSolidElement';
import ripple from '@components/ripple';
import styles from '@components/emptySearchPlaceholder/styles.module.scss';
ripple;

if(import.meta.hot) import.meta.hot.accept();


type Props = {
  onAllChats?: () => void;
};

const EmptySearchPlaceholder = defineSolidElement({
  name: 'empty-search-placeholder',
  component: (props: PassedProps<Props>) => {
    props.element.classList.add(styles.Container);

    return (
      <>
        <img
          src="assets/img/PhantomScout.svg"
          alt="No results"
          width="156"
          height="156"
          class={styles.ScoutIllustration}
        />

        <div class={styles.NoResults}>
          <div class={styles.NoResultsTitle}>{i18n('NoResultsTitle')}</div>
          <div class={styles.NoResultsSubtitle}>{i18n('NoResultsSubtitle')}</div>
        </div>


        <Show when={props.onAllChats}>
          <button
            use:ripple
            class={`btn primary ${styles.ActionButton}`}
            onClick={props.onAllChats}
          >
            {i18n('SearchInAllChats')}
          </button>
        </Show>
      </>
    );
  }
});

export default EmptySearchPlaceholder;
