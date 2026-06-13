# Changelog

## [0.25.3](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.25.2...v0.25.3) (2026-05-31)


### Bug Fixes

* **chat:** clear empty-chat placeholder once the first message renders ([b98c477](https://github.com/phantomchat-chat/phantomchat-chat/commit/b98c477b5a0a31aa11edfdce94fea6d45fe0ce09))
* **groups:** propagate reactions to all members via group control channel ([148cba4](https://github.com/phantomchat-chat/phantomchat-chat/commit/148cba4c96467339eac799bae67e76ec376ae51d))
* **p2p:** carry DM image/file caption through to the receiver ([58af21d](https://github.com/phantomchat-chat/phantomchat-chat/commit/58af21de76b181fcc44ecc9db3fbe385dfcc8a44))
* **p2p:** update displayName on contact rebrand; guard reaction re-render listener ([d91b7b8](https://github.com/phantomchat-chat/phantomchat-chat/commit/d91b7b8075efa69b3d0c9bb9632046cb33dcd059))
* **relay:** cold-start subscription readiness barrier (WU-3) ([ac96414](https://github.com/phantomchat-chat/phantomchat-chat/commit/ac964145290f0f2e480f60b0da37ea108e0f1cc6))
* **vmt:** honest fallback — notify persistence, group rename, hide false forward-restriction toggle ([e3c1e89](https://github.com/phantomchat-chat/phantomchat-chat/commit/e3c1e8945fb720aaef697a5a91d8f565edf2eb5b))
* **workers:** descriptive error when a manager method is missing (guarded dispatch) ([b971273](https://github.com/phantomchat-chat/phantomchat-chat/commit/b97127344ee68e50be0f417920c557d0acb8962a))

## [0.25.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.25.1...v0.25.2) (2026-05-23)


### Bug Fixes

* **groups:** production-readiness — edit/reply/reactions/rollback/attribution ([#115](https://github.com/phantomchat-chat/phantomchat-chat/issues/115)) ([89d602a](https://github.com/phantomchat-chat/phantomchat-chat/commit/89d602a17fc03614469d2f8997400459392abfa4))

## [0.25.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.25.0...v0.25.1) (2026-05-22)


### Bug Fixes

* **explorer:** load gitignored console allowlist optionally so tsc passes on clean checkouts ([#113](https://github.com/phantomchat-chat/phantomchat-chat/issues/113)) ([19106f8](https://github.com/phantomchat-chat/phantomchat-chat/commit/19106f84feb3335ba183f6fe30f3374a32401764))

## [0.25.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.24.1...v0.25.0) (2026-05-22)


### Features

* **explorer:** add bilateral_message_propagation expectation type ([126a540](https://github.com/phantomchat-chat/phantomchat-chat/commit/126a54049ba93dacfed7049e411dc11f3ffe16bc))
* **explorer:** F1 skeleton — agentic explorer for phantomchat.chat ([f63c098](https://github.com/phantomchat-chat/phantomchat-chat/commit/f63c0982fab81f4af9d693576022d6f5391ff18e))
* **explorer:** F2 — foundation, catalog expansion, autonomous loop ([e527512](https://github.com/phantomchat-chat/phantomchat-chat/commit/e527512785dea970a694fc511cf3ec981b32de28))
* **explorer:** F2c.1 — driver IPC for verify_expectation + run_invariant ([c94bcda](https://github.com/phantomchat-chat/phantomchat-chat/commit/c94bcdac1f0b484e333dd13002fb759564a2963a))
* **explorer:** F3a foundation — status helpers + regex tripwire + classification schema ([4da2d6f](https://github.com/phantomchat-chat/phantomchat-chat/commit/4da2d6f2f6a6cfe16af7159c51c7ca0d4fccfcf4))
* **explorer:** F3b fixer agent + slash command wiring ([d887f6f](https://github.com/phantomchat-chat/phantomchat-chat/commit/d887f6f17f4f1682a391d4db162666aca7521efc))
* **explorer:** F3c cleanup script + package.json explorer scripts ([8cc9e32](https://github.com/phantomchat-chat/phantomchat-chat/commit/8cc9e326bd84a108caef4be8efc4a1e4086c00f2))
* **privacy:** persist account.setPrivacy/getPrivacy through localStorage ([d0e65cf](https://github.com/phantomchat-chat/phantomchat-chat/commit/d0e65cf325040c74a7027f6f211cf78d51c0d445))


### Bug Fixes

* **api:** guard processResult against undefined _ discriminator ([add57d1](https://github.com/phantomchat-chat/phantomchat-chat/commit/add57d13347865a58d37db1fad7d039b7ea1fb06))
* **chat:** hide Pin/Unpin context-menu items in PhantomChat builds ([66350b0](https://github.com/phantomchat-chat/phantomchat-chat/commit/66350b0563055449d9d1323847de818aec47afcb))
* **env:** guard navigator access in userAgent.ts ([1b1e5e7](https://github.com/phantomchat-chat/phantomchat-chat/commit/1b1e5e76ae0d93da425b8675496e9cbe35dd3551))
* **explorer:** F3d — mark-status CLI replaces tsx-eval calls in fixer prompt ([1438228](https://github.com/phantomchat-chat/phantomchat-chat/commit/14382287a6df99ab5a3a459bfd4733436ad98391))
* **explorer:** guard appWebPagesManager.saveWebPage against undefined webpage ([08f0c0a](https://github.com/phantomchat-chat/phantomchat-chat/commit/08f0c0a7165c693df14c631059b2f1953629ec93))
* **explorer:** replay skips unknown observation-only intents instead of aborting ([48aa784](https://github.com/phantomchat-chat/phantomchat-chat/commit/48aa7844c0acc0dce16025903e0cec46dede0018))
* **explorer:** selector-resolver handles raw CSS hints + leading-dot ([1ff8767](https://github.com/phantomchat-chat/phantomchat-chat/commit/1ff876770da8bb94c98107b22620d7534acce8b9))
* **explorer:** tighten intent selectors to avoid hidden DOM template matches ([1af6b22](https://github.com/phantomchat-chat/phantomchat-chat/commit/1af6b22b37a1b290c2ba6b98aa890c6dd03c5ef8))
* **fuzz:** dismiss FirstInstallInfo popup + force-click onboarding buttons ([2101bbd](https://github.com/phantomchat-chat/phantomchat-chat/commit/2101bbd8df7b8c8e6a55c7ba33e1a47cdcbf5a36))
* **fuzz:** make setPeer-per-action idempotent in messaging harness ([8155137](https://github.com/phantomchat-chat/phantomchat-chat/commit/81551378a9e0677a7650f3cb584d54872c162291))
* **i18n:** fall back to other_value for static plural keys without args ([e7dce00](https://github.com/phantomchat-chat/phantomchat-chat/commit/e7dce00629cc4694f65e2c00ef89743ca9ab8314))
* **media:** preserve album grouped_id on multi-image P2P send ([#112](https://github.com/phantomchat-chat/phantomchat-chat/issues/112)) ([5ae1819](https://github.com/phantomchat-chat/phantomchat-chat/commit/5ae1819222a9131c910f5242c3c1984e36bb1a13))
* **p2p:** give VirtualMTProto a monotonic pts so deleteMessages clears the bubble ([dc00df2](https://github.com/phantomchat-chat/phantomchat-chat/commit/dc00df25a109fa6037efe3d129ecac9a304abc60))
* **p2p:** null-safe sponsoredMessage read for negative-mid bubbles ([9fcde0f](https://github.com/phantomchat-chat/phantomchat-chat/commit/9fcde0f09655b7e1d4f46b732ccf0d948bf00c87))
* **p2p:** seed VMT pts from persisted state to survive reload ([b1b3c44](https://github.com/phantomchat-chat/phantomchat-chat/commit/b1b3c44707fd1217eb8caa477ee409ec7995d8ae))
* **p2p:** show 'sent' bubble state so spinner clears even without delivery receipt ([ab7cd81](https://github.com/phantomchat-chat/phantomchat-chat/commit/ab7cd819cfbdc52ad90ea68fa7bab8efb791476c))
* **p2p:** wire delete-for-everyone through Virtual MTProto Server ([529f1c5](https://github.com/phantomchat-chat/phantomchat-chat/commit/529f1c5bfc0be729435b7df6df839bd1b69bf9ab))
* **p2p:** wire reply quote through Virtual MTProto Server ([398db7b](https://github.com/phantomchat-chat/phantomchat-chat/commit/398db7be52f766c7c4c3ea81edd50e46c7241ac8))
* **popups:** restore caret to chat input on popup-new-media close ([43ccd2d](https://github.com/phantomchat-chat/phantomchat-chat/commit/43ccd2dddac15ba217208bf3f3e6a8d109607f52))
* **profile:** cap bio at 255 chars (drop unused getLimit lookup) ([a1246d3](https://github.com/phantomchat-chat/phantomchat-chat/commit/a1246d39b3f41fa7f8abefc7b490909917102311))
* **profile:** refresh chatlist + topbar when peer profile cache updates ([7401e49](https://github.com/phantomchat-chat/phantomchat-chat/commit/7401e49310db9967aa153a41b8eee24a4950b923))
* **search:** show empty placeholder when chats-tab search has zero results ([922190c](https://github.com/phantomchat-chat/phantomchat-chat/commit/922190c0e7b7846bbf2f7cc542338737d675394c))
* **settings:** clear stale profile-name on save with empty display_name ([69ab85f](https://github.com/phantomchat-chat/phantomchat-chat/commit/69ab85f1712018b09fd35788669c7117a1e60366))
* **sidebar:** defer hamburger Settings tab open past menu popstate ([e54c3ad](https://github.com/phantomchat-chat/phantomchat-chat/commit/e54c3ada9ee76373a27ec54f735e3be4c818229e))

## [0.24.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.24.0...v0.24.1) (2026-04-28)


### Bug Fixes

* **phantomchat:** runtime errors — leaveChat crash, WebSocket send race, push CORS docs ([#108](https://github.com/phantomchat-chat/phantomchat-chat/issues/108)) ([f951694](https://github.com/phantomchat-chat/phantomchat-chat/commit/f951694b8c11cf040a6cecf351cee9cce243889e))
* **phantomchat:** wipe message-store on chat deletion so messages don't resurface ([033e8a8](https://github.com/phantomchat-chat/phantomchat-chat/commit/033e8a8064a33ed8f643398b3f82139adbc347f4))

## [0.24.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.23.3...v0.24.0) (2026-04-28)


### Features

* **boot:** add progress bar to boot splash ([e911631](https://github.com/phantomchat-chat/phantomchat-chat/commit/e9116316de462de08fba4c61b34306e326fd20df))
* **update:** show live progress bar in update consent popup ([5a12308](https://github.com/phantomchat-chat/phantomchat-chat/commit/5a1230850648b87384e0c38ac8cadb6048e82a29))

## [0.23.3](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.23.2...v0.23.3) (2026-04-28)


### Bug Fixes

* **phantomchat:** re-sort chat list to top when receiving a P2P message ([#105](https://github.com/phantomchat-chat/phantomchat-chat/issues/105)) ([1254190](https://github.com/phantomchat-chat/phantomchat-chat/commit/12541908b3cd2aec373ae2da598db536e30b13b4))

## [0.23.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.23.0...v0.23.1) (2026-04-27)


### Bug Fixes

* **update:** preserve Content-Type when caching chunks during signed-update ([#101](https://github.com/phantomchat-chat/phantomchat-chat/issues/101)) ([13492b1](https://github.com/phantomchat-chat/phantomchat-chat/commit/13492b1ee9eb03405753615a4b8f9778e3783cbe))

## [0.23.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.22.0...v0.23.0) (2026-04-27)


### Features

* **push:** background notifications via self-hosted nostr-webpush-relay ([#99](https://github.com/phantomchat-chat/phantomchat-chat/issues/99)) ([e1a58ec](https://github.com/phantomchat-chat/phantomchat-chat/commit/e1a58ecda7f5cd2a16142ea84e3dff09925828cd))

## [0.22.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.21.2...v0.22.0) (2026-04-26)


### Features

* **update:** surface failing chunk + reason in UI and console ([f50e093](https://github.com/phantomchat-chat/phantomchat-chat/commit/f50e0937affe254878c687392ccb9061153c0ecf))


### Bug Fixes

* **update:** exclude regenerated Tor consensus from bundleHashes ([34bf44c](https://github.com/phantomchat-chat/phantomchat-chat/commit/34bf44c563b99a4226d359b7300261136679de22))

## [0.21.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.21.1...v0.21.2) (2026-04-25)


### Bug Fixes

* **phantomchat:** wire incoming P2P/group messages to desktop notifications ([d0944a7](https://github.com/phantomchat-chat/phantomchat-chat/commit/d0944a72c89ea285561a0653dd25a8d789f87cc6))

## [0.21.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.21.0...v0.21.1) (2026-04-25)


### Bug Fixes

* **unread:** clear chat-list badge on peer_changed post-reload + groups ([04f100b](https://github.com/phantomchat-chat/phantomchat-chat/commit/04f100b56a4fb26392b97fcd55804c7da4ce7f58))

## [0.21.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.20.2...v0.21.0) (2026-04-25)


### Features

* **phantomchat:** Fluent Emoji static fallback for stickerless animated emoji ([5f1aa6f](https://github.com/phantomchat-chat/phantomchat-chat/commit/5f1aa6f09fcc77048fc1e190b8ac9600c2045418))
* **phantomchat:** PhantomChat Emoji synthetic sticker pack (Fluent) in picker ([1a03f62](https://github.com/phantomchat-chat/phantomchat-chat/commit/1a03f620bbbc07348710965ee67215eea5fa1cb6))


### Bug Fixes

* **phantomchat:** attribute outgoing group messages to own user, not group peer ([499a1da](https://github.com/phantomchat-chat/phantomchat-chat/commit/499a1da34a9426167feea4757375f39c21cca911))
* **phantomchat:** parse entities in createTwebMessage so first render hits big-emoji path ([54d455d](https://github.com/phantomchat-chat/phantomchat-chat/commit/54d455dd147ff1664339d95746785fa51ce32e79))
* **phantomchat:** preserve outgoing attribution for own group messages across reload ([5127104](https://github.com/phantomchat-chat/phantomchat-chat/commit/5127104bdf4791add21a531cf068e23d5ce23db4))
* **phantomchat:** reactions strfry e-tag size rejection (regression of FIND-4e18d35d) ([3814fe6](https://github.com/phantomchat-chat/phantomchat-chat/commit/3814fe606d0e1371e8f78162053525164ab95c6a))
* **phantomchat:** rename leftover eventId reference in sendMessage return ([81e0def](https://github.com/phantomchat-chat/phantomchat-chat/commit/81e0defbee4b83a970a738d3e38b6775ab73e054))
* **phantomchat:** render PhantomChat Emoji sticker click as Fluent PNG bubble ([edf6397](https://github.com/phantomchat-chat/phantomchat-chat/commit/edf6397783c4f1dd9ba9464451a1934fbf322d84))
* **phantomchat:** show chat input in P2P groups by adding default_banned_rights ([2fc2068](https://github.com/phantomchat-chat/phantomchat-chat/commit/2fc20688ed1dbe3e029a7212b2f0c49691c6c12c))
* **phantomchat:** show sender name in groups via shared User injection helper ([fca4cc1](https://github.com/phantomchat-chat/phantomchat-chat/commit/fca4cc13553a889c4b6eef1e2984bf6eeebb6788))

## [0.20.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.20.1...v0.20.2) (2026-04-24)


### Bug Fixes

* **phantomchat:** saveMessage crash storm + group/channel create + Interface Settings ([796df94](https://github.com/phantomchat-chat/phantomchat-chat/commit/796df94ae411777a1690c5473fd5c5672a368e0e))

## [0.20.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.20.0...v0.20.1) (2026-04-24)


### Bug Fixes

* **phantomchat:** three boot-time TypeError clusters ([35d7b04](https://github.com/phantomchat-chat/phantomchat-chat/commit/35d7b0448c9fcd8004a8df97a129df140a215fd9))
* **update:** prevent Accept hang + show Install Now when snoozed + i18n popup ([9e06932](https://github.com/phantomchat-chat/phantomchat-chat/commit/9e0693214bf1239435ae4360b3671380aab327e8))

## [0.20.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.19.3...v0.20.0) (2026-04-24)


### Features

* **settings:** default to 24h time format ([a121e12](https://github.com/phantomchat-chat/phantomchat-chat/commit/a121e1256850018b05b5e14f7eb4bf84ff5327f7))


### Bug Fixes

* **groups:** render group dialog on creation + route sends via GroupAPI ([fadd6ea](https://github.com/phantomchat-chat/phantomchat-chat/commit/fadd6ea3578cd69a8b914e2aa5a4e9ad598ae60e))
* **p2p:** bump sidebar dialog on outgoing VMT send ([a92b9b7](https://github.com/phantomchat-chat/phantomchat-chat/commit/a92b9b74744c111961223b140148037aa3d79a82))
* **p2p:** phase 2b.5 — mirror cleanup on P2P send + group orphan-peer cleanup ([#91](https://github.com/phantomchat-chat/phantomchat-chat/issues/91)) ([4249d1f](https://github.com/phantomchat-chat/phantomchat-chat/commit/4249d1f94e162f9abe11cb92e87d70242aa668eb))

## [0.19.3](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.19.2...v0.19.3) (2026-04-24)


### Bug Fixes

* **settings:** render Tor mode labels via i18n ([ea1bbbe](https://github.com/phantomchat-chat/phantomchat-chat/commit/ea1bbbed93a1f2b9e8ef8528bb8d720cac0e0e2a))
* **update:** propagate manifestText from popup to SW for signature verification ([eef8eba](https://github.com/phantomchat-chat/phantomchat-chat/commit/eef8ebaaaccafdb3dcb639e6fcab9f6ac4be7f20))

## [0.19.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.19.1...v0.19.2) (2026-04-24)


### Bug Fixes

* **groups:** end-to-end render pipeline + admin auto-transfer ([#87](https://github.com/phantomchat-chat/phantomchat-chat/issues/87)) ([c2ba660](https://github.com/phantomchat-chat/phantomchat-chat/commit/c2ba66037a84a88a7eea21a80be0f1b61299eb80))

## [0.19.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.19.0...v0.19.1) (2026-04-23)


### Bug Fixes

* **i18n:** bump langPackLocalVersion to 10 for Tor.Mode.* keys ([1afb51f](https://github.com/phantomchat-chat/phantomchat-chat/commit/1afb51f6faee2935786854545ebd3bbfa530f0fd))

## [0.19.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.18.2...v0.19.0) (2026-04-23)


### Features

* **lang:** add Tor.Mode.* keys for three-mode Tor setting UI ([089eb3a](https://github.com/phantomchat-chat/phantomchat-chat/commit/089eb3adfa30e3ae079f3097fe6bb26b3a4fa908))
* **tor:** add TorBootstrapLoop helper with ladder + steady-state schedule ([97271a4](https://github.com/phantomchat-chat/phantomchat-chat/commit/97271a46bbc9b40e0008078464762f9e76934cce))
* **tor:** add TorMode/RuntimeState types and readMode migration shim ([83065ed](https://github.com/phantomchat-chat/phantomchat-chat/commit/83065ed902d1eba03b4facd4edff986870b45164))
* **tor:** dispatch PrivacyTransport bootstrap on TorMode, introduce retry loop ([18a36a4](https://github.com/phantomchat-chat/phantomchat-chat/commit/18a36a441cd8fa41772d5b59ab0c7c133ecdcb22))
* **tor:** hot-swap upgrade/downgrade with liveness probe in when-available mode ([06a21d8](https://github.com/phantomchat-chat/phantomchat-chat/commit/06a21d812352eb41e074f3a6a8283cdde9908e05))
* **tor:** replace on/off toggle with three-mode radio in Privacy settings ([d19df33](https://github.com/phantomchat-chat/phantomchat-chat/commit/d19df334dfe1b2d5a8b86a583f51d4756e8a9b63))
* **tor:** strip banner buttons, delete skip popup + in-chat banner, rewire bridge ([6452339](https://github.com/phantomchat-chat/phantomchat-chat/commit/64523396e919ee78b5fded250c7a148769e2d064))


### Bug Fixes

* **profile:** cache partner kind 0 on contact-add so User Info renders ([67f93c8](https://github.com/phantomchat-chat/phantomchat-chat/commit/67f93c873f46dabecdea505e4b98126018027584))
* **tor:** align torShield, fetch return type, and test mocks with RuntimeState ([c1b2651](https://github.com/phantomchat-chat/phantomchat-chat/commit/c1b2651f83b27fd306da2d0021c2c0aa94527a0a))
* **update:** restore real production signing pubkey ([7cb68fe](https://github.com/phantomchat-chat/phantomchat-chat/commit/7cb68fea3012c553d2871a74bef065ec807d4547))

## [0.18.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.18.1...v0.18.2) (2026-04-23)


### Bug Fixes

* **update:** dispatch update events via dispatchEventSingle on main thread ([dbe74b5](https://github.com/phantomchat-chat/phantomchat-chat/commit/dbe74b5d94073eab9ba2c4e85b34dee2c5091813))

## [0.18.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.18.0...v0.18.1) (2026-04-23)


### Bug Fixes

* **sw:** strip `redirected` flag from cached Responses ([90368d1](https://github.com/phantomchat-chat/phantomchat-chat/commit/90368d15291630ee219d057bc6920efe1a8e7600))

## [0.18.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.17.0...v0.18.0) (2026-04-22)


### Features

* **settings:** replace Reset baseline + dev Force reload with unified "Reinstall app" ([#82](https://github.com/phantomchat-chat/phantomchat-chat/issues/82)) ([3d7e5dd](https://github.com/phantomchat-chat/phantomchat-chat/commit/3d7e5dd9ee86e8041bc280ad7223f6ad656396f9))


### Bug Fixes

* **vmt:** add static stubs for attach-menu-bots, stars-status, promo-data ([#80](https://github.com/phantomchat-chat/phantomchat-chat/issues/80)) ([4bd7727](https://github.com/phantomchat-chat/phantomchat-chat/commit/4bd772791e591e2b9769874423b71208e7ef7a50))

## [0.17.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.16.0...v0.17.0) (2026-04-22)


### Features

* **dev:** skip Service Worker in dev + Force reload (dev) button in App Updates ([#78](https://github.com/phantomchat-chat/phantomchat-chat/issues/78)) ([542437b](https://github.com/phantomchat-chat/phantomchat-chat/commit/542437b469add34aab4b54abff64702dbf185e19))


### Bug Fixes

* **settings:** show per-source gitSha and auto-expand Diagnostics on bad verdict ([#77](https://github.com/phantomchat-chat/phantomchat-chat/issues/77)) ([ab62802](https://github.com/phantomchat-chat/phantomchat-chat/commit/ab62802cde811e5f045a1b3174cf9808b27cdb18))
* **sw:** exclude Cloudflare Pages _headers/_redirects from bundle manifest ([#79](https://github.com/phantomchat-chat/phantomchat-chat/issues/79)) ([356e7b0](https://github.com/phantomchat-chat/phantomchat-chat/commit/356e7b06ed937d2306d3645f8cae575151fdbd5f))
* **update:** accept schemaVersion 2 + split offline/error verdicts + simplify App Updates tab ([#75](https://github.com/phantomchat-chat/phantomchat-chat/issues/75)) ([0615c1d](https://github.com/phantomchat-chat/phantomchat-chat/commit/0615c1d847760ae72e9c56e1f6817f809147372a))

## [0.16.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.15.0...v0.16.0) (2026-04-22)


### Features

* **onboarding:** redesign Import Seed Phrase screen with 2x6 grid ([168a0d4](https://github.com/phantomchat-chat/phantomchat-chat/commit/168a0d4e3511264fe3333059a39630ac7bbee1c7))
* **settings:** polish App Updates — signature panel, sources list, updated copy ([#73](https://github.com/phantomchat-chat/phantomchat-chat/issues/73)) ([98238cf](https://github.com/phantomchat-chat/phantomchat-chat/commit/98238cf6af48336b3d1aa4a7f9a321106ad3a6de))
* **settings:** surface install-now + snooze controls in App Updates tab ([#71](https://github.com/phantomchat-chat/phantomchat-chat/issues/71)) ([431b59e](https://github.com/phantomchat-chat/phantomchat-chat/commit/431b59e67c597805f4c81247a633e4f5422b3cfb))


### Bug Fixes

* **onboarding:** give seed-phrase fields a visible border and filled state ([f5047ff](https://github.com/phantomchat-chat/phantomchat-chat/commit/f5047ffa069a50edcf40f3a800b58a1968c077ce))
* **sw:** fail-fast precache install + reinstall overlay on cache miss ([fa11cc0](https://github.com/phantomchat-chat/phantomchat-chat/commit/fa11cc0d5af385775e4f94a5f3b11329bb5b461a))
* **sw:** suppress false cache-miss overlay for browser auto-requests ([de7d25b](https://github.com/phantomchat-chat/phantomchat-chat/commit/de7d25b98c4f6be7a917a584bd5c39847fafd2dd))

## [0.15.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.14.1...v0.15.0) (2026-04-22)


### Features

* **onboarding:** polish welcome + display-name to match splash ([bdc9106](https://github.com/phantomchat-chat/phantomchat-chat/commit/bdc910660e0d606600a02fe8a78d0580defe9611))
* **popup:** redesign first-install info — English + polished ([7a6685f](https://github.com/phantomchat-chat/phantomchat-chat/commit/7a6685f6af10adda5b17fca480d36c5821cc06d5))


### Bug Fixes

* **sw:** normalize manifest path before emoji-skip regex ([3e8c3ee](https://github.com/phantomchat-chat/phantomchat-chat/commit/3e8c3eef867678661dce68c8ee9f0f0c9358aa35))

## [0.14.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.14.0...v0.14.1) (2026-04-22)


### Bug Fixes

* **boot:** reveal splash via explicit hook, drop faulty DOM observer ([d28eff0](https://github.com/phantomchat-chat/phantomchat-chat/commit/d28eff0830395f872ee65b916dea59f5acaf2a30))


### Performance

* **sw:** skip emoji PNGs from install precache ([6fe4bd6](https://github.com/phantomchat-chat/phantomchat-chat/commit/6fe4bd6845281fb3acce853bd5ed9e0047fde1cd))

## [0.14.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.13.0...v0.14.0) (2026-04-22)


### Features

* **boot:** polish splash with logo + product description ([f34df2e](https://github.com/phantomchat-chat/phantomchat-chat/commit/f34df2ed99b364151348d2c37263d4a63e313aee))


### Bug Fixes

* **boot:** static splash during SW install first-run ([6afe81f](https://github.com/phantomchat-chat/phantomchat-chat/commit/6afe81f06b4c2395a762d7830de46ea143eb2d32))
* **dialogs:** use local count for People/Groups system folders ([a3033e2](https://github.com/phantomchat-chat/phantomchat-chat/commit/a3033e24d9f6fde3e418bad9c6b16349ba4f059c))
* **groups:** seed synthetic chatCreate service row to satisfy tweb top_message ([bf761be](https://github.com/phantomchat-chat/phantomchat-chat/commit/bf761be3875993af3e2cada89f6cf17cb205cd61))

## [0.13.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.12.1...v0.13.0) (2026-04-22)


### Features

* **dialogs:** per-conversation read cursor via VMT ([5ea149f](https://github.com/phantomchat-chat/phantomchat-chat/commit/5ea149f46a6f32f5efa82c6b5d88793a3582c392))


### Bug Fixes

* **dialogs:** break reloadConversation recursion on empty transport response ([c90f26c](https://github.com/phantomchat-chat/phantomchat-chat/commit/c90f26c5b186602c80536c10ee1f9933fa2e1be5))
* **folders:** populate People and Groups system folders ([c3da0bc](https://github.com/phantomchat-chat/phantomchat-chat/commit/c3da0bcc2e4dce5527339d0d7d2658ef77287a00))
* **update:** auto-show consent popup on boot + repair dev-trigger ([a5a24a0](https://github.com/phantomchat-chat/phantomchat-chat/commit/a5a24a06d50cef69879cb940b383e7b1c331e3ef))
* **update:** first-install info banner → modal popup ([c769767](https://github.com/phantomchat-chat/phantomchat-chat/commit/c76976726072a7b9b6df02ddb4f98d2dfb08ae87))
* **update:** guard UpdateConsent against missing rotation field + E2E ([3a918da](https://github.com/phantomchat-chat/phantomchat-chat/commit/3a918da2dcd589a9cf1ace9bbdcd25b88424d585))

## [0.12.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.12.0...v0.12.1) (2026-04-22)


### Bug Fixes

* **sw:** tolerant install precache (skip individual fetch failures) ([71ece8b](https://github.com/phantomchat-chat/phantomchat-chat/commit/71ece8b5774de1d3aacb182b55907acd7597eaa4))

## [0.12.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.11.2...v0.12.0) (2026-04-22)


### Features

* **update:** consent-gated update system with Ed25519 signing ([0891caa](https://github.com/phantomchat-chat/phantomchat-chat/commit/0891caa4778bfe840ee83cfc339064466e0d1b1f))


### Bug Fixes

* **build:** force NODE_ENV=production + --mode production for correct tree-shaking ([2ed5b63](https://github.com/phantomchat-chat/phantomchat-chat/commit/2ed5b63175e43ae0b7ece0bc6949f329808ae076))
* **phantomchat:** reactions use rumor id as e-tag (closes FIND-4e18d35d) ([#63](https://github.com/phantomchat-chat/phantomchat-chat/issues/63)) ([241cd05](https://github.com/phantomchat-chat/phantomchat-chat/commit/241cd0552c781b42ba87c42cec308f44e89d5e76))
* **sw:** cache-only fetch handler must not gate on import.meta.env.PROD + static imports for SW resilience ([a212e1e](https://github.com/phantomchat-chat/phantomchat-chat/commit/a212e1e81674a52739efdc47622c97e8d75a5282))
* **sw:** cache.match uses ignoreSearch to handle asset query-string cache-busters (e.g. site.webmanifest?v=xyz) ([854a605](https://github.com/phantomchat-chat/phantomchat-chat/commit/854a6053f7002e3a9abf6371e1a70db75d7185bb))
* **sw:** install uses cache.addAll for parallel precache (4275 files in ~4s) ([60e16c2](https://github.com/phantomchat-chat/phantomchat-chat/commit/60e16c2f62a09cb88a1ae507f2db3ebfa00b2036))
* **sw:** persist active-version in IDB during install (not activate) ([fb56a9d](https://github.com/phantomchat-chat/phantomchat-chat/commit/fb56a9d9ee52aae21d5dc826854689ee0a3ed320))
* **ui:** popup inline styles + register listener in module side-effect + setActiveVersion in install ([09a3b16](https://github.com/phantomchat-chat/phantomchat-chat/commit/09a3b1631163f85f3a4c51c94962c0375a8adf55))
* **update:** full accept flow (sign verify + chunk download + atomic swap) ([19d11cb](https://github.com/phantomchat-chat/phantomchat-chat/commit/19d11cbe6cced951c07aa2d4f370de4656574cf9))

## [0.11.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.11.1...v0.11.2) (2026-04-21)


### Bug Fixes

* **phantomchat:** P2P send failure must not pollute mirror with tempId ([#61](https://github.com/phantomchat-chat/phantomchat-chat/issues/61)) ([a7f957d](https://github.com/phantomchat-chat/phantomchat-chat/commit/a7f957ddae416a050791a49c2e451fcb8c34a448))
* **phantomchat:** reactions on own messages propagate bilaterally to peer ([#59](https://github.com/phantomchat-chat/phantomchat-chat/issues/59)) ([6c7adfd](https://github.com/phantomchat-chat/phantomchat-chat/commit/6c7adfd51e0d9b03b7dddc1fb25494af29a661e1))
* **update-popup:** render English fallbacks when I18n.strings is empty ([6286723](https://github.com/phantomchat-chat/phantomchat-chat/commit/6286723fb9769bdebf05e48401bc56285a84cc51))

## [0.11.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.11.0...v0.11.1) (2026-04-21)


### Bug Fixes

* **report-bug:** align button text and vertical centering in popup ([3b929fd](https://github.com/phantomchat-chat/phantomchat-chat/commit/3b929fd62653f2ea1058130f1829cbb05eb3494b))

## [0.11.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.10.1...v0.11.0) (2026-04-21)


### Features

* **fuzz:** phase 2b.2b — reporter fix + warmup + profile + baseline v2b2 emit ([#54](https://github.com/phantomchat-chat/phantomchat-chat/issues/54)) ([d72d5fc](https://github.com/phantomchat-chat/phantomchat-chat/commit/d72d5fc7f0c6dab6560f45627499456f56c9be79))
* **update:** show latest version, full SW URLs, inline integrity details ([#57](https://github.com/phantomchat-chat/phantomchat-chat/issues/57)) ([9377990](https://github.com/phantomchat-chat/phantomchat-chat/commit/9377990cd5ac9504f07ea467a141f550adaebaf3))


### Bug Fixes

* **sidebar:** remove redundant version under npub in hamburger menu ([c58dc61](https://github.com/phantomchat-chat/phantomchat-chat/commit/c58dc61ad3268102a1d3732e90542cc447dc26de))

## [0.10.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.10.0...v0.10.1) (2026-04-21)


### Bug Fixes

* **i18n:** reload local lang pack in production when localVersion bumps ([abd8895](https://github.com/phantomchat-chat/phantomchat-chat/commit/abd889552458e1f3395e48c143a0cc24aa9883c3))

## [0.10.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.9.1...v0.10.0) (2026-04-20)


### Features

* **update:** user-driven version control improvements ([96cc7a2](https://github.com/phantomchat-chat/phantomchat-chat/commit/96cc7a2cfb4bab1a8147f083ee82136008439aed))

## [0.9.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.9.0...v0.9.1) (2026-04-20)


### Bug Fixes

* **update:** register popup listeners before updateBootstrap dispatches ([5372da1](https://github.com/phantomchat-chat/phantomchat-chat/commit/5372da124098b364ea3bb617cc254dbe4d6e5244))

## [0.9.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.8.3...v0.9.0) (2026-04-20)


### Features

* **settings:** mount App Updates tab with diagnostics, reset baseline, and inline explainer ([#49](https://github.com/phantomchat-chat/phantomchat-chat/issues/49)) ([f268022](https://github.com/phantomchat-chat/phantomchat-chat/commit/f268022cdb156b5f725530e62c414a4b67b20407))

## [0.8.3](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.8.2...v0.8.3) (2026-04-20)


### Bug Fixes

* **phantomchat:** populate getAvailableReactions stub so reactions menu renders ([#47](https://github.com/phantomchat-chat/phantomchat-chat/issues/47)) ([0a0f38a](https://github.com/phantomchat-chat/phantomchat-chat/commit/0a0f38a15989120ecc1695e91aaa45e8faafb7fb))

## [0.8.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.8.1...v0.8.2) (2026-04-20)


### Bug Fixes

* **update:** register already-installed SW URL to stop false compromise alerts on every deploy ([#45](https://github.com/phantomchat-chat/phantomchat-chat/issues/45)) ([ff6550f](https://github.com/phantomchat-chat/phantomchat-chat/commit/ff6550f6370dbb1d0e35c20ad328ea6c11337499))

## [0.8.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.8.0...v0.8.1) (2026-04-20)


### Bug Fixes

* **build:** apply solid plugin to worker bundle so TSX dynamic imports parse ([331b9ae](https://github.com/phantomchat-chat/phantomchat-chat/commit/331b9aee92aefe41e8cbe69a2f526df53b1b8275))

## [0.8.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.7.5...v0.8.0) (2026-04-20)


### Features

* **folders:** rename default folder to People, add icon picker, remove premium limit ([#40](https://github.com/phantomchat-chat/phantomchat-chat/issues/40)) ([7309b9e](https://github.com/phantomchat-chat/phantomchat-chat/commit/7309b9e1043e8708d50e7bfb139303e9dc74a671))
* **fuzz:** bug fuzzer phase 1 MVP — stateful property-based testing harness ([ef69141](https://github.com/phantomchat-chat/phantomchat-chat/commit/ef69141ddc46164f0f47707e5afba5960c8d2852))
* **fuzz:** phase 2a — stability pass (close 3 P2P blockers + medium/regression invariants + baseline) ([#41](https://github.com/phantomchat-chat/phantomchat-chat/issues/41)) ([596977e](https://github.com/phantomchat-chat/phantomchat-chat/commit/596977eb67add583711bb49610ba34520d1b3c06))
* **fuzz:** phase 2b.1 — reactions NIP-25 RX + 5 Phase-2a FINDs closed + identity triple architecture ([#42](https://github.com/phantomchat-chat/phantomchat-chat/issues/42)) ([da0f156](https://github.com/phantomchat-chat/phantomchat-chat/commit/da0f156863797c3f94268ea52183e9a17bfd46e2))
* **fuzz:** phase 2b.2a — lifecycle + 3 carry-forward FINDs closed + baseline v2b1 deferred to 2b.2b ([#43](https://github.com/phantomchat-chat/phantomchat-chat/issues/43)) ([8343763](https://github.com/phantomchat-chat/phantomchat-chat/commit/83437633134bccaf2c14a082c39cfdae5cbb224a))


### Bug Fixes

* **bubbles:** guard wrapSticker against undefined doc in empty-chat placeholder ([99301ac](https://github.com/phantomchat-chat/phantomchat-chat/commit/99301ace7f0b2778b73022baa867bcf177477760))
* **fuzz:** allowlist PEER_CHANGED_ERROR pageerror — intentional by-design cancellation ([10c7c2c](https://github.com/phantomchat-chat/phantomchat-chat/commit/10c7c2cefcd754a3f0675260fac575f407c829c2))
* **fuzz:** broaden internal-logger allowlist for ANSI-prefixed variants ([105a7c4](https://github.com/phantomchat-chat/phantomchat-chat/commit/105a7c4598c4a20f52017a7012e654227c89a4ff))
* **fuzz:** broaden Solid dev-warning allowlist to cover cleanups/effects/etc ([e749ed1](https://github.com/phantomchat-chat/phantomchat-chat/commit/e749ed12c0f82cc4eb9c3934b424d531e3a506df))
* **fuzz:** clear console ring after harness boot so startup noise isn't flagged ([3877bbc](https://github.com/phantomchat-chat/phantomchat-chat/commit/3877bbc227b0ec25267daef1ab76550ea6186892))
* **fuzz:** INV-sent-bubble-visible-after-send uses trimmed text (same as postcondition) ([633aed7](https://github.com/phantomchat-chat/phantomchat-chat/commit/633aed7816aba1b05ba85e99b775755930cec4a8))
* **fuzz:** mute INV-no-dup-mid, restore reply action ([2901536](https://github.com/phantomchat-chat/phantomchat-chat/commit/290153678437fbbe9eb828293dfe180efb732434))
* **fuzz:** mute react + delete postconditions — dominated signal, deferred to Phase 2 ([a80685b](https://github.com/phantomchat-chat/phantomchat-chat/commit/a80685b0be5edb4c053dd5cf95eed0fb0f54d146))
* **fuzz:** mute replyToRandomBubble pending dup-mid investigation ([079446f](https://github.com/phantomchat-chat/phantomchat-chat/commit/079446f629267100a02883c60924e1172d513439))
* **fuzz:** peer-changed allowlist regex — match multi-line pageerror (stack trace follows) ([d82c0b8](https://github.com/phantomchat-chat/phantomchat-chat/commit/d82c0b8561b4421c277f5938ce4bdb69fc9e6bcf))
* **fuzz:** POST_sendText_bubble_appears uses trimmed text — tweb trims whitespace on send ([0ac0c9f](https://github.com/phantomchat-chat/phantomchat-chat/commit/0ac0c9f918c3d628b972a0087fdfe8c7923418d0))
* **fuzz:** signature normalisation + broaden internal-logger allowlist ([0d739be](https://github.com/phantomchat-chat/phantomchat-chat/commit/0d739beb7aac7831a2c5753c1c20c7a3c0703210))
* **fuzz:** signature normalise — collapse emoji + decimal mid + HEX ordering ([d6dbdc9](https://github.com/phantomchat-chat/phantomchat-chat/commit/d6dbdc92b3bf8a0eb6887d1ca3d680dcb2ea1d5d))
* **reaction:** guard center_icon access when availableReaction is missing (PhantomChat stub) ([8dc2c86](https://github.com/phantomchat-chat/phantomchat-chat/commit/8dc2c86cacc06fbb074dd06ee20c00a91bfb41b1))
* **reaction:** skip around-animation when reaction + sticker + effect all missing ([ea3ea98](https://github.com/phantomchat-chat/phantomchat-chat/commit/ea3ea983426616aeb3ed851759d1b5b74dd14af8))
* **security:** verify inbound sigs, bind seal↔rumor pubkey, zero keys on logout ([954d5bc](https://github.com/phantomchat-chat/phantomchat-chat/commit/954d5bc75004c1d86e95ff793be674dfc6f0f7e9))
* **stickers:** don't throw NO_STICKERS when sticker backend is empty (PhantomChat) ([e600677](https://github.com/phantomchat-chat/phantomchat-chat/commit/e60067732b9de24481b8ebb9ac087b7e352fac58))
* **vmtproto:** static response for messages.getMessageReactionsList ([04d07ff](https://github.com/phantomchat-chat/phantomchat-chat/commit/04d07ffd322088720f00047fb31c865b1d95cc5a))
* **vmtproto:** static responses for chat-open MTProto methods + diagnostic fallback log ([fbd8b56](https://github.com/phantomchat-chat/phantomchat-chat/commit/fbd8b56b3aeae5d0536377aec2c7c05345ecdee5))


### Performance

* **build:** drop prod sourcemaps, slim prism, gate visualizer ([5f9b01f](https://github.com/phantomchat-chat/phantomchat-chat/commit/5f9b01f9932cba49baa752d9ecd8551260359bdd))

## [0.7.5](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.7.4...v0.7.5) (2026-04-17)


### Bug Fixes

* **contacts:** consolidate P2P contact add into single robust helper ([c10fc89](https://github.com/phantomchat-chat/phantomchat-chat/commit/c10fc89bf6c4f5d530a5dd6abf16a20d7680c9a2))

## [0.7.4](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.7.3...v0.7.4) (2026-04-17)


### Bug Fixes

* **boot:** skip update-bootstrap in dev; lazy-load confirmationPopup in resetLocalData ([b1c4721](https://github.com/phantomchat-chat/phantomchat-chat/commit/b1c4721c784d1c5fd13449e784bc55acb63b8483))

## [0.7.3](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.7.2...v0.7.3) (2026-04-17)


### Bug Fixes

* **update:** capture bundle SW URL in Step 0 + catch unexpected waiting SW ([06bbbe5](https://github.com/phantomchat-chat/phantomchat-chat/commit/06bbbe5497aea861763874d5d6d69bb306335297))

## [0.7.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.7.0...v0.7.1) (2026-04-16)


### Bug Fixes

* **lint:** fix eslint errors and add pre-commit hook ([e1e782a](https://github.com/phantomchat-chat/phantomchat-chat/commit/e1e782a0d29d0db599ea977f0c2e70c5536a0d61))
* **tests:** repair all phantomchat test failures and unhandled rejections ([f4b76a5](https://github.com/phantomchat-chat/phantomchat-chat/commit/f4b76a54ad4a54faa21cf4efc6e4e207411ba882))

## [0.7.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.6.0...v0.7.0) (2026-04-16)


### Features

* **relay-ui:** add card-based SCSS for relay settings restyle ([a74dee5](https://github.com/phantomchat-chat/phantomchat-chat/commit/a74dee5be579956d6b6c370c2d02635a2bcb3f70))
* **relay-ui:** restyle relay settings with card layout and pill chips ([01889f6](https://github.com/phantomchat-chat/phantomchat-chat/commit/01889f626392ecf56babc4765cdde848752ffb75))
* **tor-ui:** add phantomchat_tor_enabled_changed event and shared TorUiState helper ([84e7af6](https://github.com/phantomchat-chat/phantomchat-chat/commit/84e7af6d530da77ff464ab839f30831d91e20fcc))
* **tor-ui:** disabled state on Status tab + shortcut links to Privacy and Relays ([44fd678](https://github.com/phantomchat-chat/phantomchat-chat/commit/44fd678de242340348eb5c22c5058bb95683f136))
* **tor-ui:** show 'Disabilitato' in TorStatus popup when Tor is off ([9be8154](https://github.com/phantomchat-chat/phantomchat-chat/commit/9be81542470f3fb8129a6d431437a452fde76f0c))
* **tor-ui:** show grey disabled onion icon when Tor is off ([f051240](https://github.com/phantomchat-chat/phantomchat-chat/commit/f0512409962ca5638e25883c750f2bfc3cd52910))

## [0.6.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.5.0...v0.6.0) (2026-04-16)


### Features

* **auth:** add keepPhantomChatIdentity flag to logOut() ([b0c963d](https://github.com/phantomchat-chat/phantomchat-chat/commit/b0c963d1e2368e3aad426262919506b4f92cca6b))
* **boot:** surface Reset Local Data confirmation toast ([3c1e89c](https://github.com/phantomchat-chat/phantomchat-chat/commit/3c1e89cb4e20e64b5d234caa00861677974a8835))
* **phantomchat:** add per-peer kind 0 profile cache with SWR refresh ([bf95604](https://github.com/phantomchat-chat/phantomchat-chat/commit/bf956043897cb6b3388475ff2a5160f2737eae8b))
* **phantomchat:** add usePeerPhantomChatProfile Solid store ([703f654](https://github.com/phantomchat-chat/phantomchat-chat/commit/703f65429816435b611cbb93c7aa8dffd080197d))
* **phantomchat:** hydrate UserFull.about from peer profile cache ([b74ce5d](https://github.com/phantomchat-chat/phantomchat-chat/commit/b74ce5d96e7589f25fc1aab8da0a53a284a15e76))
* **phantomchat:** P2P media send — images, files, voice notes via AES-GCM E2EE + Blossom ([be2f720](https://github.com/phantomchat-chat/phantomchat-chat/commit/be2f720ff75aa117bb183189f4912a9731bf7e26))
* **phantomchat:** wipe peer profile cache on logout ([d7bbbc9](https://github.com/phantomchat-chat/phantomchat-chat/commit/d7bbbc956ff89bd29d2dd14e44927285fb8d5398))
* **popups:** add Reset Local Data popup ([a3f1213](https://github.com/phantomchat-chat/phantomchat-chat/commit/a3f1213440b8bfff1ff6ed13be974c332cfce4dd))
* **profile:** render peer kind 0 website/lud16/nip05 rows ([eaf09ec](https://github.com/phantomchat-chat/phantomchat-chat/commit/eaf09ec638ced8e94eef5ae12a2cc03dc69351e0))
* **settings:** add Reset Local Data menu entry above Logout ([fcf46c8](https://github.com/phantomchat-chat/phantomchat-chat/commit/fcf46c80660aab9409ff0f523b0796909b3b4fe0))

## [0.5.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.4.2...v0.5.0) (2026-04-15)


### Features

* **bugs:** in-app bug reporter with public & private paths ([9e5318f](https://github.com/phantomchat-chat/phantomchat-chat/commit/9e5318f7476f77aeb0cc1f4709562041cd51984d))


### Bug Fixes

* **phantomchat:** upgrade chat-list peer title with kind 0 display name ([c58c5c3](https://github.com/phantomchat-chat/phantomchat-chat/commit/c58c5c3a78290fdffb73a5450f8f885da2bfe0e2))

## [0.4.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.4.1...v0.4.2) (2026-04-15)


### Bug Fixes

* **phantomchat:** dedup relay replays against persistent store ([d9c8c45](https://github.com/phantomchat-chat/phantomchat-chat/commit/d9c8c459de2cd4b611423ff8d36c9a24297d8cd1))

## [0.4.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.4.0...v0.4.1) (2026-04-15)


### Bug Fixes

* **qr:** seed npub from storage on QR tab open ([312d500](https://github.com/phantomchat-chat/phantomchat-chat/commit/312d500f422775471d450baae2c5f484bd797ab4))

## [0.4.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.3.0...v0.4.0) (2026-04-15)


### Features

* **ipfs:** cloudflare worker gateway for ipfs.phantomchat.chat ([df9d3ac](https://github.com/phantomchat-chat/phantomchat-chat/commit/df9d3ac02a252477e55bfd9d82a6aeb40fea7768))
* **ipfs:** stable ipfs.phantomchat.chat URL via Cloudflare DNSLink ([3943c45](https://github.com/phantomchat-chat/phantomchat-chat/commit/3943c4546b84f6ef5910a52130bc3488e763294a))
* **ui:** move My QR Code from settings to hamburger menu ([42820e4](https://github.com/phantomchat-chat/phantomchat-chat/commit/42820e44bd9e64c127144051a24505e1871c0a21))


### Bug Fixes

* **mobile:** keep chat topbar visible when virtual keyboard opens ([ebc8198](https://github.com/phantomchat-chat/phantomchat-chat/commit/ebc819811349bc0f5b82bccd2329765d8cd2c0a0))
* **tor-status:** show real relay latency instead of -1ms ([68d0f80](https://github.com/phantomchat-chat/phantomchat-chat/commit/68d0f80293a0115ab21ba6fddffc3dcb9ad5a21d))

## [0.3.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.2.1...v0.3.0) (2026-04-15)


### Features

* QR key exchange (display + scanner + FAB Add Contact) ([#18](https://github.com/phantomchat-chat/phantomchat-chat/issues/18)) ([6acea14](https://github.com/phantomchat-chat/phantomchat-chat/commit/6acea14b0ceda108f2fc26b06a005eea3e588b84))

## [0.2.1](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.2.0...v0.2.1) (2026-04-14)


### Bug Fixes

* **tor-banner:** prevent app bottom overflow when banner is visible ([8d07c22](https://github.com/phantomchat-chat/phantomchat-chat/commit/8d07c22bd8db46d2889c4d1fc4188d730f871cf1))
* **unread:** track P2P unread count per peer and clear on chat open ([ae4cdfb](https://github.com/phantomchat-chat/phantomchat-chat/commit/ae4cdfbe7b48a158ef48379a99df20cb22b06229))

## [0.2.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.1.0...v0.2.0) (2026-04-14)


### Features

* **folders:** default folders (All/Persons/Groups) + Nostr multi-device sync ([#14](https://github.com/phantomchat-chat/phantomchat-chat/issues/14)) ([9a2318d](https://github.com/phantomchat-chat/phantomchat-chat/commit/9a2318d9cadb17e26de3263efcb032f8fe350b20))
* **settings:** add Notifications entry with not-implemented markers ([a05e0a5](https://github.com/phantomchat-chat/phantomchat-chat/commit/a05e0a5a7aa58895dc9d02be860d8b43f398f162))
* **settings:** profile row with avatar and click-to-copy npub ([0475a1b](https://github.com/phantomchat-chat/phantomchat-chat/commit/0475a1b63320ef74b677c88a31f63b61fada84d0))
* **tor:** show real circuit relays and redesign Tor Circuit dashboard ([1c68189](https://github.com/phantomchat-chat/phantomchat-chat/commit/1c68189db43d4612c97bdc59a2387b67770e1bb4))


### Bug Fixes

* **e2e:** stabilize bug-regression test (Tor stall + input races) ([#16](https://github.com/phantomchat-chat/phantomchat-chat/issues/16)) ([6f407a1](https://github.com/phantomchat-chat/phantomchat-chat/commit/6f407a1917d88784b70b0c33f085c0719c8bc4a3))
* **folders:** allow editing protected Persons/Groups folders via context menu ([3f7ecc3](https://github.com/phantomchat-chat/phantomchat-chat/commit/3f7ecc3e3bf75e7b66e3c3c8ba8d1537600bce31))
* **folders:** default tabsInSidebar to true so desktop shows folders on the left ([872f442](https://github.com/phantomchat-chat/phantomchat-chat/commit/872f442a945f4e2f5a8138c414577fcb1f242c58))
* **folders:** drop LANGPACK sentinel, seed default folders with literal titles ([698b7c6](https://github.com/phantomchat-chat/phantomchat-chat/commit/698b7c632232cdbfb4fc2f1e234271e33552c058))
* **profile:** preserve picture/about/website on kind 0 republish ([003ee4d](https://github.com/phantomchat-chat/phantomchat-chat/commit/003ee4d348c3ddb176d3efa7101e5d15b9de83c7))
* **pwa:** set manifest href at HTML parse time so Chrome Android shows Install app ([e889310](https://github.com/phantomchat-chat/phantomchat-chat/commit/e88931068b8032831f9e41923c0736c8c0ee4efc))
* **sidebar:** flatten More submenu into hamburger and fix Report Bug URL ([a4e938d](https://github.com/phantomchat-chat/phantomchat-chat/commit/a4e938d8c24dd6d425e4569c70d4683791fe23fb))
* **ui:** correct relay/Tor status icons and swap in Nostrich logo ([c70e746](https://github.com/phantomchat-chat/phantomchat-chat/commit/c70e746dd3171016894e369d6cae17240d03462e))

## [0.1.0](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.0.2...v0.1.0) (2026-04-13)


### Features

* **p2p:** edit-message protocol primitives + ChatAPI.editMessage ([d61c9fe](https://github.com/phantomchat-chat/phantomchat-chat/commit/d61c9fef1a2ed7f5c2d46388d4101fb4ff25fffe))
* **p2p:** receive-side handling for edit messages ([b931de4](https://github.com/phantomchat-chat/phantomchat-chat/commit/b931de4381813e8b0c673baef84be40389243dbb))
* **p2p:** wire editMessage through Virtual MTProto ([840dd45](https://github.com/phantomchat-chat/phantomchat-chat/commit/840dd45297a12afa1acd447e47d1d02532391709))
* **profile:** cache-first own profile sync with relay refresh ([#12](https://github.com/phantomchat-chat/phantomchat-chat/issues/12)) ([a0cb1f3](https://github.com/phantomchat-chat/phantomchat-chat/commit/a0cb1f372470c4bc57a5407cbefca99843f7bcc0))
* **profile:** drop last_name, add website and lud16 nostr fields ([#11](https://github.com/phantomchat-chat/phantomchat-chat/issues/11)) ([cbe9b37](https://github.com/phantomchat-chat/phantomchat-chat/commit/cbe9b37d58086a7204ecaef4368849cb578a72e0))
* **profile:** sidebar profile row + merged edit tab + blossom avatar upload ([#10](https://github.com/phantomchat-chat/phantomchat-chat/issues/10)) ([2e67aaa](https://github.com/phantomchat-chat/phantomchat-chat/commit/2e67aaa8968ed3430091384309f3976cefe42dfc))
* **security:** dedicated Recovery Phrase tab with styled 12-word grid ([71d98f5](https://github.com/phantomchat-chat/phantomchat-chat/commit/71d98f50e5c0176a36292112dd3535036631f31e))
* **tor:** real Tor WASM runtime with fresh consensus and e2e coverage ([a8b2fb1](https://github.com/phantomchat-chat/phantomchat-chat/commit/a8b2fb1d435adea629e7d2019d6c98ddc9b2ee55))
* **tor:** Tor-first connection flow with consensus cache and startup UI ([619feac](https://github.com/phantomchat-chat/phantomchat-chat/commit/619feace8691720257533251be9df9eeca8e8e55))


### Bug Fixes

* **build:** inject package.json version into VITE_VERSION ([d4b5dce](https://github.com/phantomchat-chat/phantomchat-chat/commit/d4b5dce47c2f75e28d802ee7ab01ef47c634d4f4))
* **p2p:** blue read receipts now render on sender bubbles ([b952e7f](https://github.com/phantomchat-chat/phantomchat-chat/commit/b952e7f5dffcc0e46075ee025f53536db1cd1fe2))
* **p2p:** guard phantomchat-mode crashes and refresh default relay list ([bb24f32](https://github.com/phantomchat-chat/phantomchat-chat/commit/bb24f327745e414637fff3e067287f0926275d69))
* **sidebar:** read version from App.version and link to release notes ([7a56f43](https://github.com/phantomchat-chat/phantomchat-chat/commit/7a56f4332a5fe558ad11172f1aa8729a8ca4350c))
* **tor-ui:** theme popup colors, fix empty relay rows, hydrate circuit dashboard ([31d1fe6](https://github.com/phantomchat-chat/phantomchat-chat/commit/31d1fe6564ef2d6877dc754d57a1d928fecc9878))
* **tor:** reserve layout space for startup banner so it no longer overlaps UI ([b482ae9](https://github.com/phantomchat-chat/phantomchat-chat/commit/b482ae97573ccc8599224f5bf68d6c8d391b9113))
* **ui:** visible mesh icon + clip-free recovery word grid ([3ac9620](https://github.com/phantomchat-chat/phantomchat-chat/commit/3ac9620dd0b43f98cfd93f4bbbc2377b7776cc12))

## [0.0.2](https://github.com/phantomchat-chat/phantomchat-chat/compare/v0.0.1...v0.0.2) (2026-04-12)


### Documentation

* add feature comparison table vs other messengers ([#2](https://github.com/phantomchat-chat/phantomchat-chat/issues/2)) ([c8dd32a](https://github.com/phantomchat-chat/phantomchat-chat/commit/c8dd32a0047ec8c437ee894e0d8c4f14e057bab4))
* remove redundant 'signup without email' row from comparison table ([#4](https://github.com/phantomchat-chat/phantomchat-chat/issues/4)) ([37e7fa3](https://github.com/phantomchat-chat/phantomchat-chat/commit/37e7fa3c23ac335e04e13512f75c0238b747d543))
