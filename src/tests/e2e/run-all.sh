#!/usr/bin/env bash
#
# Run all E2E tests in sequence.
#
# Usage:
#   ./src/tests/e2e/run-all.sh                          # headless (CI)
#   E2E_HEADED=1 ./src/tests/e2e/run-all.sh             # visible browser
#   E2E_HEADED=1 E2E_SLOWMO=300 ./src/tests/e2e/run-all.sh  # debug mode
#
# Exit on first failure with --bail, or run all with --no-bail (default: bail)

set -euo pipefail

BAIL=true
for arg in "$@"; do
  case "$arg" in
    --no-bail) BAIL=false ;;
    --bail) BAIL=true ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TESTS=(
  # NOTE: e2e-push-bilateral.ts is intentionally excluded here.
  # It is an online-only test that requires push.nostra.chat to be reachable
  # and a live Nostr relay. Run it separately: `pnpm test:e2e:push`
  # Skip with NOSTRA_PUSH_E2E_OFFLINE=1 when offline.

  # Run dev-boot-smoke first: fastest, cheapest, catches regressions that
  # would silently break every other test's prerequisites (onboarding mount).
  e2e-dev-boot-smoke.ts
  e2e-branding.ts
  e2e-status-ui.ts
  e2e-avatar.ts
  e2e-contacts-and-sending.ts
  e2e-context-menu.ts
  e2e-vmtproto-smoke.ts
  e2e-local-relay-smoke.ts
  e2e-p2p-messaging.ts
  # WU-4 #12: group bilateral send/receive — was orphaned (existed but never
  # in the suite). e2e-groups-ui-attribution.ts stays excluded: its UI-click
  # create-group flow is flaky (GroupAPI-init race) — separate harness fix.
  e2e-groups-bilateral.ts
  e2e-relay-status.ts
  e2e-relay-publish.ts
  e2e-persistence-status.ts
  e2e-delete-persist.ts
  e2e-deletion-and-extras.ts
  e2e-message-requests.ts
  e2e-read-receipts.ts
  e2e-logout.ts
  e2e-reload-test.ts
  e2e-screenshots.ts
  e2e-remaining.ts
  e2e-remaining-bugs.ts
  e2e-bug-regression.ts
  e2e-batch2.ts
  e2e-batch3.ts
  e2e-final-batch.ts
  e2e-cross-browser.ts
  e2e-p2p-full.ts
  e2e-back-and-forth.ts
  e2e-stress-1to1.ts
  e2e-tor-ui.ts
  e2e-tor-wasm.ts
  e2e-tor-privacy-flow.ts
  e2e-bidirectional.ts
  e2e-qr-key-exchange.ts
  e2e-send-image.ts
  e2e-send-voice.ts
  e2e-send-file.ts
  e2e-update-controlled.ts
)

PASSED=0
FAILED=0
FAILED_NAMES=()

echo "=== Running ${#TESTS[@]} E2E tests ==="
echo ""

for test in "${TESTS[@]}"; do
  echo "--- [$((PASSED + FAILED + 1))/${#TESTS[@]}] $test ---"
  if npx tsx "$SCRIPT_DIR/$test"; then
    PASSED=$((PASSED + 1))
    echo "  ✓ PASSED"
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$test")
    echo "  ✗ FAILED"
    if $BAIL; then
      echo ""
      echo "=== BAIL: stopping after first failure ==="
      echo "  Failed: $test"
      echo "  Use --no-bail to run all tests regardless of failures."
      exit 1
    fi
  fi
  echo ""
done

echo "=== Results: $PASSED passed, $FAILED failed out of ${#TESTS[@]} ==="
if [ $FAILED -gt 0 ]; then
  echo "Failed tests:"
  for name in "${FAILED_NAMES[@]}"; do
    echo "  - $name"
  done
  exit 1
fi
