# Public GitHub development branch: redistribution scope

The complete private OrbitSuite development archive preserves 11 upstream
source snapshots and 2 historical branch snapshots. The public GitHub
`full-development` branch is a **license-screened development mirror**:

- First-party OrbitSuite code, tests, infrastructure and documentation are
  available in full. The `main` branch is the recommended runtime.
- Nine upstream source directories with explicit license evidence are mirrored
  together with their corresponding license, copyright and attribution files.
- `third_party/saver-v4/` is not publicly mirrored: the supplied snapshot
  contained only a README and no explicit redistribution license.
- `third_party/batch-forwarder/` is not publicly mirrored: the supplied
  snapshot has no usable root license file, despite an informal MIT reference
  in its README. Its README also includes a token-shaped literal, which must
  not be replicated into a new public project.
- A separate inventory in `THIRD_PARTY_NOTICES.md` continues to document all
  originally examined sources, including those not publicly mirrored. That
  inventory is **not** a grant of permission to redistribute any missing code.
- Historical third-party directory names, SPDX/copyright information and
  license copies are retained for the included projects. They are distinct
  from first-party OrbitSuite branding and do not imply endorsement.

Before adding excluded source to this public branch, obtain a clear source
license or permission from the respective copyright holder; independently
review it for secrets and legal requirements. Never add real bot tokens,
Telegram sessions, OTPs or credentials to Git history.

The public branch is intentionally not byte-for-byte identical to the
complete local development ZIP. For private comparison work, keep the
original full archive separately; do not paste unlicensed source or token-like
values into issues, documentation or commit messages.
