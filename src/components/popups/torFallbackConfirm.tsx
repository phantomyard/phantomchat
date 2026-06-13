import {JSX} from 'solid-js';

export default function TorFallbackConfirm(props: {
  onRetry: () => void;
  onConfirmDirect: () => void;
  onClose: () => void;
}): JSX.Element {
  const handleOverlayClick = (e: MouseEvent) => {
    // Modal — do NOT close on overlay click
    e.stopPropagation();
  };

  return (
    <div class="tor-popup-overlay" onClick={handleOverlayClick}>
      <div class="tor-popup" onClick={(e) => e.stopPropagation()}>
        <div class="tor-popup__title">Tor non disponibile</div>
        <div class="tor-popup__body">
          Continuare con connessione diretta? Il tuo IP sara' visibile ai relay.
        </div>
        <div class="tor-popup__actions">
          <button
            class="tor-popup__btn tor-popup__btn--secondary"
            onClick={() => {
              props.onRetry();
              props.onClose();
            }}
          >
            Riprova
          </button>
          <button
            class="tor-popup__btn tor-popup__btn--warning"
            onClick={() => {
              props.onConfirmDirect();
              props.onClose();
            }}
          >
            Continua
          </button>
        </div>
      </div>
    </div>
  );
}
