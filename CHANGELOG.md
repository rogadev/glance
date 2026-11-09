# Changelog

## [0.6.0](https://github.com/rogadev/glance/compare/v0.5.0...v0.6.0) (2026-11-09)

### Features

* change the standby tint to dark purple (#29203B) ([1842ef0](https://github.com/rogadev/glance/commit/1842ef05347bd6a045a87dbf98427b441e9882aa))
* add /glance-color to show and change the working and standby colors ([c93016d](https://github.com/rogadev/glance/commit/c93016dd4e9873b4cca55be3a0a5079a4a2dbe0e))

### Bug Fixes

* show needs you when a turn ends with only a dev server or a plugin's monitor running ([de3aede](https://github.com/rogadev/glance/commit/de3aede7f37d714899de24f21bd8d41ff6fc0608))

## [0.5.0](https://github.com/rogadev/glance/compare/v0.4.0...v0.5.0) (2026-11-09)

### Features

* show a dimmer standby tint for background shells, and drop background work Claude Code no longer lists ([d4c0e4d](https://github.com/rogadev/glance/commit/d4c0e4dcfb61cc2d549acaa31f9aa2720f4952be))

## [0.4.0](https://github.com/rogadev/glance/compare/v0.3.1...v0.4.0) (2026-11-08)

### Features

* update a cloned glance with git pull from /glance-update ([435eb2c](https://github.com/rogadev/glance/commit/435eb2c483dc75f5535b60515d22c1dde96bcddc))

## [0.3.1](https://github.com/rogadev/glance/compare/v0.3.0...v0.3.1) (2026-11-08)

### Bug Fixes

* stop tracking a background shell once TaskStop stops it ([6a474c3](https://github.com/rogadev/glance/commit/6a474c3ca59eac7eb6873dddba3224f876900cd4))

## [0.3.0](https://github.com/rogadev/glance/compare/v0.2.0...v0.3.0) (2026-11-08)


### Features

* /glance-fix explains what held the tint, and /glance-report hands it to Claude to file ([8c0cf50](https://github.com/rogadev/glance/commit/8c0cf50d652462f9086d31334a6f270dc2188fbc))
* add /glance-update, which updates glance with claude plugin update ([837d4ce](https://github.com/rogadev/glance/commit/837d4cebcc749fe125e8ffd2a9fe89c097119e7a))
* add /glance:report-issue, a skill that researches and drafts a glance issue ([b77a587](https://github.com/rogadev/glance/commit/b77a587f29ba01a539e959d91a7d8c41069506a2))
* report-issue skill, /glance-fix diagnosis, narrower Node.js notice ([6602f9c](https://github.com/rogadev/glance/commit/6602f9c4b25a73aa5c725e38c4bf3b40946f457c))
* tell users once a day when a newer glance is out ([22aee2a](https://github.com/rogadev/glance/commit/22aee2a83bc3a854c645158f53e6455121f27767))
* update notice and /glance-update command ([fd7ca0d](https://github.com/rogadev/glance/commit/fd7ca0d15e3c54d0ac1622091b86f05a55490a04))


### Bug Fixes

* check for updates again when the saved check is dated in the future ([2f14b34](https://github.com/rogadev/glance/commit/2f14b340bd232f02d6c2e3891e803948bfbf16d0))
* give the report skill's quote escape for PowerShell as well as bash ([5b740cc](https://github.com/rogadev/glance/commit/5b740cc4ca2ce122061d59baf96000e2a6d443d6))
* hold isWorking reports while /glance-update runs ([6f1074f](https://github.com/rogadev/glance/commit/6f1074fe744e562fb48033fe617ee976a1a3d9d4))
* keep issue titles and search terms out of double quotes in the report skill ([b46b1ec](https://github.com/rogadev/glance/commit/b46b1ece06833aac02533ea9f0e4763ad9f4783d))
* keep outside text off the report skill's command lines instead of escaping it ([b586dea](https://github.com/rogadev/glance/commit/b586dea20b4ac76d7a93ec5c86387bb0903f3260))
* say why a /glance-fix snapshot's log is empty when events.log can't be read ([72ed23c](https://github.com/rogadev/glance/commit/72ed23c94ef994d6ae07e94b3dd02b1e399b1a18))
* show the missing-Node.js notice only when node can't start, not on a slow run ([1859750](https://github.com/rogadev/glance/commit/18597506b22fab0b444c064044d1c473c7691f04)), closes [#11](https://github.com/rogadev/glance/issues/11)
* tell a timed-out /glance-fix or /glance-check apart from a missing Node.js ([9eadbe7](https://github.com/rogadev/glance/commit/9eadbe753806e662f3d8c93a9303926775043f66))

## [0.2.0](https://github.com/rogadev/glance/compare/v0.1.0...v0.2.0) (2026-11-07)


### Features

* add a plugin icon ([791f40f](https://github.com/rogadev/glance/commit/791f40f0297a4735b76845497987221812dfb9d0))


### Bug Fixes

* **ci:** drop the release CI dispatch that failed the Release run ([99b6800](https://github.com/rogadev/glance/commit/99b6800857c004df03419d1e3b7a89dec8c80138))

## 0.1.0 (2026-11-07)


### Features

* add /glance-check, which flashes the tint and reports the detected terminal ([4d729b1](https://github.com/rogadev/glance/commit/4d729b1a914fd6ed71a9d1944aaf993368d753cc))
* first release of glance as an installable plugin ([0739fea](https://github.com/rogadev/glance/commit/0739feab2d361c6aa1a7ae10eeb84b09601c8358))
* package glance as an installable Claude Code plugin with /glance-fix ([811f78f](https://github.com/rogadev/glance/commit/811f78f87f47b3be61af957c0ae8c66698c21165))
* paint macOS and Linux terminals, draw a working band in Claude Desktop, and tint during /compact ([f3878bd](https://github.com/rogadev/glance/commit/f3878bd5bef680d5bf29c86b5ac61df616d1581d))


### Bug Fixes

* clear the tint after a cancelled /compact and tint bash mode, from the engine's isWorking ([0e6b9d8](https://github.com/rogadev/glance/commit/0e6b9d8992e0d692ddd699278f4c99f10b495834))
* name the failed step in /glance-check and send the band its state line ([a8b89c6](https://github.com/rogadev/glance/commit/a8b89c68345cc115ae13ab0ade8a3dc4d3242e0b))
