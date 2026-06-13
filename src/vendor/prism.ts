// Slim Prism build: only a curated set of common languages ship with the
// initial prism chunk. Languages not present here fall through the
// `No prism language` branch in `codeLanguages.ts` (the message is still
// rendered, just without syntax highlighting). Gzipped chunk size dropped
// from ~195 KB to ~30–40 KB after this trim.
//
// When a language is added here it must exist under `prismjs/components/`
// with a matching alias in `CodeLanguageMap` in `src/codeLanguages.ts`.
import Prism from 'prismjs';

// Core + commonly-nested grammars (markup-templating is required by several
// web-oriented languages like php/handlebars/django/etc.).
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-regex';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-markup-templating';

// Frontend / web
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-json5';
import 'prismjs/components/prism-jsonp';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-less';
import 'prismjs/components/prism-graphql';

// Shell / config / data
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-shell-session';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-properties';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-git';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-batch';

// Popular backend / systems languages
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-scala';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-objectivec';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-perl';
import 'prismjs/components/prism-r';
import 'prismjs/components/prism-julia';
import 'prismjs/components/prism-haskell';
import 'prismjs/components/prism-elixir';
import 'prismjs/components/prism-erlang';
import 'prismjs/components/prism-clojure';
import 'prismjs/components/prism-fsharp';

// Databases / query languages
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-plsql';

// Markup / docs
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-latex';
import 'prismjs/components/prism-http';
import 'prismjs/components/prism-uri';
import 'prismjs/components/prism-log';

// Web frameworks that piggyback on markup-templating
import 'prismjs/components/prism-handlebars';
import 'prismjs/components/prism-twig';
import 'prismjs/components/prism-pug';

// Solidity is common enough in a crypto/P2P app context
import 'prismjs/components/prism-solidity';

export default Prism;
