# Verifiable upstream snapshot inventory

Third-party author, project and package identifiers in this file are retained
for license compliance. OrbitSuite is the independently branded first-party
application, not an attribution claim over the external works.

The archived source trees now use neutral directory aliases, in table order:

| OrbitSuite archived alias | Corresponding original source |
| --- | --- |
| `third_party/saver-v2` | Save-Restricted-Content-Bot-v2 |
| `third_party/saver-v3` | Save-Restricted-Content-Bot-v3 |
| `third_party/saver-v4` | Save-Restricted-Content-Bot-v4 |
| `third_party/auto-forward-v2` | Auto-Forward-Bot-V2 |
| `third_party/batch-forwarder` | tg-forwarder |
| `third_party/userbot-utilities` | tele-userbot |
| `third_party/transfer-tools` | devgagantools |
| `third_party/rich-message` | richpyro |
| `third_party/aiogram-starter` | AioGram-3.x-Wrapper |
| `third_party/mtproto-client` | pyrogram |
| `third_party/conversation-helper` | pyromod |

Inventory derived directly from the supplied `devgagan-source.tar.gz` Git
checkouts, not an assumed or later remote GitHub state.

| Directory | Archived HEAD | Branch | License evidence in snapshot | Main source features |
| --- | --- | --- | --- | --- |
| `Save-Restricted-Content-Bot-v2` | `2af7122` | `main` | MIT `LICENSE` | media saver, thumbnails/captions, settings, login, YouTube download, plans |
| `Save-Restricted-Content-Bot-v3` | `9c208ed` | `main` | AGPL-3.0 `LICENSE` | batch, login, settings, premium/payment, downloader |
| `Save-Restricted-Content-Bot-v4` | `9761abe` | `main` | no root license | README only, no implementation present |
| `Auto-Forward-Bot-V2` | `0638a56` | `main` | MIT `LICENSE` | forwards, filters, regex/settings, broadcast, captions |
| `tg-forwarder` | `66a6344` | `main` | **no root license** (README claims MIT) | Pyrogram batch copying, progress, retry |
| `tele-userbot` | `d2d738a` | `main` | MIT `LICENSE` | broad personal automation, administration, media |
| `devgagantools` | `131036e` | `main` | MIT `LICENSE` | fast transfer and progress helpers |
| `richpyro` | `e52ed47` | `main` | MIT `LICENSE` | rich Telegram formatting and buttons |
| `AioGram-3.x-Wrapper` | `33424ca` | `main` | MIT `LICENSE` | aiogram starter/handlers |
| `pyrogram` | `4ca25431` | `dev` | LGPL-3-or-later notice with LGPL/GPL copies | Telegram MTProto client fork |
| `pyromod` | `1e4700c` | `master` | GPL-3-or-later notice with LGPL/GPL copies | Pyrogram listener/conversation helpers |

The `Save-Restricted-Content-Bot-v2` archive also contained
`origin/v1` and `origin/v2`. Both were exported to
`third_party/saver-v2-historical/`. The consolidated root
Git history belongs to OrbitSuite; upstream Git object
histories are **not** nested in the new repository. Keep the uploaded
archive if you need the full original histories and branch references.

Python source syntax check: 756 files were parsed against Python 3.12;
one existing parse failure was found in historical v1 `ggn/__main__.py`
at line 28. This snapshot is archival, not a runnable upstream release.

**Distribution warning:** Including a source copy in your private workspace
does not grant a right to publicly redistribute unlicensed material.
If making a public mirror or network-accessible derivative of AGPL code,
review AGPL obligations. GPL/LGPL libraries have distinct redistribution
and linking conditions. Source directory licenses remain intact.
This inventory is a technical review, not legal advice.
