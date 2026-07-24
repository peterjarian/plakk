#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: run-linux-x11.sh <command> [args...]" >&2
  exit 64
fi

desktop_uid="$(id -u)"
desktop_runtime_dir="/run/user/${desktop_uid}"
default_desktop_bus="unix:path=${desktop_runtime_dir}/bus"

if [[ ! -S "${desktop_runtime_dir}/bus" ]]; then
  echo "No local user D-Bus session found at ${desktop_runtime_dir}/bus" >&2
  exit 1
fi

desktop_environment="$(
  env \
    XDG_RUNTIME_DIR="$desktop_runtime_dir" \
    DBUS_SESSION_BUS_ADDRESS="$default_desktop_bus" \
    systemctl --user show-environment
)"

desktop_display=""
desktop_xauthority=""
desktop_bus="$default_desktop_bus"
desktop_current=""
desktop_session=""
desktop_session_name=""
desktop_gnome_session=""

while IFS= read -r environment_line; do
  environment_key="${environment_line%%=*}"
  environment_value="${environment_line#*=}"

  case "$environment_key" in
    DISPLAY)
      desktop_display="$environment_value"
      ;;
    XAUTHORITY)
      desktop_xauthority="$environment_value"
      ;;
    DBUS_SESSION_BUS_ADDRESS)
      desktop_bus="$environment_value"
      ;;
    XDG_CURRENT_DESKTOP)
      desktop_current="$environment_value"
      ;;
    DESKTOP_SESSION)
      desktop_session="$environment_value"
      ;;
    XDG_SESSION_DESKTOP)
      desktop_session_name="$environment_value"
      ;;
    GNOME_DESKTOP_SESSION_ID)
      desktop_gnome_session="$environment_value"
      ;;
  esac
done <<< "$desktop_environment"

if [[ -z "$desktop_display" ]]; then
  echo "The logged-in desktop session did not publish DISPLAY" >&2
  exit 1
fi

if [[ -z "$desktop_xauthority" || ! -r "$desktop_xauthority" ]]; then
  echo "The logged-in desktop session did not publish a readable XAUTHORITY" >&2
  exit 1
fi

desktop_env=(
  "XDG_RUNTIME_DIR=$desktop_runtime_dir"
  "DBUS_SESSION_BUS_ADDRESS=$desktop_bus"
  "DISPLAY=$desktop_display"
  "XAUTHORITY=$desktop_xauthority"
  "XDG_SESSION_TYPE=x11"
  "ELECTRON_OZONE_PLATFORM_HINT=x11"
)

if [[ -n "$desktop_current" ]]; then
  desktop_env+=("XDG_CURRENT_DESKTOP=$desktop_current")
fi

if [[ -n "$desktop_session" ]]; then
  desktop_env+=("DESKTOP_SESSION=$desktop_session")
fi

if [[ -n "$desktop_session_name" ]]; then
  desktop_env+=("XDG_SESSION_DESKTOP=$desktop_session_name")
fi

if [[ -n "$desktop_gnome_session" ]]; then
  desktop_env+=("GNOME_DESKTOP_SESSION_ID=$desktop_gnome_session")
fi

exec env "${desktop_env[@]}" "$@"
