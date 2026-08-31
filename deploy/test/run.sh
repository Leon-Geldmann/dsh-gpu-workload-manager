#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
"$test_dir/build-bundle.test.sh"
"$test_dir/install-dsh-bundle.test.sh"
"$test_dir/real-dsh-rollback.test.sh"
"$test_dir/build-ubuntu-release.test.sh"
"$test_dir/verify-live.test.sh"
