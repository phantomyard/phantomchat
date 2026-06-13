/**
 * Re-exports the bundle's declared service worker URL.
 * Kept as its own module so update-bootstrap can read it without pulling in
 * apiManagerProxy (which would create a circular-init-order dependency).
 */
import ServiceWorkerURL from '../../../sw?worker&url';

export {ServiceWorkerURL};
