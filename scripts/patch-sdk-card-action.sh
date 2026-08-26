#!/bin/bash
# Patch @larksuiteoapi/node-sdk to handle card.action.trigger events.
#
# The Node.js SDK's WSClient.handleEventData filters out messages where
# type !== 'event', but Feishu card action callbacks arrive with type='card'.
# The Python SDK handles this correctly (MessageType.CARD), but the Node.js
# SDK silently drops them.
#
# This patch changes the filter to also accept 'card' type messages.
# Apply after every npm install.

SDK_FILE="node_modules/@larksuiteoapi/node-sdk/lib/index.js"

if [ ! -f "$SDK_FILE" ]; then
  echo "patch-sdk-card-action: SDK file not found, skipping"
  exit 0
fi

# Check if already patched
if grep -q "type !== MessageType.event && type !== MessageType.card" "$SDK_FILE"; then
  echo "patch-sdk-card-action: already patched"
  exit 0
fi

# Apply the patch
sed -i 's/if (type !== MessageType.event) {/if (type !== MessageType.event \&\& type !== MessageType.card) {/' "$SDK_FILE"

# Verify
if grep -q "type !== MessageType.event && type !== MessageType.card" "$SDK_FILE"; then
  echo "patch-sdk-card-action: patched successfully"
else
  echo "patch-sdk-card-action: patch failed!" >&2
  exit 1
fi
