#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete: ${IMAGE_NAME}:${TAG}"

# Offer to stop and remove existing nanoclaw containers so they pick up the new image
CONTAINERS=$(${CONTAINER_RUNTIME} ps -a --filter "name=nanoclaw-" --format "{{.Names}}" 2>/dev/null)
if [ -n "$CONTAINERS" ]; then
  echo ""
  echo "Existing containers:"
  echo "$CONTAINERS" | sed 's/^/  /'
  echo ""
  read -r -p "Stop and remove these containers? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    echo "$CONTAINERS" | xargs ${CONTAINER_RUNTIME} stop 2>/dev/null || true
    echo "$CONTAINERS" | xargs ${CONTAINER_RUNTIME} rm
    echo "Containers removed."
  fi
fi
