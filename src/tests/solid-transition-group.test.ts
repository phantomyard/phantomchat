// Tests for solid-transition-group CSS lifecycle implementation
// These tests verify CSS class application patterns used for animation

describe('solid-transition-group CSS class lifecycle', () => {
  describe('exports', () => {
    it('exports Transition, CSSTransition, TransitionGroup as functions', async() => {
      const stg = await import('@vendor/solid-transition-group/index');
      expect(typeof stg.Transition).toBe('function');
      expect(typeof stg.CSSTransition).toBe('function');
      expect(typeof stg.TransitionGroup).toBe('function');
    });
  });

  describe('getTransitionClasses', () => {
    it('is exported from vendor module', async() => {
      const stg = await import('@vendor/solid-transition-group/index') as any;
      expect(typeof stg.getTransitionClasses).toBe('function');
    });

    it('derives enter/exit class names from name prop', async() => {
      const {getTransitionClasses} = await import('@vendor/solid-transition-group/index') as any;
      const classes = getTransitionClasses({name: 'slide-fade'});
      expect(classes.enter).toBe('slide-fade-enter');
      expect(classes.enterActive).toBe('slide-fade-enter-active');
      expect(classes.exit).toBe('slide-fade-exit');
      expect(classes.exitActive).toBe('slide-fade-exit-active');
    });

    it('uses custom enterClass/exitClass/enterActiveClass/exitActiveClass when provided', async() => {
      const {getTransitionClasses} = await import('@vendor/solid-transition-group/index') as any;
      const classes = getTransitionClasses({
        name: 'slide',
        enterClass: 'custom-enter',
        exitClass: 'custom-exit',
        enterActiveClass: 'custom-enter-active',
        exitActiveClass: 'custom-exit-active'
      });
      expect(classes.enter).toBe('custom-enter');
      expect(classes.exit).toBe('custom-exit');
      expect(classes.enterActive).toBe('custom-enter-active');
      expect(classes.exitActive).toBe('custom-exit-active');
    });

    it('returns empty strings when name is undefined (graceful no-op)', async() => {
      const {getTransitionClasses} = await import('@vendor/solid-transition-group/index') as any;
      const classes = getTransitionClasses({});
      expect(classes.enter).toBe('');
      expect(classes.enterActive).toBe('');
      expect(classes.exit).toBe('');
      expect(classes.exitActive).toBe('');
    });
  });

  describe('enterElement', () => {
    it('is exported from vendor module', async() => {
      const stg = await import('@vendor/solid-transition-group/index') as any;
      expect(typeof stg.enterElement).toBe('function');
    });

    it('calls onBeforeEnter before entering', async() => {
      const {enterElement} = await import('@vendor/solid-transition-group/index') as any;
      const el = document.createElement('div');
      const onBeforeEnter = vi.fn();
      const onEnter = vi.fn((_el: Element, done: () => void) => done());
      await enterElement(el, {name: 'fade', onBeforeEnter, onEnter});
      expect(onBeforeEnter).toHaveBeenCalledWith(el);
    });

    it('calls onEnter with element and done callback', async() => {
      const {enterElement} = await import('@vendor/solid-transition-group/index') as any;
      const el = document.createElement('div');
      const onEnter = vi.fn((_el: Element, done: () => void) => done());
      await enterElement(el, {name: 'fade', onEnter});
      expect(onEnter).toHaveBeenCalledWith(el, expect.any(Function));
    });

    it('calls onAfterEnter after done', async() => {
      const {enterElement} = await import('@vendor/solid-transition-group/index') as any;
      const el = document.createElement('div');
      const onAfterEnter = vi.fn();
      const onEnter = vi.fn((_el: Element, done: () => void) => done());
      await enterElement(el, {name: 'fade', onEnter, onAfterEnter});
      expect(onAfterEnter).toHaveBeenCalledWith(el);
    });

    it('applies enter class before onEnter is called', async() => {
      const {enterElement} = await import('@vendor/solid-transition-group/index') as any;
      const el = document.createElement('div');
      const classesAtEnter: string[] = [];
      const onEnter = vi.fn((capturedEl: Element, done: () => void) => {
        classesAtEnter.push(...Array.from((capturedEl as HTMLElement).classList));
        done();
      });
      await enterElement(el, {name: 'test', onEnter});
      const hasEnterClass = classesAtEnter.includes('test-enter') ||
        classesAtEnter.includes('test-enter-active');
      expect(hasEnterClass).toBe(true);
    });

    it('removes enter classes after done', async() => {
      const {enterElement} = await import('@vendor/solid-transition-group/index') as any;
      const el = document.createElement('div');
      const onEnter = vi.fn((_el: Element, done: () => void) => done());
      await enterElement(el, {name: 'test', onEnter});
      expect(el.classList.contains('test-enter')).toBe(false);
      expect(el.classList.contains('test-enter-active')).toBe(false);
    });
  });

  describe('exitElement', () => {
    it('is exported from vendor module', async() => {
      const stg = await import('@vendor/solid-transition-group/index') as any;
      expect(typeof stg.exitElement).toBe('function');
    });

    it('calls onBeforeExit before exiting', async() => {
      const {exitElement} = await import('@vendor/solid-transition-group/index') as any;
      const el = document.createElement('div');
      const onBeforeExit = vi.fn();
      const onExit = vi.fn((_el: Element, done: () => void) => done());
      await exitElement(el, {name: 'fade', onBeforeExit, onExit});
      expect(onBeforeExit).toHaveBeenCalledWith(el);
    });

    it('calls onExit with element and done callback', async() => {
      const {exitElement} = await import('@vendor/solid-transition-group/index') as any;
      const el = document.createElement('div');
      const onExit = vi.fn((_el: Element, done: () => void) => done());
      await exitElement(el, {name: 'fade', onExit});
      expect(onExit).toHaveBeenCalledWith(el, expect.any(Function));
    });

    it('calls onAfterExit after done', async() => {
      const {exitElement} = await import('@vendor/solid-transition-group/index') as any;
      const el = document.createElement('div');
      const onAfterExit = vi.fn();
      const onExit = vi.fn((_el: Element, done: () => void) => done());
      await exitElement(el, {name: 'fade', onExit, onAfterExit});
      expect(onAfterExit).toHaveBeenCalledWith(el);
    });
  });
});
