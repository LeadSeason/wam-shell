import { Gtk, Gdk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf?version=2.0"
import Gio from "gi://Gio?version=2.0"
import Pango from "gi://Pango?version=1.0"
import { Accessor, createComputed, createState, onCleanup } from "gnim"
import { rtlAlign, safeMarkup } from "../../lib/utils"
import { relTime, nowSec } from "../../lib/relTime"
import type { RowData } from "./rowData"

// The center's row — a browsing surface, where the banner is a glancing
// one. It can afford what a banner cannot: real artwork, a body worth
// reading, and an age that keeps counting up while you look at it.
//
// What it deliberately does NOT do is draw itself as a card. Every item
// having its own filled rectangle turned the list into banding — twelve
// slabs of identical weight where nothing led and nothing receded. The
// row paints only on hover; separation comes from the hairline between
// rows and from the type, which is what lets a long list stay readable.

/** the wide art slot (youtube thumbnails), in logical pixels */
const ART_W = 168
const ART_H = 94

// Gtk.Picture asks for its texture's natural size wherever the container
// has room — width/height-request raise the minimum and never cap — so
// the texture itself has to be exactly the slot: cover-scale, then
// centre-crop, so a 4:3 thumbnail fills a 16:9 box instead of
// letterboxing inside it
function cropToSlot(scaled: GdkPixbuf.Pixbuf): Gdk.Texture {
    const w = Math.min(ART_W, scaled.get_width())
    const h = Math.min(ART_H, scaled.get_height())
    const x = Math.max(0, Math.floor((scaled.get_width() - w) / 2))
    const y = Math.max(0, Math.floor((scaled.get_height() - h) / 2))
    return Gdk.Texture.new_for_pixbuf(scaled.new_subpixbuf(x, y, w, h))
}

/**
 * Decode a row's artwork OFF the main loop.
 *
 * The decode used to happen inline in the row constructor, which meant
 * opening the centre on a screenful of YouTube items decoded that many
 * JPEGs — scaling each one — before a single frame was painted, as a
 * visible stall on the toggle. The dimensions still come from
 * `get_file_info`, which only reads the header, but the pixels go
 * through the async stream loader and arrive in a state the picture
 * follows.
 *
 * Nothing is drawn until it lands: the art slot's `visible` is driven by
 * the same accessor, so a row without (or before) its texture is simply
 * a row without artwork rather than an empty reserved box.
 */
function loadArt(path: string): Accessor<Gdk.Texture | null> {
    const [texture, setTexture] = createState<Gdk.Texture | null>(null)
    let cancelled = false
    onCleanup(() => {
        cancelled = true
    })
    try {
        const [, srcW, srcH] = GdkPixbuf.Pixbuf.get_file_info(path)
        if (!srcW || !srcH) return texture
        const scale = Math.max(ART_W / srcW, ART_H / srcH)
        const stream = Gio.File.new_for_path(path).read(null)
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            stream,
            Math.ceil(srcW * scale),
            Math.ceil(srcH * scale),
            true,
            null,
            (_s, res) => {
                // the row can be destroyed before the decode lands (a
                // dismissed notification, a re-keyed rebuild)
                if (cancelled) return
                try {
                    const scaled = GdkPixbuf.Pixbuf.new_from_stream_finish(res)
                    if (scaled) setTexture(cropToSlot(scaled))
                } catch {
                    // an unreadable or truncated thumbnail is no artwork,
                    // not a broken row
                }
            },
        )
    } catch {
        // header unreadable: no art
    }
    return texture
}

/**
 * One row in the notification center.
 *
 * @param dismissLabel what the hover button does — "Dismiss" for a
 *        desktop notification, "Mark done" for a provider item, which
 *        are genuinely different promises
 * @param onSecondary right-click: dismissal for a desktop notification,
 *        a session-scoped hide for a provider item
 * @param onMuteApp offered only for DESKTOP notifications. A provider
 *        is muted from the centre's own filter chips, and giving its
 *        rows a second mute would be a second mechanism for one idea —
 *        with two places to look when something has gone quiet.
 */
export default function CenterRow({
    data,
    onActivate,
    onDismiss,
    onSecondary,
    onAction,
    onMuteApp,
    appMuted,
    dismissLabel = "Dismiss",
}: {
    data: RowData
    onActivate: () => void
    onDismiss: () => void
    onSecondary?: () => void
    onAction: (id: string) => void
    onMuteApp?: () => void
    appMuted?: Accessor<boolean>
    dismissLabel?: string
}) {
    const { rtl } = data
    const bodyMarkup = rtl ? rtlAlign(safeMarkup(data.body)) : safeMarkup(data.body)
    // null until the async decode lands (or forever, if there is no art)
    const art = data.imagePath ? loadArt(data.imagePath) : null

    // every box that packs horizontally has to be told: gtk does not
    // push an explicitly set direction down to children that never had
    // one, so setting it on the row alone leaves the icon and the age
    // stranded on the left (see the same note in Toast)
    const mirror = (self: Gtk.Widget) => {
        if (rtl) self.set_direction(Gtk.TextDirection.RTL)
    }

    // the dismiss button appears on hover. Driven by a motion controller
    // rather than CSS :hover — layer-shell surfaces don't get reliable
    // :hover state
    const [hovered, setHovered] = createState(false)
    // ...and on focus, so the strip exists for the keyboard too. One
    // accessor for both: every `visible` below is asking "is this the row
    // being dealt with", and pointer or keyboard is the same answer
    const [focused, setFocused] = createState(false)
    const active = createComputed([hovered, focused], (h, f) => h || f)

    // Delete dismisses. Enter and Space are the button's own activation,
    // which is the entire reason the root below is a button.
    const onKey = (_e: Gtk.EventControllerKey, keyValue: number) => {
        if (keyValue === Gdk.KEY_Delete || keyValue === Gdk.KEY_BackSpace) {
            onDismiss()
            return true
        }
        return false
    }

    return (
        // A BUTTON, not a box, and the reason is keyboard reach: GTK4 will
        // not put a plain box in the focus chain however focusable you
        // mark it (`gtk_widget_set_focusable` alone is not enough —
        // measured: `child_focus(TAB_FORWARD)` returns false for a
        // focusable box and true for a button, mapped or not). The centre
        // could be OPENED from the keyboard and then not read with it:
        // Tab skipped every row in the list.
        //
        // Three hacks left with the box, and that is the tell that this is
        // the right shape rather than a workaround:
        //
        //   - `paintPress` — a button has :active natively. The manual
        //     painting existed only because a box gets none.
        //   - the press hit-test against a `buttons` array — a nested
        //     button claims the click sequence itself, so the row no
        //     longer has to work out whether the press was really meant
        //     for Dismiss.
        //   - activation on release — that is what a button does.
        <button
            $={self => mirror(self)}
            cssClasses={["centerRow", data.urgency, ...(rtl ? ["rtl"] : [])]}
            onClicked={onActivate}
            onNotifyHasFocus={self => setFocused(self.has_focus)}
        >
            <Gtk.EventControllerMotion
                onEnter={() => setHovered(true)}
                onLeave={() => setHovered(false)}
            />
            <Gtk.EventControllerKey onKeyPressed={onKey} />
            {/* the button consumes primary; these two are still ours */}
            <Gtk.GestureClick button={3} onReleased={() => (onSecondary ?? onDismiss)()} />
            <Gtk.GestureClick button={2} onReleased={onDismiss} />

            {/* A button takes ONE child, where the box took as many as
            it was given — so the spine and the content are wrapped
            together here rather than being siblings of the root. */}
            <box $={mirror} hexpand>
                {/* the urgency mark, inset rather than a border on the row
                — as a border it forced the row's corners square and made
                the one urgent item the only differently shaped thing in
                the list. Same reasoning as the banner's spine */}
                {data.urgency === "critical" && <box cssClasses={["spine"]} />}
                <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand>
                    <box spacing={8} $={mirror}>
                        <image
                            cssClasses={["appIcon"]}
                            iconName={data.iconName}
                            pixelSize={16}
                            valign={Gtk.Align.START}
                        />
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={1} hexpand>
                            <box spacing={6} $={mirror}>
                                <label
                                    cssClasses={["appName"]}
                                    label={data.appName || "unknown"}
                                    xalign={0}
                                    maxWidthChars={20}
                                    ellipsize={Pango.EllipsizeMode.END}
                                />
                                <label hexpand />
                                {/* the age and the dismiss button share one slot,
                        so hovering a row cannot shift the list under the
                        pointer */}
                                {/* a muted app still collects rows here —
                            that is the point of muting rather than
                            blocking — so the list has to say which ones
                            will not interrupt again */}
                                {appMuted && (
                                    <image
                                        cssClasses={["mutedMark"]}
                                        iconName="notifications-disabled-symbolic"
                                        pixelSize={12}
                                        visible={appMuted}
                                        tooltipText={`${data.appName} is muted`}
                                    />
                                )}
                                <label
                                    cssClasses={["time"]}
                                    label={nowSec.as(n => relTime(data.time, n))}
                                    visible={active.as(a => !a)}
                                />
                                {/* Beside Dismiss rather than behind a
                            right-click, because both of this row's
                            spare buttons are already spoken for
                            (secondary and middle both dismiss) — and a
                            mute nobody can find is a mute nobody
                            uses. */}
                                {onMuteApp && (
                                    <button
                                        cssClasses={["muteApp"]}
                                        visible={active}
                                        tooltipText={appMuted?.as(m =>
                                            m
                                                ? `Let ${data.appName} interrupt again`
                                                : `Stop ${data.appName} interrupting`,
                                        )}
                                        onClicked={onMuteApp}
                                    >
                                        {/* A click on a button nested inside a button reaches the
                                        OUTER one, not this: measured, both ways round, with a
                                        synthetic click on a plain window — the row activated and
                                        Dismiss never fired, which is how the first attempt at this
                                        shipped an inert ×. Claiming the sequence in the CAPTURE
                                        phase is what stops it: the press is taken before the outer
                                        button's gesture sees it, so this button gets its click and
                                        the row does not activate. Clicking the row BODY still
                                        activates it — also measured. */}
                                        <Gtk.GestureClick
                                            button={1}
                                            propagationPhase={Gtk.PropagationPhase.CAPTURE}
                                            onPressed={(g: Gtk.GestureClick) =>
                                                g.set_state(Gtk.EventSequenceState.CLAIMED)
                                            }
                                        />
                                        <image
                                            iconName={
                                                appMuted?.as(m =>
                                                    m
                                                        ? "preferences-system-notifications-symbolic"
                                                        : "notifications-disabled-symbolic",
                                                ) ?? "notifications-disabled-symbolic"
                                            }
                                        />
                                    </button>
                                )}
                                <button
                                    cssClasses={["dismiss"]}
                                    visible={active}
                                    tooltipText={dismissLabel}
                                    onClicked={onDismiss}
                                >
                                    {/* A click on a button nested inside a button reaches the
                                    OUTER one, not this: measured, both ways round, with a
                                    synthetic click on a plain window — the row activated and
                                    Dismiss never fired, which is how the first attempt at this
                                    shipped an inert ×. Claiming the sequence in the CAPTURE
                                    phase is what stops it: the press is taken before the outer
                                    button's gesture sees it, so this button gets its click and
                                    the row does not activate. Clicking the row BODY still
                                    activates it — also measured. */}
                                    <Gtk.GestureClick
                                        button={1}
                                        propagationPhase={Gtk.PropagationPhase.CAPTURE}
                                        onPressed={(g: Gtk.GestureClick) =>
                                            g.set_state(Gtk.EventSequenceState.CLAIMED)
                                        }
                                    />
                                    <image iconName="window-close-symbolic" />
                                </button>
                            </box>
                            {data.summary !== "" && (
                                <label
                                    cssClasses={["summary"]}
                                    label={data.summary}
                                    xalign={rtl ? 1 : 0}
                                    hexpand
                                    maxWidthChars={38}
                                    wrap
                                    lines={2}
                                    ellipsize={Pango.EllipsizeMode.END}
                                />
                            )}
                            {data.body !== "" && (
                                <label
                                    cssClasses={["body"]}
                                    label={bodyMarkup}
                                    useMarkup
                                    xalign={rtl ? 1 : 0}
                                    hexpand
                                    maxWidthChars={44}
                                    wrap
                                    lines={3}
                                    ellipsize={Pango.EllipsizeMode.END}
                                />
                            )}
                        </box>
                    </box>

                    {/* artwork sits under the text, indented to the text column:
            beside it, a 16:9 thumbnail would either squeeze the words
            into a gutter or set the row's height all by itself */}
                    {art && (
                        <box
                            cssClasses={["art"]}
                            halign={Gtk.Align.START}
                            marginStart={24}
                            overflow={Gtk.Overflow.HIDDEN}
                            // no reserved empty box while the decode is in
                            // flight, and none at all if it fails
                            visible={art.as(t => t !== null)}
                        >
                            <Gtk.Picture
                                paintable={art}
                                contentFit={Gtk.ContentFit.COVER}
                                canShrink
                                widthRequest={ART_W}
                                heightRequest={ART_H}
                            />
                        </box>
                    )}

                    {data.actions.length > 0 && (
                        <box
                            cssClasses={["actions"]}
                            spacing={6}
                            marginStart={24}
                            halign={Gtk.Align.START}
                            $={mirror}
                        >
                            {data.actions.map(a => (
                                <button onClicked={() => onAction(a.id)}>
                                    {/* A click on a button nested inside a button reaches the
                                    OUTER one, not this: measured, both ways round, with a
                                    synthetic click on a plain window — the row activated and
                                    Dismiss never fired, which is how the first attempt at this
                                    shipped an inert ×. Claiming the sequence in the CAPTURE
                                    phase is what stops it: the press is taken before the outer
                                    button's gesture sees it, so this button gets its click and
                                    the row does not activate. Clicking the row BODY still
                                    activates it — also measured. */}
                                    <Gtk.GestureClick
                                        button={1}
                                        propagationPhase={Gtk.PropagationPhase.CAPTURE}
                                        onPressed={(g: Gtk.GestureClick) =>
                                            g.set_state(Gtk.EventSequenceState.CLAIMED)
                                        }
                                    />
                                    <label label={a.label} />
                                </button>
                            ))}
                        </box>
                    )}
                </box>
            </box>
        </button>
    )
}
