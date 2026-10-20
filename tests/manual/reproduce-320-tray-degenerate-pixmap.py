#!/usr/bin/env python3
"""
Reproduce wam-shell#320 locally.

Registers a fake StatusNotifierItem whose IconPixmap has width=0 and
height=0. AstalTray's pixmap_to_pixbuf() passes those dimensions straight to
Gdk.Pixbuf.from_bytes(), which logs:

    (gjs): GdkPixbuf-CRITICAL **: gdk_pixbuf_new_from_bytes:
    assertion 'width > 0' failed

at shell startup. With the AstalTray guard in place, the zero-sized pixmap
is skipped and no critical is emitted.

Run from the repo root on a system with an unpatched AstalTray (the
script isolates itself under a private session bus, so a running shell
is neither disturbed nor mistaken for the repro target):

    python3 tests/manual/reproduce-320-tray-degenerate-pixmap.py

If your system already has the AstalTray patch installed, build an unpatched
AstalTray and point the script at its typelib directory:

    git clone --depth 1 https://github.com/Aylur/astal.git /tmp/astal-upstream
    cd /tmp/astal-upstream/lib/tray
    meson setup build && meson compile -C build
    mkdir -p /tmp/astal-typelib
    g-ir-compiler --shared-library=$(pwd)/build/libastal-tray.so.0.1.0 \
        -o /tmp/astal-typelib/AstalTray-0.1.typelib build/AstalTray-0.1.gir
    python3 tests/manual/reproduce-320-tray-degenerate-pixmap.py \
        --gi-typelib-path /tmp/astal-typelib

Requirements: a running D-Bus session bus, python-dbus, pygobject, ags,
gjs, and dbus-run-session (the dbus package).
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

BUS_NAME = "org.example.DegenerateSNI"
OBJECT_PATH = "/StatusNotifierItem"
WATCHER_NAME = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
WATCHER_IFACE = "org.kde.StatusNotifierWatcher"
PRIVATE_BUS_MARKER = "WAM_320_PRIVATE_BUS"


def ensure_private_bus() -> None:
    """The SNI watcher is a session-wide singleton: against a live
    session the fake item would land in the RUNNING shell's tray while
    this script greps its own (item-less) shell's log — reporting a
    misleading NOT REPRODUCED and disturbing the real bar. Re-exec under
    a private session bus, so the spawned shell owns its own watcher and
    nothing touches the live session."""
    if os.environ.get(PRIVATE_BUS_MARKER) == "1":
        return
    if shutil.which("dbus-run-session") is None:
        raise SystemExit(
            "dbus-run-session not found (the dbus package) — it is required to "
            "isolate this repro from the live session"
        )
    env = dict(os.environ, **{PRIVATE_BUS_MARKER: "1"})
    print("Isolating under a private session bus (dbus-run-session) ...")
    os.execvpe(
        "dbus-run-session",
        ["dbus-run-session", "--", sys.executable, os.path.abspath(__file__), *sys.argv[1:]],
        env,
    )


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
            "Id": "degenerate-sni",
            "Title": "Degenerate SNI",
            "Status": "Active",
            "IconName": "",
            # The trigger: a pixmap that claims zero width and height.
            "IconPixmap": dbus.Array([(0, 0, dbus.ByteArray(b""))], signature="(iiay)"),
            "AttentionIconName": "",
            "AttentionIconPixmap": dbus.Array([], signature="(iiay)"),
            "OverlayIconName": "",
            "OverlayIconPixmap": dbus.Array([], signature="(iiay)"),
            "ToolTip": (
                "",
                dbus.Array([], signature="(iiay)"),
                "Degenerate pixmap",
                "width=0 height=0",
            ),
            "ItemIsMenu": False,
            "Menu": "/NO_MENU",
            "IconThemePath": "",
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
    # never talk to the live session: see ensure_private_bus
    ensure_private_bus()

    parser = argparse.ArgumentParser(description="Reproduce wam-shell#320")
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
    parser.add_argument(
        "--ld-preload",
        metavar="LIB",
        help="Path to a specific libastal-tray.so to preload (useful for testing an unpatched build)",
    )
    parser.add_argument(
        "--gi-typelib-path",
        metavar="DIR",
        help="Directory containing an AstalTray-0.1.typelib to use instead of the system one. "
             "Use this to test against an unpatched AstalTray build on a patched system.",
    )
    args = parser.parse_args()

    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()

    # Own the bus name and expose the SNI object.
    dbus.service.BusName(BUS_NAME, bus)
    StatusNotifierItem(bus, OBJECT_PATH)

    # Start the shell before registering, because AstalTray creates the watcher.
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    log_file = tempfile.NamedTemporaryFile(mode="w", suffix=".log", prefix="wam-shell-320-", delete=False)
    log_path = log_file.name

    env = os.environ.copy()
    env["WAM_SHELL_DIR"] = repo_root
    if args.ld_preload:
        env["LD_PRELOAD"] = args.ld_preload
    if args.gi_typelib_path:
        env["GI_TYPELIB_PATH"] = args.gi_typelib_path

    print(f"Starting shell, logging to {log_path} ...")
    shell_proc = subprocess.Popen(
        ["ags", "run", "app.tsx"],
        cwd=repo_root,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env=env,
    )

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
        print(f"Waiting {args.shell_timeout}s for the critical to appear...")
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

        criticals = re.findall(
            r"GdkPixbuf-CRITICAL.*gdk_pixbuf_new_from_bytes.*width > 0",
            log,
            re.IGNORECASE,
        )

        print()
        if criticals:
            print(f"REPRODUCED: {len(criticals)} GdkPixbuf-CRITICAL(s) found")
            for line in criticals:
                print("  ", line)
            return 1

        print("NOT REPRODUCED: no GdkPixbuf-CRITICAL about zero-width pixmap")
        if "Degenerate SNI" in log:
            print("  (the fake tray item was observed by the shell)")
        return 0

    finally:
        if not args.keep_running:
            if shell_proc.poll() is None:
                shell_proc.kill()
                shell_proc.wait()
            try:
                os.unlink(log_path)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
