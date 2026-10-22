/*
 * Side-effect module (#246): installs the persistent diagnostics log as soon
 * as it is evaluated. index.worker.ts imports it right after the polyfills —
 * ES imports are hoisted, so a plain call in the worker body would only run
 * after every other import had already evaluated (and possibly thrown).
 */
import {installDiagnosticsLog} from '@lib/phantomchat/diagnostics-log';

installDiagnosticsLog({context: 'worker'});
