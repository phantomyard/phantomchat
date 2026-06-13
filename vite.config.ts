import {defineConfig} from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';
import handlebars from 'vite-plugin-handlebars';
import basicSsl from '@vitejs/plugin-basic-ssl';
import {visualizer} from 'rollup-plugin-visualizer';
import checker from 'vite-plugin-checker';
// import devtools from 'solid-devtools/vite'
import autoprefixer from 'autoprefixer';
import {resolve} from 'path';
import {existsSync, copyFileSync, readFileSync} from 'fs';
import {ServerOptions} from 'vite';
import {watchLangFile} from './watch-lang.js';
import path from 'path';

const rootDir = resolve(__dirname);
const pkgVersion = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version as string;
const certsDir = path.join(rootDir, 'certs');
const ENV_LOCAL_FILE_PATH = path.join(rootDir, '.env.local');
const LANG_PACK_LOCAL_FILE_PATH = path.join(rootDir, 'src', 'langPackLocalVersion.ts');

const isDEV = process.env.NODE_ENV === 'development';
if(!existsSync(LANG_PACK_LOCAL_FILE_PATH)) {
  copyFileSync(path.join(rootDir, 'src', 'langPackLocalVersion.example.ts'), LANG_PACK_LOCAL_FILE_PATH);
}

if(isDEV) {
  if(!existsSync(ENV_LOCAL_FILE_PATH)) {
    copyFileSync(path.join(rootDir, '.env.local.example'), ENV_LOCAL_FILE_PATH);
  }

  watchLangFile();
}

const handlebarsPlugin = handlebars({
  context: {
    title: 'Nostra.chat',
    description: 'Nostra.chat is a privacy-first messaging app with end-to-end encryption and anonymous relay-based delivery.',
    url: 'https://nostra.chat/',
    origin: 'https://nostra.chat/'
  }
});

const USE_SSL = false;
const USE_SIGNED_CERTS = USE_SSL && true;
const USE_SELF_SIGNED_CERTS = USE_SSL && false;

// * mkdir certs; cd certs
// * mkcert web.telegram.org
// * chmod 644 web.telegram.org-key.pem
// * nano /etc/hosts
// * 127.0.0.1 web.telegram.org
const host = USE_SSL ? 'web.telegram.org' : 'localhost';
const serverOptions: ServerOptions = {
  host,
  port: USE_SSL ? 443 : 8080,
  sourcemapIgnoreList(sourcePath, sourcemapPath) {
    return sourcePath.includes('node_modules') ||
      sourcePath.includes('logger') ||
      sourcePath.includes('eventListenerBase');
  },
  https: USE_SIGNED_CERTS ? {
    key: path.join(certsDir, host + '-key.pem'),
    cert: path.join(certsDir, host + '.pem')
  } : undefined
};

const SOLID_SRC_PATH = 'src/solid/packages/solid';
const SOLID_BUILT_PATH = 'src/vendor/solid';
const USE_SOLID_SRC = false;
const SOLID_PATH = USE_SOLID_SRC ? SOLID_SRC_PATH : SOLID_BUILT_PATH;
const USE_OWN_SOLID = existsSync(resolve(rootDir, SOLID_PATH));

const NO_MINIFY = false;
const BASIC_SSL_CONFIG: Parameters<typeof basicSsl>[0] = USE_SELF_SIGNED_CERTS ? {
  name: host,
  certDir: certsDir
} : undefined;

const ADDITIONAL_ALIASES = {
  'solid-transition-group': resolve(rootDir, 'src/vendor/solid-transition-group'),
  '@components': resolve(rootDir, 'src/components'),
  '@helpers': resolve(rootDir, 'src/helpers'),
  '@hooks': resolve(rootDir, 'src/hooks'),
  '@stores': resolve(rootDir, 'src/stores'),
  '@lib': resolve(rootDir, 'src/lib'),
  '@appManagers': resolve(rootDir, 'src/lib/appManagers'),
  '@richTextProcessor': resolve(rootDir, 'src/lib/richTextProcessor'),
  '@environment': resolve(rootDir, 'src/environment'),
  '@customEmoji': resolve(rootDir, 'src/lib/customEmoji'),
  '@rlottie': resolve(rootDir, 'src/lib/rlottie'),
  '@config': resolve(rootDir, 'src/config'),
  '@vendor': resolve(rootDir, 'src/vendor'),
  '@layer': resolve(rootDir, 'src/layer'),
  '@types': resolve(rootDir, 'src/types'),
  '@': resolve(rootDir, 'src'),
  // Privacy WASM module paths (mirrors public/ directory for WASM bundles)
  '/tor-wasm': resolve(rootDir, 'public/tor-wasm'),
  '/webtor': resolve(rootDir, 'public/webtor')
};

if(USE_OWN_SOLID) {
  console.log('using own solid', SOLID_PATH, 'built', !USE_SOLID_SRC);
} else {
  console.log('using original solid');
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_VERSION': JSON.stringify(pkgVersion),
    'import.meta.env.VITE_VERSION_FULL': JSON.stringify(pkgVersion),
    '__BUILD_VERSION__': JSON.stringify(pkgVersion)
  },
  plugins: [
    // devtools({
    //   /* features options - all disabled by default */
    //   autoname: true // e.g. enable autoname
    // }),
    process.env.VITEST ? undefined : checker({
      typescript: true,
      eslint: {
        // for example, lint .ts and .tsx
        lintCommand: 'eslint "./src/**/*.{ts,tsx}" --ignore-pattern "/src/solid/*" --ignore-pattern "src/tests/**"',
        useFlatConfig: true
      }
    }),
    solidPlugin(),
    handlebarsPlugin as any,
    USE_SELF_SIGNED_CERTS ? basicSsl(BASIC_SSL_CONFIG) : undefined,
    process.env.ANALYZE ? visualizer({
      gzipSize: true,
      template: 'treemap'
    }) : undefined
  ].filter(Boolean),
  test: {
    // include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      '**/solid/**',
      '**/src/tests/nostra/e2e-chat.test.ts',
      '**/src/tests/nostra/e2e-fallback.test.ts',
      '**/src/tests/nostra/e2e-onboarding-integration.test.ts',
      '**/src/tests/nostra/e2e-tor-messaging.test.ts',
      '**/src/tests/nostra/e2e-tor-wasm.test.ts',
      '**/src/tests/nostra/e2e-ui-flow.test.ts',
      '**/src/tests/nostra/e2e-kind0-profile.test.ts',
      '**/src/tests/nostra/i2p.test.ts',
      '**/.gsd/**',
      '**/.worktrees/**',
      '**/.claude/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.d.ts', 'src/vendor/**']
    },
    environment: 'jsdom',
    testTransformMode: {web: ['.[jt]sx?$']},
    // otherwise, solid would be loaded twice:
    // deps: {registerNodeLoader: true},
    // if you have few tests, try commenting one
    // or both out to improve performance:
    threads: false,
    isolate: false,
    globals: true,
    setupFiles: ['./src/tests/setup.ts']
  },
  server: serverOptions,
  base: '',
  optimizeDeps: {
    entries: ['index.html']
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    assetsDir: '',
    copyPublicDir: true,
    emptyOutDir: true,
    minify: NO_MINIFY ? false : undefined,
    rollupOptions: {
      output: {
        sourcemapIgnoreList: serverOptions.sourcemapIgnoreList
      }
      // input: {
      //   main: './index.html',
      //   sw: './src/index.service.ts'
      // }
    }
    // cssCodeSplit: true
  },
  worker: {
    format: 'es',
    plugins: () => [solidPlugin()]
  },
  css: {
    devSourcemap: true,
    postcss: {
      plugins: [
        autoprefixer({}) // add options if needed
      ]
    }
  },
  resolve: {
    // conditions: ['development', 'browser'],
    alias: USE_OWN_SOLID ? {
      'rxcore': resolve(rootDir, SOLID_PATH, 'web/core'),
      'solid-js/jsx-runtime': resolve(rootDir, SOLID_PATH, 'jsx'),
      'solid-js/web': resolve(rootDir, SOLID_PATH, 'web'),
      'solid-js/store': resolve(rootDir, SOLID_PATH, 'store'),
      'solid-js': resolve(rootDir, SOLID_PATH),
      ...ADDITIONAL_ALIASES
    } : ADDITIONAL_ALIASES
  }
});
