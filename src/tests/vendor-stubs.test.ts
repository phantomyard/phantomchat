describe('Vendor stubs — API shape verification', () => {
  describe('bezierEasing', () => {
    it('default export is a callable function that returns a function', async() => {
      const {default: BezierEasing} = await import('@vendor/bezierEasing');
      expect(typeof BezierEasing).toBe('function');
      const ease = BezierEasing(0.42, 0, 1.0, 1.0);
      expect(typeof ease).toBe('function');
      const result = ease(0.5);
      expect(typeof result).toBe('number');
    });
  });

  describe('convertPunycode', () => {
    it('default export has toASCII and toUnicode methods', async() => {
      const {default: punycode} = await import('@vendor/convertPunycode');
      expect(typeof punycode.toASCII).toBe('function');
      expect(typeof punycode.toUnicode).toBe('function');
    });
  });

  describe('fastBlur', () => {
    it('default export is a function', async() => {
      const {default: fastBlur} = await import('@vendor/fastBlur');
      expect(typeof fastBlur).toBe('function');
    });
  });

  describe('prism', () => {
    it('default export has highlight method and languages object', async() => {
      const {default: Prism} = await import('@vendor/prism');
      expect(typeof Prism.highlight).toBe('function');
      expect(typeof Prism.languages).toBe('object');
    });
  });

  describe('emoji', () => {
    it('exports getCountryEmoji, toCodePoints, emojiFromCodePoints, encodeEmoji, getEmojiToneIndex, emojiRegExp', async() => {
      const emoji = await import('@vendor/emoji/index');
      expect(typeof emoji.getCountryEmoji).toBe('function');
      expect(typeof emoji.toCodePoints).toBe('function');
      expect(typeof emoji.emojiFromCodePoints).toBe('function');
      expect(typeof emoji.encodeEmoji).toBe('function');
      expect(typeof emoji.getEmojiToneIndex).toBe('function');
      expect(emoji.emojiRegExp).toBeTruthy();
    });
  });

  describe('solid-transition-group', () => {
    it('exports Transition and TransitionGroup', async() => {
      const stg = await import('@vendor/solid-transition-group/index');
      expect(typeof stg.Transition).toBe('function');
      expect(typeof stg.TransitionGroup).toBe('function');
    });
  });
});
