# Lifeboat's native core

`Sources/LimitLifeboatCore` and the regression tests are copied without logic changes (one trailing blank line removed),
from Johannes-Berggren/limit-lifeboat at
`6ecf89f417958f6f78dc74ad1780789ec59251f4` (1.1.18), under the MIT license
in UPSTREAM-LICENSE. Keep upstream fixes in sync. This retains the provider's
cross-process OAuth leases, revisioned Keychain snapshots, identity checks,
isolated Codex app-server reads, and transactional restore/rollback.

The FlowLifeboat executable is the JB Flow adapter. Its JSON protocol contains
account metadata and usage only; credential material never crosses host RPC.
It owns a separate store and Keychain service. Import reads the old app's store
and explicitly copies snapshots; it never changes or removes the old store.

Build with `npm run lifeboat:build` on an Apple Silicon Mac with Xcode installed.
The build installs a helper in `~/.local/lib/jb-flow/flow-lifeboat`. The helper
has no UI, Sparkle, launch agent, or dependency on the installed Lifeboat app.
The build prefers a stable Apple Development signing identity. An ad-hoc build
can require new Keychain authorization after each rebuild.
