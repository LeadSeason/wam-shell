#!/usr/bin/env python3
"""Synthesise a left-button drag through /dev/uinput.

No ydotool/wlrctl on this box and wtype is keyboard-only, so testing a
pointer gesture means creating a virtual relative pointer ourselves.
This is what ydotool does; the device is destroyed on the way out.

usage: drag.py <dx> [steps] [hold_ms]
The caller positions the cursor first (hyprctl), since this device is
relative-only.
"""
import fcntl, struct, sys, time

UINPUT = "/dev/uinput"
UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502
UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT = 0x40045564, 0x40045565, 0x40045566
EV_SYN, EV_KEY, EV_REL = 0, 1, 2
REL_X, REL_Y = 0, 1
BTN_LEFT, SYN_REPORT = 0x110, 0

EVENT = struct.Struct("llHHi")  # timeval(2 longs) + type + code + value


def emit(fd, etype, code, value):
    fd.write(EVENT.pack(0, 0, etype, code, value))
    fd.flush()


def syn(fd):
    emit(fd, EV_SYN, SYN_REPORT, 0)


def main():
    dx = int(sys.argv[1])
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    hold = (int(sys.argv[3]) if len(sys.argv) > 3 else 400) / 1000

    fd = open(UINPUT, "wb", buffering=0)
    for bit in (EV_KEY, EV_REL, EV_SYN):
        fcntl.ioctl(fd, UI_SET_EVBIT, bit)
    fcntl.ioctl(fd, UI_SET_KEYBIT, BTN_LEFT)
    for bit in (REL_X, REL_Y):
        fcntl.ioctl(fd, UI_SET_RELBIT, bit)

    # legacy uinput_user_dev: name[80] + input_id(4xu16) + ff_effects_max
    # + 4 x abs arrays of 64 ints
    dev = struct.pack("80sHHHHi", b"wam-shell-drag-test", 3, 0x1234, 0x5678, 1, 0)
    dev += struct.pack("i" * 256, *([0] * 256))
    fd.write(dev)
    fd.flush()
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(0.35)  # let the compositor pick the device up

    emit(fd, EV_KEY, BTN_LEFT, 1)
    syn(fd)
    time.sleep(0.08)

    per = dx / steps
    carried = 0.0
    for _ in range(steps):
        carried += per
        move = int(carried)
        carried -= move
        if move:
            emit(fd, EV_REL, REL_X, move)
            syn(fd)
        time.sleep(hold / steps)

    emit(fd, EV_KEY, BTN_LEFT, 0)
    syn(fd)
    time.sleep(0.2)

    fcntl.ioctl(fd, UI_DEV_DESTROY)
    fd.close()
    print(f"dragged {dx}px over {steps} steps")


main()
