#!/usr/bin/env python3
"""
Defensive check for malformed tray items related to wam-shell#321.

Registers a fake StatusNotifierItem whose Id property is null and whose
object exports no renderable content. AstalTray can surface such a
registration as a hollow "? (id: null)" item. The tray widget now guards
against missing ids/objects, so this bad registration must not crash bar
construction or prevent modules to the right of "tray" from rendering.

Run from the repo root:

    python3 tests/manual/reproduce-321-tray-null-id.py

The script boots an isolated "wam-shell-test" instance with a temporary
XDG_CONFIG_HOME / XDG_CACHE_HOME, so it will not disturb a running
wam-shell instance. It does require a live Hyprland or sway session.

Requirements: a running D-Bus session bus, python-dbus, pygobject, ags, gjs.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

BUS_NAME = "org.example.NullIdSNI"
OBJECT_PATH = "/StatusNotifierItem"
WATCHER_NAME = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
WATCHER_IFACE = "org.kde.StatusNotifierWatcher"
INSTANCE = "wam-shell-test"


class StatusNotifierItem(dbus.service.Object):
    def __init__(self, bus: dbus.Bus, path: str) -> None:
        super().__init__(bus, path)

    @dbus.service.method(
        dbus_interface="org.freedesktop.DBus.Properties",
        in_signature="s",
        out_signature="a{sv}",
    )
    def GetAll(self, interface: str) -> dict:
        if interface != "org.kde.StatusNotifierItem":
            raise dbus.exceptions.DBusException(
                f"Unknown interface: {interface}", name="org.freedesktop.DBus.Error.InvalidArgs"
            )
        return {
            "Category": "ApplicationStatus",
            # The trigger: a null Id. Some SNI implementations emit this.
            "Id": None,
            "Title": None,
            "Status": "Active",
            "IconName": None,
            "IconPixmap": dbus.Array([], signature="(iiay)"),
            "AttentionIconName": None,
            "AttentionIconPixmap": dbus.Array([], signature="(iiay)"),
            "OverlayIconName": None,
            "OverlayIconPixmap": dbus.Array([], signature="(iiay)"),
            "ToolTip": (None, dbus.Array([], signature="(iiay)"), None, None),
            "ItemIsMenu": False,
            "Menu": "/NO_MENU",
            "IconThemePath": None,
        }

    @dbus.service.method(
        dbus_interface="org.freedesktop.DBus.Properties",
        in_signature="ss",
        out_signature="v",
    )
    def Get(self, interface: str, prop: str):
        return self.GetAll(interface)[prop]


def wait_for_watcher(bus: dbus.Bus, timeout: float = 15.0) -> dbus.ProxyObject:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return bus.get_object(WATCHER_NAME, WATCHER_PATH)
        except dbus.exceptions.DBusException:
            time.sleep(0.2)
    raise RuntimeError(f"{WATCHER_NAME} did not appear within {timeout}s")


def main() -> int:
    parser = argparse.ArgumentParser(description="Reproduce wam-shell#321")
    parser.add_argument(
        "--shell-timeout",
        type=int,
        default=10,
        help="Seconds to let the shell start before checking logs",
    )
    parser.add_argument(
        "--keep-running",
        action="store_true",
        help="Keep the fake SNI and shell running for manual inspection",
    )
    args = parser.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    # Refuse to run if the test instance is already alive — same guard as smoke.sh.
    list_result = subprocess.run(
        ["ags", "list"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    if INSTANCE in list_result.stdout:
        print(f"skip: an instance named {INSTANCE} is already running", file=sys.stderr)
        return 0

    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()

    # Own the bus name and expose the SNI object.
    dbus.service.BusName(BUS_NAME, bus)
    StatusNotifierItem(bus, OBJECT_PATH)

    TMP = tempfile.mkdtemp(prefix="wam-shell-321-")
    log_file = tempfile.NamedTemporaryFile(mode="w", suffix=".log", prefix="wam-shell-321-", delete=False)
    log_path = log_file.name

    os.makedirs(os.path.join(TMP, "config", "wam-shell"), exist_ok=True)
    os.makedirs(os.path.join(TMP, "cache"), exist_ok=True)
    with open(os.path.join(TMP, "config", "wam-shell", "config.toml"), "w") as f:
        f.write(
            f"""instance_name = "{INSTANCE}"

[notifications]
daemon = "system"
popups = false

[osd]
enabled = false

[sleep_timer]
on_panel = true

[tray]
always_on_panel = ["Signal_status_icon_1", "Goofcord", "TelegramDesktop"]

[[panel]]
position = "top"
left = ["osicon", "workspaces", "windowtitle"]
center = ["clock", "harvest"]
right = ["stats", "tray", "sleeptimer", "quicksettings", "language", "notifications"]
"""
        )

    env = os.environ.copy()
    env["WAM_SHELL_DIR"] = repo_root
    env["XDG_CONFIG_HOME"] = os.path.join(TMP, "config")
    env["XDG_CACHE_HOME"] = os.path.join(TMP, "cache")

    print(f"Starting isolated shell ({INSTANCE}), logging to {log_path} ...")
    shell_proc = subprocess.Popen(
        ["ags", "run", "app.tsx"],
        cwd=repo_root,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env=env,
    )

    def cleanup() -> None:
        if shell_proc.poll() is None:
            subprocess.run(["ags", "quit", "-i", INSTANCE], capture_output=True)
            try:
                shell_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                shell_proc.kill()
                shell_proc.wait()
        # Leave the log on disk for inspection; remove the temp config dir.
        import shutil

        shutil.rmtree(TMP, ignore_errors=True)
        print(f"  (log retained at {log_path})")

    try:
        # Wait for AstalTray to create the watcher, then register.
        watcher = wait_for_watcher(bus)
        watcher.RegisterStatusNotifierItem(BUS_NAME, dbus_interface=WATCHER_IFACE)
        print(f"Registered {BUS_NAME} with {WATCHER_NAME}")

        if args.keep_running:
            print("Shell and fake SNI are running. Ctrl+C to stop.")
            GLib.MainLoop().run()
            return 0

        # Let the shell process the new item.
        print(f"Waiting {args.shell_timeout}s for the bar to settle...")
        time.sleep(args.shell_timeout)

        # Collect the log by killing the shell (ags keeps it in memory otherwise).
        shell_proc.terminate()
        try:
            shell_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            shell_proc.kill()
            shell_proc.wait()

        log_file.close()
        with open(log_path, "r", errors="replace") as f:
            log = f.read()

        print()

        # A crash in the tray aborts bar construction, which usually surfaces as
        # a JS ERROR or Gjs-CRITICAL. Look for either.
        js_errors = re.findall(r"(JS ERROR|Gjs-CRITICAL).*", log, re.IGNORECASE)
        tray_crash = [
            line
            for line in js_errors
            if "tray" in line.lower()
            or "getitem_id" in line.lower()
            or "ind" in line.lower()
            or "icon" in line.lower()
        ]

        # Also look for the warning that confirms we ignored the null-id item.
        ignored = "tray: ignoring item with missing id or object" in log

        if tray_crash:
            print(f"REPRODUCED: {len(tray_crash)} tray-related crash line(s)")
            for line in tray_crash[:5]:
                print("  ", line)
            return 1

        if re.search(r"(JS ERROR|Gjs-CRITICAL)", log, re.IGNORECASE):
            print("REPRODUCED: shell logged a JS ERROR / Gjs-CRITICAL")
            for line in js_errors[:5]:
                print("  ", line)
            return 1

        print("NOT REPRODUCED: no crash with the null-id tray item")
        if ignored:
            print("  (the null-id tray item was ignored as expected)")
        else:
            print("  (the null-id tray item was not observed; it may have been filtered earlier)")
        return 0

    finally:
        cleanup()


if __name__ == "__main__":
    sys.exit(main())
