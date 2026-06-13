// @ts-nocheck
// Solid transition group - real CSS transition implementation

import {JSX, Show, For, createSignal, onCleanup, children as resolveChildren, createEffect, untrack} from 'solid-js';

export interface TransitionProps {
  children?: JSX.Element;
  mode?: string;
  name?: string;
  class?: string;
  enterClass?: string;
  exitClass?: string;
  exitToClass?: string;
  enterActiveClass?: string;
  exitActiveClass?: string;
  duration?: number;
  appear?: boolean;
  onBeforeEnter?: (el: Element) => void;
  onEnter?: (el: Element, done: () => void) => void;
  onAfterEnter?: (el: Element) => void;
  onBeforeExit?: (el: Element) => void;
  onExit?: (el: Element, done: () => void) => void;
  onAfterExit?: (el: Element) => void;
}

export interface TransitionClasses {
  enter: string;
  enterActive: string;
  exit: string;
  exitActive: string;
}

export function getTransitionClasses(props: TransitionProps): TransitionClasses {
  const name = props.name || '';
  return {
    enter: props.enterClass !== undefined ? props.enterClass : (name ? `${name}-enter` : ''),
    enterActive: props.enterActiveClass !== undefined ? props.enterActiveClass : (name ? `${name}-enter-active` : ''),
    exit: props.exitClass !== undefined ? props.exitClass : (name ? `${name}-exit` : ''),
    exitActive: props.exitActiveClass !== undefined ? props.exitActiveClass : (name ? `${name}-exit-active` : '')
  };
}

function applyClass(el: Element, cls: string) {
  if(cls) el.classList.add(cls);
}

function removeClass(el: Element, cls: string) {
  if(cls) el.classList.remove(cls);
}

export function enterElement(el: Element, props: TransitionProps): Promise<void> {
  return new Promise((resolve) => {
    const classes = getTransitionClasses(props);

    if(props.onBeforeEnter) props.onBeforeEnter(el);

    applyClass(el, classes.enter);

    requestAnimationFrame(() => {
      applyClass(el, classes.enterActive);

      const done = () => {
        removeClass(el, classes.enter);
        removeClass(el, classes.enterActive);
        if(props.onAfterEnter) props.onAfterEnter(el);
        resolve();
      };

      if(props.onEnter) {
        props.onEnter(el, done);
      } else {
        const onTransitionEnd = () => {
          el.removeEventListener('transitionend', onTransitionEnd);
          el.removeEventListener('animationend', onTransitionEnd);
          done();
        };
        el.addEventListener('transitionend', onTransitionEnd);
        el.addEventListener('animationend', onTransitionEnd);
      }
    });
  });
}

export function exitElement(el: Element, props: TransitionProps): Promise<void> {
  return new Promise((resolve) => {
    const classes = getTransitionClasses(props);

    if(props.onBeforeExit) props.onBeforeExit(el);

    applyClass(el, classes.exit);

    requestAnimationFrame(() => {
      applyClass(el, classes.exitActive);

      const done = () => {
        removeClass(el, classes.exit);
        removeClass(el, classes.exitActive);
        if(props.onAfterExit) props.onAfterExit(el);
        resolve();
      };

      if(props.onExit) {
        props.onExit(el, done);
      } else {
        const onTransitionEnd = () => {
          el.removeEventListener('transitionend', onTransitionEnd);
          el.removeEventListener('animationend', onTransitionEnd);
          done();
        };
        el.addEventListener('transitionend', onTransitionEnd);
        el.addEventListener('animationend', onTransitionEnd);
      }
    });
  });
}

export const Transition = (props: TransitionProps) => {
  return <Show when={props.children}>{props.children}</Show>;
};

export const CSSTransition = Transition;

export const TransitionGroup = (props: TransitionProps & {tag?: string}) => {
  const c = resolveChildren(() => props.children);
  return (
    <Show when={props.tag} fallback={<>{c()}</>}>
      <Show when={props.children}>
        <For each={Array.isArray(props.children) ? props.children : [props.children]}>
          {(child) => child}
        </For>
      </Show>
    </Show>
  );
};
