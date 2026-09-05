#!/bin/bash
set -e
SHA=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes. Commit first."
  exit 1
fi
docker build --platform linux/amd64 -t ghcr.io/imransid/gostyle-booking-api:$SHA .
docker push ghcr.io/imransid/gostyle-booking-api:$SHA
DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/imransid/gostyle-booking-api:$SHA 2>/dev/null | cut -d@ -f2)
if [ -z "$DIGEST" ]; then echo "PUSH DID NOT PRODUCE A DIGEST"; exit 1; fi
echo "digest $DIGEST"
echo ""
echo "VERIFIED ON GHCR: $SHA"
echo "On the server, run:"
echo "  docker pull ghcr.io/imransid/gostyle-booking-api:$SHA"
echo "  docker service update --force --with-registry-auth --image ghcr.io/imransid/gostyle-booking-api:$SHA gostyle-booking_api"
