# Coding Conventions

**Analysis Date:** 2026-03-31

## Naming Patterns

**Files:**
- TypeScript/TSX files use camelCase: `appChatsManager.ts`, `peerProfile.tsx`, `validateCard.ts`
- CSS modules use camelCase: `service.module.scss`, `archiveDialog.module.scss`
- Utility/helper functions in descriptive camelCase: `formatValueByPattern.ts`, `deepEqual.ts`, `replaceNonNumber.ts`
- Directories use camelCase: `appManagers/`, `sidebarLeft/`, `richTextProcessor/`
- No prefixes; import paths determine context via aliases

**Functions:**
- camelCase: `validateCardNumber()`, `getParticipantPeerId()`, `createNostraPeerConnection()`
- Factory functions prefixed with `create`: `createOfflineQueue()`, `createSignal()`, `createResource()`
- Predicate functions prefixed with `is` or `has`: `isConnected()`, `hasRights()`
- Async functions return Promises; no special naming convention
- Private class methods use `private` keyword, not prefix
- Helper functions named after their action: `formatInputValueByPattern()`, `deepEqual()`, `detectCardBrand()`

**Variables:**
- camelCase for locals and fields: `peerId`, `messageId`, `relayPool`, `publishResult`
- Boolean flags use `is`/`has` prefix: `isConnected`, `hasChildren`, `shouldFail`
- Constants use UPPER_SNAKE_CASE: `CARD_BRANDS`, `MAX_ACCOUNTS_FREE`, `TEST_SPONSORED`, `CHARS`
- Type aliases/enums in PascalCase: `LogTypes`, `PatternValidationOptions`
- Destructuring preferred with `const`: `const {sanitized, minLength} = getCardInfoByNumber(str);`

**Types:**
- TypeScript types and interfaces: PascalCase: `ChatAPI`, `PublishResult`, `RelayConfig`
- Branded types from MTProto: `PeerId`, `ChatId`, `UserId` (imported from `@layer`)
- Generic types: `T`, `K`, `V` for typical generics
- Intersection/union types named descriptively: `ChatRights = keyof ChatBannedRights['pFlags'] | ...`
- Omit/Pick utility patterns: `type MySponsoredPeer = Omit<SponsoredPeer, 'peer'> & {peer: PeerId}`

## Code Style

**Formatting:**
- 2 spaces for indentation (enforced by ESLint rule `indent: 2`)
- Single quotes for strings; template literals allowed
- Unix line endings (LF); files must end with newline
- No trailing spaces
- Max 2 consecutive blank lines (enforced by `no-multiple-empty-lines`)

**Linting:**
- ESLint flat config: `eslint.config.mjs`
- Rules for code consistency enforced:
  - `keyword-spacing`: no space after `if`, `for`, `while`, `switch`, `catch` → `if(condition)` not `if (condition)`
  - `space-before-function-paren: never` → `function foo()` not `function foo ()`
  - `comma-dangle: never` → `{a: 1, b: 2}` not `{a: 1, b: 2,}`
  - `object-curly-spacing: never` → `{a: 1}` not `{ a: 1 }`
  - `array-bracket-spacing: never` → `[1, 2]` not `[ 1, 2 ]`
  - `no-return-await: error` → use `return promise` directly, never `return await`
  - `prefer-const` with destructuring `all` → always use `const`, destructure aggressively
  - `@typescript-eslint/await-thenable: error` → prevent awaiting non-promises

**No formatting tool enforced** (no Prettier config found; rely on ESLint)

## Import Organization

**Order (enforced by convention, not linter):**
1. Node.js/Web APIs: `import crypto from 'crypto';`
2. Third-party frameworks: `import {createSignal} from 'solid-js';`
3. Local imports via path aliases (next 3 groups)
4. Type imports: `import type {ChatAPI} from '@lib/nostra/chat-api';`

**Path Aliases (must use these, never relative imports):**
```typescript
@components/*       → src/components/
@helpers/*          → src/helpers/
@hooks/*            → src/hooks/
@stores/*           → src/stores/
@lib/*              → src/lib/
@appManagers/*      → src/lib/appManagers/
@richTextProcessor/*→ src/lib/richTextProcessor/
@environment/*      → src/environment/
@customEmoji/*      → src/lib/customEmoji/
@rlottie/*          → src/lib/rlottie/
@config/*           → src/config/
@vendor/*           → src/vendor/
@layer              → src/layer.d.ts (MTProto API types)
@types              → src/types.d.ts (utility types)
@/*                 → src/
solid-js            → src/vendor/solid (custom fork)
solid-js/web        → src/vendor/solid/web
solid-js/store      → src/vendor/solid/store
```

**Example import structure:**
```typescript
import {createEffect, createResource, JSX, on} from 'solid-js';
import classNames from '@helpers/string/classNames';
import {Message} from '@layer';
import styles from '@components/chat/bubbles/service.module.scss';
```

## Error Handling

**Patterns:**
- Custom error types: Define with `type ErrorCode = 'invalid' | 'incomplete' | 'invalid_expiry'...`
- Error objects as tuples/discriminated unions: `{type: 'invalid', code: 'invalid'}` or `null` for success
- Validation functions return error descriptor or `null`: `validateCardNumber(str)` → `{type, code} | null`
- Throw only for truly exceptional conditions; prefer returning error objects for validation

**Example (card validation):**
```typescript
function makeValidationError(code?: string) {
  return code ? {type: 'invalid', code} : null;
}

export function validateCardNumber(str: string, options = {}) {
  const {sanitized, minLength} = getCardInfoByNumber(str);
  return makeCardNumberError(sanitized, minLength, options.ignoreIncomplete);
}
```

**Logging:**
- Framework: `@lib/logger` (custom logger, not console)
- Export constants: `LogTypes` enum (None=0, Error=1, Warn=2, Log=4, Debug=8)
- Usage: `logger.error('MyContext', 'message')`; conditional on debug level
- Debug logging controlled by `@config/debug` and query params (`?debug=1`)

## Comments

**When to Comment:**
- JSDoc for public API surfaces: functions, classes, exported types
- Line comments (`//`) for non-obvious logic or workarounds
- TODO/FIXME comments with context: `// TODO: check for transition type (transform, etc)`
- Copyright headers in files: `/* https://github.com/morethanwords/tweb ... */`

**JSDoc/TSDoc:**
- Minimal usage; types are inferred by TypeScript in most cases
- Document only when logic is not obvious from function signature
- Example comment style (from test files):
```typescript
/**
 * Tests for Nostra.chat ChatAPI module (Nostr-first transport)
 */
```

- No enforced @param/@returns; rely on type inference and parameter names

## Function Design

**Size:**
- No hard limit enforced; favor small, focused functions
- Complex business logic broken into helper functions with descriptive names
- Example: `validateCardNumber()` delegates to `makeCardNumberError()`, `getCardInfoByNumber()`

**Parameters:**
- Use object destructuring for 2+ params: `{ignoreIncomplete}`, `{channelId, offsetId, flags}`
- Optional params in object form: `options?: {date?: Date}`
- Type params explicitly when not obvious from usage context

**Return Values:**
- Async operations return Promises/null: `Promise<PublishResult>`, `{type, code} | null`
- Solid.js Signals return tuples: `const [value, setValue] = createSignal(...)`
- Void functions common in setup/lifecycle methods

## Module Design

**Exports:**
- Default export for single-purpose modules: `export default function classNames(...)`
- Named exports for multiple symbols: `export function validateCardNumber()`, `export type PatternValidationOptions`
- Type-only exports: `export type {ChatAPI, PublishResult}`

**Barrel Files:**
- Not commonly used; prefer direct imports with aliases
- Some utility dirs like `@helpers/` have many small files imported directly

**Class Patterns:**
- `AppManager` subclasses in `src/lib/appManagers/` extend base class
- Classes use `protected` for internal state; `private` for truly hidden
- Async initialization via `after()` hook method pattern:
```typescript
export class AppChatsManager extends AppManager {
  protected after() {
    // Called when state is loaded
    this.apiUpdatesManager.addMultipleEventsListeners({...});
  }
}
```

**Solid.js Component Patterns:**
- Components are `.tsx` files; props typed inline as object param
- Use `classNames()` helper for conditional CSS: `classNames('my-class', props.class)`
- CSS Modules imported as `styles`: `import styles from '.../component.module.scss'; <div class={styles.wrap}>`
- Reactive state via `createSignal`, `createResource`, Solid stores from `@stores/`
- Example:
```typescript
export default function MyComponent(props: {
  class?: string,
  children: JSX.Element
}) {
  return (
    <div class={classNames('my-class', props.class)}>
      {props.children}
    </div>
  );
}
```

---

*Convention analysis: 2026-03-31*
